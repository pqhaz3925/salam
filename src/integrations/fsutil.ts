import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Identity of a file version; used to invalidate the read-once caches below. */
export interface FileStamp {
	mtimeMs: number;
	size: number;
	ino: number;
}

export interface CachedText {
	path: string;
	text: string;
	stamp: FileStamp;
	/** True when the file was longer than the requested byte budget. */
	truncated: boolean;
}

const textCache = new Map<string, CachedText>();

function sameStamp(a: FileStamp, b: FileStamp): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

export async function statFile(path: string): Promise<FileStamp | null> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return null;
		return { mtimeMs: info.mtimeMs, size: info.size, ino: Number(info.ino) };
	} catch {
		return null;
	}
}

export async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Reads at most `maxBytes` of a file and caches the result keyed by path and budget.
 * A cached entry is reused only while mtime, size and inode all match, so an edited
 * file is re-read on the next call without the caller tracking anything.
 */
export async function readTextCached(path: string, maxBytes: number): Promise<CachedText | null> {
	const key = `${maxBytes}\u0000${path}`;
	const stamp = await statFile(path);
	if (!stamp) {
		textCache.delete(key);
		return null;
	}
	const hit = textCache.get(key);
	if (hit && sameStamp(hit.stamp, stamp)) return hit;

	let handle;
	try {
		handle = await open(path, "r");
	} catch {
		textCache.delete(key);
		return null;
	}
	try {
		const budget = Math.min(maxBytes, Math.max(stamp.size, 0));
		const buffer = Buffer.allocUnsafe(budget);
		let filled = 0;
		while (filled < budget) {
			const { bytesRead } = await handle.read(buffer, filled, budget - filled, filled);
			if (bytesRead <= 0) break;
			filled += bytesRead;
		}
		const entry: CachedText = {
			path,
			text: buffer.subarray(0, filled).toString("utf8"),
			stamp,
			truncated: stamp.size > budget,
		};
		textCache.set(key, entry);
		return entry;
	} catch {
		textCache.delete(key);
		return null;
	} finally {
		await handle.close().catch(() => {});
	}
}

export interface DirEntry {
	name: string;
	path: string;
	directory: boolean;
	symlink: boolean;
}

export async function listDirectory(path: string): Promise<DirEntry[]> {
	let entries;
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: DirEntry[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") && entry.name !== ".claude" && entry.name !== ".salam") continue;
		const full = join(path, entry.name);
		let directory = entry.isDirectory();
		let file = entry.isFile();
		const symlink = entry.isSymbolicLink();
		if (symlink) {
			try {
				const target = await stat(full);
				directory = target.isDirectory();
				file = target.isFile();
			} catch {
				continue;
			}
		}
		if (!directory && !file) continue;
		out.push({ name: entry.name, path: full, directory, symlink });
	}
	out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return out;
}

/** Resolves symlinks when possible; falls back to the lexical path for missing files. */
export async function realpathOr(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

export function withinRoot(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	const prefix = root.endsWith(sep) ? root : root + sep;
	return candidate.startsWith(prefix);
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function resolveFrom(baseDir: string, path: string): string {
	const expanded = expandHome(path);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

/** Path shown to the model: home-relative or cwd-relative when that is shorter. */
export function displayPath(path: string, cwd: string): string {
	const home = homedir();
	if (withinRoot(path, cwd)) {
		const rel = path.slice(cwd.length).replace(/^[/\\]/, "");
		if (rel.length > 0) return rel;
	}
	if (withinRoot(path, home)) return "~" + path.slice(home.length);
	return path;
}

export interface Frontmatter {
	fields: Map<string, string>;
	bodyOffset: number;
	present: boolean;
}

/**
 * Minimal YAML frontmatter reader: flat `key: value` pairs, which is the whole of
 * the SKILL.md contract. Nested structures are ignored rather than half-parsed.
 */
export function parseFrontmatter(head: string): Frontmatter {
	const fields = new Map<string, string>();
	const normalized = head.startsWith("\uFEFF") ? head.slice(1) : head;
	const opener = /^---[ \t]*\r?\n/.exec(normalized);
	if (!opener) return { fields, bodyOffset: 0, present: false };
	const bodyStart = opener[0].length;
	const closer = /\r?\n---[ \t]*(\r?\n|$)/.exec(normalized.slice(bodyStart));
	if (!closer) return { fields, bodyOffset: 0, present: false };
	const block = normalized.slice(bodyStart, bodyStart + closer.index);
	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (line.length === 0 || line.trimStart().startsWith("#")) continue;
		if (/^\s/.test(rawLine)) continue; // nested block: not part of the flat contract
		const split = line.indexOf(":");
		if (split <= 0) continue;
		const key = line.slice(0, split).trim().toLowerCase();
		let value = line.slice(split + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
			(value.startsWith("'") && value.endsWith("'") && value.length > 1)
		) {
			value = value.slice(1, -1);
		}
		if (key.length > 0) fields.set(key, value);
	}
	const offset = bodyStart + closer.index + closer[0].length;
	return { fields, bodyOffset: offset + (head.length - normalized.length), present: true };
}

export function firstParagraph(body: string, limit = 240): string {
	for (const block of body.split(/\r?\n\s*\r?\n/)) {
		const cleaned = block
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---"))
			.join(" ")
			.trim();
		if (cleaned.length > 0) return cleaned.length > limit ? cleaned.slice(0, limit - 1) + "…" : cleaned;
	}
	return "";
}
