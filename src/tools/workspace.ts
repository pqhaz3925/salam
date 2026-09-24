import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Arguments, HarnessTool, SalamConfig, ToolContext, ToolOutput } from "../contracts.ts";
import { ArtifactStore } from "./artifacts.ts";
import { type Executor, LocalExecutor } from "./exec.ts";
import { LocalFs, RemoteFs, type WorkspaceFs } from "./fs.ts";
import { ProcessRegistry } from "./processes.ts";
import { connectionKey, RemoteExecutor } from "./ssh.ts";
import { errorText, ToolFailure } from "./util.ts";

/** Installed package root, independent of source or bundle module depth. */
export const HARNESS_ROOT = fileURLToPath(new URL(".", import.meta.resolve("salam/package.json")));

const INSTALL_HINTS: Record<string, string> = {
	rg: "ripgrep: `brew install ripgrep`, `apt install ripgrep`, or https://github.com/BurntSushi/ripgrep",
	"ast-grep": "ast-grep: `npm i -g @ast-grep/cli`, `brew install ast-grep`, or `cargo install ast-grep`",
	sg: "ast-grep: `npm i -g @ast-grep/cli`, `brew install ast-grep`, or `cargo install ast-grep`",
	git: "git: `brew install git` or your distribution package manager",
	bash: "bash: `brew install bash` or your distribution package manager",
};

/** `scheme://` prefixes are never filesystem paths, local or remote. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * One execution site plus its filesystem. Local and remote work is expressed
 * against the same object, so every tool is written once and the `remote` flag
 * on a `ToolContext` is the only thing that decides where bytes actually move.
 */
export class Workspace {
	constructor(
		readonly id: string,
		readonly label: string,
		readonly executor: Executor,
		readonly fs: WorkspaceFs,
		readonly isRemote: boolean,
	) {}

	get root(): string {
		return this.executor.defaultCwd;
	}

	/**
	 * The directory relative paths and commands resolve against.
	 *
	 * In a remote session `contextCwd` is itself a path on the target — an
	 * agent's remote worktree, for instance — so it is honoured, and the
	 * configured `remote.cwd` is only the fallback. It must be absolute: a
	 * relative or local-looking value would silently address the wrong tree, so
	 * those fall back to the configured root instead.
	 */
	base(contextCwd: string): string {
		const candidate = contextCwd.trim();
		if (candidate.length === 0) return this.root;
		if (this.isRemote && !candidate.startsWith("/")) return this.root;
		return candidate;
	}

	resolvePath(contextCwd: string, input: string): string {
		const raw = input.trim();
		if (raw.length === 0) throw new ToolFailure("Path argument is empty.");
		if (URI_SCHEME.test(raw)) {
			throw new ToolFailure(
				`\`${raw}\` is a URI, not a filesystem path. Only \`read\` accepts artifact:// references.`,
			);
		}
		let candidate = raw;
		if (candidate === "~" || candidate.startsWith("~/")) {
			if (this.isRemote) {
				throw new ToolFailure(`"~" is not expanded on ${this.label}; pass an absolute remote path.`);
			}
			candidate = posix.join(homedir(), candidate.slice(1));
		}
		return posix.resolve(this.base(contextCwd), candidate);
	}

	async requireBinary(name: string, purpose: string, signal?: AbortSignal): Promise<string> {
		const found = await this.executor.which(name, signal);
		if (found) return found;
		const hint = INSTALL_HINTS[name];
		throw new ToolFailure(
			`\`${name}\` is not installed on ${this.label}, so ${purpose} cannot run.${hint ? ` Install ${hint}` : ""}`,
		);
	}

	close(): Promise<void> {
		return this.executor.close();
	}
}

/**
 * Paths shown to the model and written into diff headers. Relative while the
 * file lives under the working directory, absolute once it escapes it, so a
 * result never looks local when it is not.
 */
export function displayPath(base: string, absolute: string): string {
	const relative = posix.relative(base, absolute);
	return relative === "" ? "." : relative.startsWith("..") ? absolute : relative;
}

export interface Snapshot {
	hash: string;
	size: number;
	at: number;
}

const MAX_SNAPSHOTS = 4000;
const SNAPSHOT_EVICTION = 1000;

