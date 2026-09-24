import { mkdir } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import type { ToolContext } from "../contracts.ts";
import type { Workspace } from "../tools/workspace.ts";
import type { ExecResult } from "../tools/exec.ts";
import { RemoteExecutor, connectionKey } from "../tools/ssh.ts";
import type { Store, WorktreeRecord } from "./store.ts";

export class Worktrees {
	constructor(
		private readonly store: Store,
		private readonly home: string,
		private readonly inUse: (path: string) => boolean,
		private readonly workspaceFor: (context: ToolContext) => Workspace,
	) {}

	private async run(context: ToolContext, args: string[], env?: Record<string, string>): Promise<ExecResult> {
		context.signal.throwIfAborted();
		const result = await this.workspaceFor(context).executor.exec(["git", ...args], {
			cwd: context.cwd,
			signal: context.signal,
			timeoutMs: 120000,
			processGroup: true,
			env: { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", ...env },
		});
		context.signal.throwIfAborted();
		return result;
	}

	private checked(args: string[], result: ExecResult): string {
		if (result.code !== 0 || result.timedOut || result.spawnError)
			throw new Error(
				`git ${args[0]} failed: ${result.timedOut ? "timed out; " : ""}${result.stderr.trim() || result.spawnError || result.stdout.trim() || `exit ${result.code}`}`,
			);
		if (result.droppedStdoutBytes)
			throw new Error(
				"Git output exceeded the capture limit. Use a scoped file diff; no repository state was discarded.",
			);
		return result.stdout.trimEnd();
	}

	private async git(context: ToolContext, args: string[]): Promise<string> {
		return this.checked(args, await this.run(context, args));
	}

	/**
	 * Top-level of the git working tree containing `context.cwd`, or the reason
	 * the directory is definitively outside git: an ordinary non-repository
	 * directory, or no git installed on the execution host. Every other failure
	 * (dubious ownership, broken gitdir links, bare/.git directories, permissions,
	 * timeouts, cancellation) throws so callers never mistake it for "not a repo".
	 */
	async repositoryRoot(
		context: ToolContext,
	): Promise<{ root: string } | { root: undefined; reason: string }> {
		const args = ["rev-parse", "--show-toplevel"];
		// Stable English diagnostics so the non-repository check is locale-independent.
		const result = await this.run(context, args, { LC_ALL: "C" });
		if (!result.timedOut && !result.spawnError && result.code === 128) {
			// Exact wording of git's discovery failure; a broken `.git` link reports
			// "not a git repository: <path>" instead and must stay an error.
			if (/^fatal: not a git repository \(or any /m.test(result.stderr))
				return { root: undefined, reason: `${context.cwd} is not inside a git working tree` };
		} else if (!result.timedOut && (result.spawnError || result.code === 127)) {
			if ((await this.workspaceFor(context).executor.which("git", context.signal)) === null) {
				context.signal.throwIfAborted();
				return { root: undefined, reason: "git is not installed on the execution host" };
			}
			context.signal.throwIfAborted();
		}
		return { root: this.checked(args, result) };
	}

	list(): WorktreeRecord[] {
		return this.store.worktrees();
	}

	private record(id: string): WorktreeRecord {
		const record = this.list().find((item) => item.id === id || item.path === id);
		if (!record) throw new Error(`Unknown managed worktree: ${id}`);
		return record;
	}

	/** `root` is a working-tree top-level already resolved by `repositoryRoot`, to avoid a second probe. */
	async create(context: ToolContext, root?: string): Promise<WorktreeRecord> {
		if (root === undefined) {
			const probe = await this.repositoryRoot(context);
			if (probe.root === undefined) throw new Error(`Cannot create an isolated worktree: ${probe.reason}.`);
			root = probe.root;
		}
		const source = { ...context, cwd: root };
		if (await this.git(source, ["status", "--porcelain"]))
			throw new Error(
				"Checkout has uncommitted changes. Commit or stash them yourself before creating an isolated worktree; salam never copies or discards dirty changes.",
			);
		const base = await this.git(source, ["rev-parse", "HEAD"]);
		const id = crypto.randomUUID();
		const branch = `salam/${id}`;
		const workspace = this.workspaceFor(source);
		let path: string;
		if (workspace.executor instanceof RemoteExecutor) {
			const directory = posix.join(
				posix.dirname(await workspace.executor.helperPath(context.signal)),
				"worktrees",
			);
			const made = await workspace.executor.exec(["mkdir", "-p", directory], {
				cwd: root,
				signal: context.signal,
				timeoutMs: 30000,
			});
			if (made.code !== 0)
				throw new Error(
					`Cannot create remote worktree directory: ${made.stderr || made.spawnError || made.code}`,
				);
			path = posix.join(directory, id);
		} else {
			await mkdir(join(this.home, "worktrees"), { recursive: true });
			path = join(this.home, "worktrees", id);
		}
		await this.git(source, ["worktree", "add", "-b", branch, path, base]);
		const record: WorktreeRecord = {
			id,
			root,
			path,
			branch,
			base,
			createdAt: Date.now(),
			...(context.remote ? { remote: { ...context.remote, cwd: root } } : {}),
		};
		try {
			this.store.worktreeSave(record);
		} catch (error) {
			throw new Error(
				`Worktree exists at ${path} on branch ${branch}, but its database record could not be saved: ${error instanceof Error ? error.message : String(error)}. It has not been deleted.`,
			);
		}
		return record;
	}

	async diff(id: string, context: ToolContext): Promise<string> {
		const record = this.record(id);
		const source = { ...context, cwd: record.path, remote: record.remote };
		const tracked = await this.git(source, ["diff", record.base, "--"]);
		const untracked = await this.git(source, ["ls-files", "--others", "--exclude-standard"]);
		return `${tracked || "(no tracked changes)"}${untracked ? `\nUntracked files (not included in diff):\n${untracked}` : ""}`;
	}

	async merge(id: string, context: ToolContext): Promise<string> {
		const record = this.record(id);
		if (this.inUse(record.path))
			throw new Error("Worktree is in use by a running agent; wait or cancel it before merging.");
		if (
			Boolean(record.remote) !== Boolean(context.remote) ||
			(record.remote && context.remote && connectionKey(record.remote) !== connectionKey(context.remote))
		)
			throw new Error("Merge target must be on the same execution host as the worktree.");
		const targetRoot = await this.git(context, ["rev-parse", "--show-toplevel"]);
		const target = { ...context, cwd: targetRoot };
		const source = { ...context, cwd: record.path, remote: record.remote };
		const targetCommon = await this.git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const sourceCommon = await this.git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const normalize = record.remote ? posix.normalize : resolve;
		if (
			normalize(targetCommon) !== normalize(sourceCommon) ||
			normalize(targetRoot) === normalize(record.path)
		)
			throw new Error("Merge target must be a different checkout of the same repository.");
		for (const checkout of [target, source])
			if (await this.git(checkout, ["status", "--porcelain"]))
				throw new Error(
					`Checkout ${checkout.cwd} is dirty. Commit or stash changes yourself before merging.`,
				);
		return (await this.git(target, ["merge", "--no-edit", record.branch])) || "Worktree branch merged.";
	}

	async remove(id: string, context: ToolContext): Promise<string> {
		const record = this.record(id);
		if (this.inUse(record.path)) throw new Error("Worktree is in use by a running agent.");
		if (await this.git({ ...context, cwd: record.path, remote: record.remote }, ["status", "--porcelain"]))
			throw new Error("Worktree is dirty; refusing to remove uncommitted work.");
		await this.git({ ...context, cwd: record.root, remote: record.remote }, [
			"worktree",
			"remove",
			record.path,
		]);
		this.store.worktreeDelete(record.id);
		return `Removed clean worktree ${record.path}; retained branch ${record.branch}.`;
	}
}
