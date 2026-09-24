/**
 * Manual inspection and removal of atomic-write recovery entries.
 *
 * Writes keep the displaced inode of every file they replace (another editor may
 * still hold it open), and nothing prunes them automatically. This is the
 * explicit, user-invoked cleanup: it lists entries and removes only the ones the
 * user selects, skipping any that a running process still has open.
 */
import { lstat, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RECOVERY_CAPACITY, repositoryDirectory } from "./atomic-io.ts";

/** Writes are refused once a root holds this many entries. */
export const RECOVERY_LIMIT = RECOVERY_CAPACITY;

export interface RecoveryEntry {
	/** Absolute path of the `entry-N` directory. */
	directory: string;
	root: string;
	/** The file the operation changed, from the manifest. */
	path?: string;
	operation?: string;
	createdAt?: number;
	bytes: number;
}

/** Recovery roots a write under `cwd` could have used, that exist now. */
export async function recoveryRoots(cwd: string): Promise<string[]> {
	const uid = process.getuid?.() ?? 0;
	const home = await realpath(homedir());
	const cache =
		process.env.XDG_CACHE_HOME || join(home, process.platform === "darwin" ? "Library/Caches" : ".cache");
	const candidates = [join(cache, "salam", "recovery")];
	let current = await realpath(cwd);
	const device = (await lstat(current)).dev;
	let mount = current;
	for (;;) {
		try {
			const marker = await lstat(join(current, ".git"));
			const git = await repositoryDirectory(current, marker.isDirectory());
			if (git) candidates.push(join(git, `salam-recovery-${uid}`));
		} catch {
			/* No repository here. */
		}
		const above = dirname(current);
		if (above === current || (await lstat(above)).dev !== device) break;
		current = mount = above;
	}
	candidates.push(join(mount, `.salam-recovery-${uid}`));
	const roots: string[] = [];
	for (const root of new Set(candidates)) {
		try {
			const info = await lstat(root);
			if (info.isDirectory() && !info.isSymbolicLink()) roots.push(root);
		} catch {
			/* Not created yet. */
		}
	}
	return roots;
}

async function size(path: string): Promise<number> {
	const info = await lstat(path);
	if (!info.isDirectory()) return info.size;
	let total = 0;
	for (const name of await readdir(path)) total += await size(join(path, name));
	return total;
}

export async function listRecovery(roots: string[]): Promise<RecoveryEntry[]> {
	const entries: RecoveryEntry[] = [];
	for (const root of roots) {
		for (const name of await readdir(root)) {
			if (!/^entry-\d+$/.test(name)) continue;
			const directory = join(root, name);
			const entry: RecoveryEntry = { directory, root, bytes: 0 };
			try {
				const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
				if (typeof manifest.path === "string") entry.path = manifest.path;
				if (typeof manifest.operation === "string") entry.operation = manifest.operation;
				const created = Date.parse(manifest.createdAt);
				if (Number.isFinite(created)) entry.createdAt = created;
			} catch {
				/* Unreadable manifest: fall back to the directory's own time. */
			}
			try {
				entry.createdAt ??= (await stat(directory)).mtimeMs;
				entry.bytes = await size(directory);
			} catch {
				continue;
			}
			entries.push(entry);
		}
	}
	return entries.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/**
 * Entry directories any process has a file open in, via `lsof`. Undefined when
 * that cannot be determined, in which case nothing may be removed without force.
 */
export async function heldEntries(roots: string[]): Promise<Set<string> | undefined> {
	if (!roots.length) return new Set();
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(["lsof", "-F", "n", ...roots.flatMap((root) => ["+D", root])], {
			stdout: "pipe",
			stderr: "ignore",
		});
	} catch {
		return undefined;
	}
	const text = await new Response(child.stdout as ReadableStream).text();
	const code = await child.exited;
	// lsof exits 1 when nothing is open (and for some errors, which then look like "nothing held").
	if (code !== 0 && code !== 1) return undefined;
	const held = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line.startsWith("n")) continue;
		const path = line.slice(1);
		for (const root of roots) {
			const match = path.startsWith(`${root}/`) && /^entry-\d+/.exec(path.slice(root.length + 1));
			if (match) held.add(join(root, match[0]));
		}
	}
	return held;
}

export function parseAge(text: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)?$/.exec(text.trim());
	if (!match) throw new Error(`Invalid age ${JSON.stringify(text)}: use e.g. 30m, 12h, 14d or 2w.`);
	const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] ?? "d"]!;
	return Number(match[1]) * unit;
}

export interface PruneResult {
	removed: RecoveryEntry[];
	held: RecoveryEntry[];
	failed: { entry: RecoveryEntry; error: string }[];
}

/** Remove the selected entries, except any a process still holds open (unless `force`). */
export async function pruneRecovery(
	entries: RecoveryEntry[],
	held: Set<string> | undefined,
	force = false,
): Promise<PruneResult> {
	if (!held && !force)
		throw new Error(
			"Cannot tell whether a process still holds these files open (lsof is unavailable or failed); nothing was removed. Close editors and rerun with --force.",
		);
	const result: PruneResult = { removed: [], held: [], failed: [] };
	for (const entry of entries) {
		if (!force && held?.has(entry.directory)) {
			result.held.push(entry);
			continue;
		}
		try {
			await rm(entry.directory, { recursive: true, force: true });
			result.removed.push(entry);
		} catch (error) {
			result.failed.push({ entry, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}
