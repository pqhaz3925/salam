import { posix } from "node:path";
import type { ToolContext } from "../contracts.ts";
import type { ExternalChange, ExternalState } from "./fs.ts";
import { looksBinary, unifiedDiff } from "./text.ts";
import { sha256Hex } from "./util.ts";
import { displayPath, type ToolEnvironment, type Workspace } from "./workspace.ts";

/** How many of the agent's most recently observed paths a shell command is checked against. */
const TRACKED_PATHS = 32;
/** Path-like words taken from one command line. */
const COMMAND_PATHS = 16;
/** Larger files are reported as changed without a diff. */
const TEXT_LIMIT = 1024 * 1024;
const CACHE_ENTRIES = 256;

type State =
	| { kind: "missing" }
	| {
			kind: "file";
			mtimeMs: number;
			size: number;
			mode?: number;
			symlink?: boolean;
			bytes?: Uint8Array;
			text?: string;
	  }
	| { kind: "other" };

/**
 * States before a command; for the bare shell also the paths its command line names, and
 * which of those changed on disk since this agent's last command that touched them.
 */
export type Baseline = Map<string, State> & { named?: string[]; stale?: string[] };

export interface SeenChange {
	path: string;
	shown: string;
	/** Unified diff; empty when the content could not be compared (binary or too large). */
	diff: string;
	note?: string;
	/** Freshness to record if the model is shown this change in full; absent when the content is unknown. */
	after?: { hash: string; size: number };
	/** Text after the command, and before it unless the file is new, for the syntax check. */
	text?: { before?: string; after: string };
	/** Both sides in full, for the checkpoint; absent when either side's bytes are unknown. */
	record?: ExternalChange;
}

/**
 * Notices what a shell command did to files the agent has already seen. Native
 * edits report their own diff; a `sed -i` or `python -c` rewrite otherwise
 * lands silently, so the model believes the file still holds what it last read.
 *
 * Compared paths are the agent's freshness record plus, for the bare shell of a
 * restricted tool set (where files are read with `cat`, not `read`), paths named
 * in its commands: `cat a.py`, `sed -i … b.ts`, `cat > new.py`, `Path('c.py')`.
 * A named path that does not exist yet is tracked too, so a file the command
 * creates is reported. Files never named or read are not tracked. Changes whose bytes are known on both sides
 * carry a `record` the shell reports to the checkpoint, making them rewindable.
 */
export class SeenFileChanges {
	/** Paths named in earlier bare-shell commands, per agent and workspace, most recent last. */
	private readonly named = new Map<string, string[]>();
	/** Each path's state when this agent's commands last named or changed it, per agent. */
	private readonly lastSeen = new Map<string, State>();
	/** Last content read per workspace path, reused while its mtime and size are unchanged. */
	private readonly cache = new Map<string, Extract<State, { kind: "file" }>>();

	constructor(private readonly environment: ToolEnvironment) {}

	/** `command` and `cwd` are given for the bare shell, whose named paths count as seen. */
	async before(
		context: ToolContext,
		workspace: Workspace,
		command?: { text: string; cwd: string },
	): Promise<Baseline> {
		const key = namedKey(context, workspace);
		const named = command
			? await this.commandPaths(workspace, command, workspace.base(context.cwd), context.signal)
			: [];
		const paths = [
			...new Set([
				...this.environment.freshness.recent(context, workspace.id, TRACKED_PATHS),
				...(this.named.get(key) ?? []).slice(-TRACKED_PATHS),
				...named,
			]),
		];
		const states = await Promise.all(paths.map((path) => this.state(workspace, path, context.signal)));
		const baseline: Baseline = new Map();
		paths.forEach((path, index) => {
			const state = states[index];
			if (state) baseline.set(path, state);
		});
		if (command) {
			this.remember(
				key,
				paths.filter((path) => baseline.get(path)?.kind === "file"),
			);
			baseline.named = named;
			baseline.stale = named.filter((path) => {
				const now = baseline.get(path);
				const last = this.lastSeen.get(`${key}\u0000${path}`);
				if (!now) return false;
				if (!last) {
					this.lastSeen.set(`${key}\u0000${path}`, now);
					return false;
				}
				if (unchanged(last, now)) return false;
				// A change the agent made itself through a native tool is not news to it.
				const hash =
					now.kind === "missing" ? "missing" : now.kind === "file" && now.bytes ? sha256Hex(now.bytes) : "";
				return this.environment.freshness.get(context, workspace.id, path)?.hash !== hash;
			});
		}
		return baseline;
	}

	private remember(key: string, paths: string[]): void {
		const list = (this.named.get(key) ?? []).filter((path) => !paths.includes(path));
		list.push(...paths);
		this.named.set(key, list.slice(-TRACKED_PATHS * 2));
	}

