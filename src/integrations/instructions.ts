import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SalamConfig } from "../contracts.ts";
import type { FileStamp } from "./fsutil.ts";
import {
	displayPath,
	isDirectory,
	readTextCached,
	realpathOr,
	resolveFrom,
	statFile,
	withinRoot,
} from "./fsutil.ts";
import type { McpHub } from "./mcp.ts";

const FILE_NAMES = ["CLAUDE.md", "CLAUDE.local.md"];
const MAX_WALK = 24;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_IMPORT_DEPTH = 5;
const MAX_IMPORTS = 32;
const IMPORT_LINE = /^[ \t]{0,3}@([^\s@][^\s]*)[ \t]*$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;

export type InstructionScope = "user" | "project" | "directory";

interface Composed {
	text: string;
	deps: { path: string; stamp: FileStamp }[];
}

interface InstructionChain {
	/** Directories from the project root down to the working directory. */
	chain: string[];
	/** True when the walk stopped at a repository root or the home directory. */
	rooted: boolean;
}

/**
 * Builds the CLAUDE.md instruction chain for a working directory: user-level files,
 * then project root down to the directory itself. Only ancestors of `cwd` are ever
 * visited, so this never walks a repository, and `@relative` imports are expanded
 * under explicit scope, depth and cycle bounds with provenance kept inline.
 */
export class InstructionLoader {
	private readonly composed = new Map<string, Composed>();
	/** Import root and scope of the configured working directory; see `load`. */
	private anchor: Promise<{ boundary: string; root: string }> | null = null;

	constructor(
		private readonly config: SalamConfig,
		private readonly hub: McpHub,
		private readonly home: string = homedir(),
	) {}

	async load(cwd: string): Promise<string[]> {
		const home = this.home;
		const current = await this.locate(cwd);
		const chain = current.chain;
		const boundary = current.boundary;
		const userDirs = [resolve(this.config.home), join(home, ".claude"), join(home, ".salam")];
		// Real paths cover symlinked user directories.
		const userScope = [
			...new Set([...userDirs, ...(await Promise.all(userDirs.map((dir) => realpathOr(dir))))]),
		];
		const scope = [current.root, ...userScope];
		// User instructions are composed and labelled against the configured working
		// directory rather than the current one, so an unchanged user file renders the same
		// string from any directory — including the string an already-running session
		// loaded at startup — while its imports keep that project's scope.
		this.anchor ??= this.locate(this.config.cwd);
		const anchor = await this.anchor;
		const anchorScope = [anchor.root, ...userScope];

		const planned: { path: string; scope: InstructionScope }[] = [];
		for (const directory of userDirs) {
			for (const name of FILE_NAMES) planned.push({ path: join(directory, name), scope: "user" });
		}
		for (const [index, directory] of chain.entries()) {
			const kind: InstructionScope = index === 0 ? "project" : "directory";
			for (const name of FILE_NAMES) planned.push({ path: join(directory, name), scope: kind });
		}

		const out: string[] = [];
		const emitted = new Set<string>();
		for (const item of planned) {
			const stamp = await statFile(item.path);
			if (!stamp) continue;
			const real = await realpathOr(item.path);
			if (emitted.has(real)) continue;
			emitted.add(real);
			const user = item.scope === "user";
			const labelRoot = user ? anchor.boundary : boundary;
			const composed = await this.compose(item.path, user ? anchorScope : scope, labelRoot);
			if (!composed || composed.text.trim().length === 0) continue;
			out.push(
				`<instructions source="${displayPath(item.path, labelRoot)}" scope="${item.scope}">\n${composed.text.trim()}\n</instructions>`,
			);
		}

		for (const entry of this.hub.serverInstructions()) {
			out.push(
				`<instructions source="mcp:${entry.server}" scope="mcp-server">\n${entry.text}\n</instructions>`,
			);
		}
		return out;
	}

	/** Directory chain of `cwd`, its label boundary and its project import root. */
	private async locate(cwd: string): Promise<{ chain: string[]; boundary: string; root: string }> {
		const base = await realpathOr(resolve(cwd));
		const walk = await this.directoryChain(base, await realpathOr(this.home));
		const boundary = walk.chain[0] ?? base;
		// Without a repository root the chain reaches the filesystem root, which is far too
		// wide a scope for imports; fall back to the working directory itself.
		return { chain: walk.chain, boundary, root: walk.rooted ? boundary : base };
	}