/**
 * Remembers the exact bytes an agent last observed for a path. Writes and edits
 * refuse to proceed when the file on disk no longer matches, which is what stops
 * a concurrent human edit from being silently clobbered.
 *
 * Scoped per (session, agent, workspace, path): two agents working the same file
 * each need their own read before they may write, and neither inherits the
 * other's staleness.
 */
export class FreshnessTracker {
	private readonly entries = new Map<string, Snapshot>();

	private static key(context: ToolContext, workspaceId: string, path: string): string {
		return `${context.sessionId}\u0000${context.agentId}\u0000${workspaceId}\u0000${path}`;
	}

	record(context: ToolContext, workspaceId: string, path: string, hash: string, size: number): void {
		if (this.entries.size >= MAX_SNAPSHOTS) {
			let removed = 0;
			for (const key of this.entries.keys()) {
				this.entries.delete(key);
				if (++removed >= SNAPSHOT_EVICTION) break;
			}
		}
		this.entries.set(FreshnessTracker.key(context, workspaceId, path), { hash, size, at: Date.now() });
	}

	get(context: ToolContext, workspaceId: string, path: string): Snapshot | undefined {
		return this.entries.get(FreshnessTracker.key(context, workspaceId, path));
	}
}

/**
 * Shared services every tool closes over: config, artifacts, freshness,
 * background jobs, workspaces.
 */
export class ToolEnvironment {
	readonly artifacts: ArtifactStore;
	readonly freshness = new FreshnessTracker();
	/** Background commands, bound to the workspaces below and closed before them. */
	readonly processes: ProcessRegistry;
	private readonly workspaces = new Map<string, Workspace>();
	private readonly localBinDirs: string[];
	private closed = false;

	constructor(readonly config: SalamConfig) {
		this.artifacts = new ArtifactStore(config.home);
		this.localBinDirs = [
			join(HARNESS_ROOT, "node_modules", ".bin"),
			join(config.cwd, "node_modules", ".bin"),
		];
		this.processes = new ProcessRegistry(
			this.artifacts,
			join(config.home, "processes"),
			(remote) => this.workspace({ remote }).executor,
		);
	}

	workspace(context: Pick<ToolContext, "remote">): Workspace {
		if (this.closed) throw new ToolFailure("The tool host has been closed.");
		if (!context.remote) {
			const existing = this.workspaces.get("local");
			if (existing) return existing;
			const executor = new LocalExecutor(this.config.cwd, this.localBinDirs);
			const workspace = new Workspace("local", "this machine", executor, new LocalFs(), false);
			this.workspaces.set("local", workspace);
			return workspace;
		}
		const key = connectionKey(context.remote);
		const existing = this.workspaces.get(key);
		if (existing) return existing;
		const executor = new RemoteExecutor(context.remote, this.config.home);
		const workspace = new Workspace(key, executor.host, executor, new RemoteFs(executor), true);
		this.workspaces.set(key, workspace);
		return workspace;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		// Jobs first: killing a remote process tree needs the very SSH connection
		// the workspaces are about to drop, and an unreachable host means an
		// orphaned worker on the other side.
		await this.processes.close();
		const pending = [...this.workspaces.values()].map((workspace) =>
			workspace.close().catch(() => undefined),
		);
		this.workspaces.clear();
		await Promise.all(pending);
	}
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	run(args: Arguments, context: ToolContext): Promise<ToolOutput>;
}

/**
 * Turns a definition into a `HarnessTool`, converting thrown failures and
 * interruptions into ordinary error results. A tool call never rejects: the
 * model always receives something it can reason about.
 */
export function defineTool(definition: ToolDefinition): HarnessTool {
	return {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		async execute(args: Arguments, context: ToolContext): Promise<ToolOutput> {
			try {
				return await definition.run(args, context);
			} catch (error) {
				if (context.signal.aborted) {
					return { text: `${definition.name} was interrupted.`, isError: true };
				}
				const message = errorText(error);
				const details = error instanceof ToolFailure ? error.details : undefined;
				return details === undefined
					? { text: message, isError: true }
					: { text: message, isError: true, details };
			}
		},
	};
}