	/** Existing files, or missing paths whose directory exists, named by path-like words of a command. */
	/** Only paths inside the project `root` count: `/tmp` scratch copies are not the agent's work. */
	private async commandPaths(
		workspace: Workspace,
		command: { text: string; cwd: string },
		root: string,
		signal: AbortSignal,
	): Promise<string[]> {
		const words = [
			...new Set(
				command.text
					.split(/[\s;|&<>()`'"=,[\]{}]+/)
					.filter(
						(word) =>
							!word.startsWith("-") &&
							!word.includes("://") &&
							!word.includes("$") &&
							!word.includes("*") &&
							(word.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(word)) &&
							/^[\w./~@+-]+$/.test(word),
					),
			),
		].slice(0, COMMAND_PATHS);
		const found = await Promise.all(
			words.map(async (word) => {
				try {
					const path = workspace.resolvePath(command.cwd, word);
					if (!path.startsWith(`${root.replace(/\/$/, "")}/`)) return undefined;
					const stat = await workspace.fs.stat(path, { hash: false, signal });
					if (stat.kind === "file") return path;
					if (stat.kind !== "missing") return undefined;
					const parent = await workspace.fs.stat(dirname(path), { hash: false, signal });
					return parent.kind === "dir" ? path : undefined;
				} catch {
					return undefined;
				}
			}),
		);
		return found.filter((path): path is string => path !== undefined);
	}

	async after(
		context: ToolContext,
		workspace: Workspace,
		baseline: Baseline,
		bare = false,
	): Promise<SeenChange[]> {
		const paths = [...baseline.keys()];
		// Checked even after an interrupt: whatever the command wrote before it died is still on disk.
		const signal = new AbortController().signal;
		const states = await Promise.all(paths.map((path) => this.state(workspace, path, signal)));
		const base = workspace.base(context.cwd);
		const changes: SeenChange[] = [];
		paths.forEach((path, index) => {
			const before = baseline.get(path)!;
			const after = states[index];
			if (!after || unchanged(before, after)) return;
			const shown = displayPath(base, path);
			const known: Pick<SeenChange, "after" | "record"> =
				after.kind === "missing"
					? { after: { hash: "missing", size: 0 } }
					: after.kind === "file" && after.bytes
						? { after: { hash: sha256Hex(after.bytes), size: after.size } }
						: {};
			const beforeState = external(before);
			const afterState = external(after);
			if (beforeState && afterState) known.record = { path, before: beforeState, after: afterState };
			const oldText = before.kind === "missing" ? "" : before.kind === "file" ? before.text : undefined;
			const newText = after.kind === "missing" ? "" : after.kind === "file" ? after.text : undefined;
			if (oldText !== undefined && newText !== undefined) {
				if (oldText === newText) return;
				const diff = unifiedDiff(oldText, newText, shown);
				changes.push({
					path,
					shown,
					diff,
					...(after.kind === "file"
						? { text: { before: before.kind === "file" ? oldText : undefined, after: newText } }
						: {}),
					...(after.kind === "missing"
						? { note: "deleted" }
						: before.kind === "missing"
							? { note: `created, ${lineCount(newText)}` }
							: {}),
					...known,
				});
				return;
			}
			changes.push({
				path,
				shown,
				diff: "",
				note: after.kind === "missing" ? "deleted" : "changed (binary or larger than 1 MiB, no diff)",
				...known,
			});
		});
		// Paths the command named, and whatever it was told changed, are now what the agent last saw.
		if (bare) {
			const key = namedKey(context, workspace);
			const reported = new Set(changes.map((change) => change.path));
			paths.forEach((path, index) => {
				const state = states[index];
				if (state && (baseline.named?.includes(path) || reported.has(path)))
					this.lastSeen.set(`${key}\u0000${path}`, state);
			});
		}
		// A file the command created is now one the agent knows about.
		if (bare)
			this.remember(
				namedKey(context, workspace),
				changes.filter((change) => change.note?.startsWith("created")).map((change) => change.path),
			);
		return changes;
	}

	private async state(workspace: Workspace, path: string, signal: AbortSignal): Promise<State | undefined> {
		try {
			const stat = await workspace.fs.stat(path, { hash: false, signal });
			if (stat.kind === "missing") return { kind: "missing" };
			if (stat.kind !== "file") return { kind: "other" };
			const key = `${workspace.id}\u0000${path}`;
			const cached = this.cache.get(key);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
			const state: Extract<State, { kind: "file" }> = {
				kind: "file",
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				mode: stat.mode,
				...(stat.symlink ? { symlink: true } : {}),
			};
			if (stat.size <= TEXT_LIMIT) {
				const read = await workspace.fs.readBytes(path, TEXT_LIMIT + 1, signal);
				// Size and mtime are what the cache trusts; a file that changed mid-read is left uncached.
				if (!read.truncated && read.bytes.length === stat.size) {
					state.bytes = read.bytes;
					if (!looksBinary(read.bytes)) state.text = new TextDecoder().decode(read.bytes);
				} else return state;
			}
			this.cache.delete(key);
			this.cache.set(key, state);
			if (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
			return state;
		} catch {
			// An unreadable path is simply not reported; the command's own output still stands.
			return undefined;
		}
	}
}

function unchanged(before: State, after: State): boolean {
	if (before.kind !== after.kind) return false;
	if (before.kind !== "file" || after.kind !== "file") return true;
	return before.mtimeMs === after.mtimeMs && before.size === after.size;
}

/** The checkpoint's view of a state, when it can be put back exactly; a symlink cannot. */
function external(state: State): ExternalState | undefined {
	if (state.kind === "missing") return state;
	if (state.kind !== "file" || !state.bytes || state.symlink) return undefined;
	return { kind: "file", bytes: state.bytes, mode: state.mode };
}

function namedKey(context: ToolContext, workspace: Workspace): string {
	return `${context.sessionId}\u0000${context.agentId}\u0000${workspace.id}`;
}

const dirname = posix.dirname;

function lineCount(text: string): string {
	const count = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	return `${count} line${count === 1 ? "" : "s"}`;
}