	/** Ancestors of `cwd` up to the repository root (or home / filesystem root), root first. */
	private async directoryChain(base: string, home: string): Promise<InstructionChain> {
		const chain: string[] = [];
		let current = base;
		for (let depth = 0; depth < MAX_WALK; depth += 1) {
			chain.unshift(current);
			if (await this.isRepositoryRoot(current)) return { chain, rooted: true };
			if (current === home) return { chain, rooted: true };
			const parent = resolve(current, "..");
			if (parent === current) break;
			current = parent;
		}
		return { chain, rooted: false };
	}

	private async isRepositoryRoot(directory: string): Promise<boolean> {
		const marker = join(directory, ".git");
		// A worktree's `.git` is a file, a normal checkout's is a directory.
		return (await isDirectory(marker)) || (await statFile(marker)) !== null;
	}

	private async compose(path: string, scope: string[], root: string): Promise<Composed | null> {
		const key = `${root}\u0000${scope.join("\u0000")}\u0000${path}`;
		const cached = this.composed.get(key);
		if (cached) {
			let valid = true;
			for (const dep of cached.deps) {
				const stamp = await statFile(dep.path);
				if (
					!stamp ||
					stamp.mtimeMs !== dep.stamp.mtimeMs ||
					stamp.size !== dep.stamp.size ||
					stamp.ino !== dep.stamp.ino
				) {
					valid = false;
					break;
				}
			}
			if (valid) return cached;
		}
		const deps: { path: string; stamp: FileStamp }[] = [];
		const visited = new Set<string>();
		const budget = { remaining: MAX_IMPORTS };
		const text = await this.expand(path, scope, root, 0, visited, deps, budget);
		if (text === null) return null;
		const result: Composed = { text, deps };
		this.composed.set(key, result);
		return result;
	}

	private async expand(
		path: string,
		scope: string[],
		root: string,
		depth: number,
		visited: Set<string>,
		deps: { path: string; stamp: FileStamp }[],
		budget: { remaining: number },
	): Promise<string | null> {
		const real = await realpathOr(path);
		if (visited.has(real)) return null;
		visited.add(real);
		const cached = await readTextCached(path, MAX_FILE_BYTES);
		if (!cached) return null;
		deps.push({ path, stamp: cached.stamp });

		const directory = dirname(path);
		const lines = cached.text.split(/\r?\n/);
		const out: string[] = [];
		let fenced = false;
		for (const line of lines) {
			if (FENCE.test(line)) fenced = !fenced;
			const match = fenced ? null : IMPORT_LINE.exec(line);
			if (!match?.[1]) {
				out.push(line);
				continue;
			}
			const request = match[1];
			const target = resolveFrom(directory, request);
			if (depth + 1 > MAX_IMPORT_DEPTH) {
				out.push(`<!-- @${request} not expanded: import depth limit ${MAX_IMPORT_DEPTH} reached -->`);
				continue;
			}
			if (budget.remaining <= 0) {
				out.push(`<!-- @${request} not expanded: import limit ${MAX_IMPORTS} reached -->`);
				continue;
			}
			const targetReal = await realpathOr(target);
			if (!scope.some((root) => withinRoot(targetReal, root))) {
				out.push(`<!-- @${request} not expanded: outside the instruction scope -->`);
				continue;
			}
			if (visited.has(targetReal)) {
				out.push(`<!-- @${request} not expanded: already imported -->`);
				continue;
			}
			budget.remaining -= 1;
			const imported = await this.expand(target, scope, root, depth + 1, visited, deps, budget);
			if (imported === null) {
				out.push(`<!-- @${request} not expanded: unreadable -->`);
				continue;
			}
			const source = displayPath(target, root);
			out.push(`<!-- imported from ${source} -->`);
			out.push(imported.trim());
			out.push(`<!-- end ${source} -->`);
		}
		const body = out.join("\n");
		return cached.truncated ? `${body}\n<!-- truncated at ${MAX_FILE_BYTES} bytes -->` : body;
	}
}
