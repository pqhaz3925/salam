import { dirname } from "node:path";
import type { ToolContext } from "../contracts.ts";
import { mutationPublication } from "../tools/atomic-io.ts";
import type {
	ExternalChange,
	ExternalState,
	FsMutation,
	FsMutationObserver,
	WorkspaceFs,
} from "../tools/fs.ts";
import { missingParents, observeMutations, unobserved } from "../tools/fs.ts";
import { errorText, formatBytes, sha256Hex, ToolFailure } from "../tools/util.ts";
import type { Workspace } from "../tools/workspace.ts";
import type { FileMutation, FileSnapshot, Store } from "./store.ts";

/**
 * The same ceiling the `write` and `edit` tools impose on a rewritable file.
 * Anything larger is refused rather than captured: a rewind point that quietly
 * skipped a file would be worse than no rewind point at all.
 */
const CAPTURE_LIMIT = 8 * 1024 * 1024;

function same(left: FileSnapshot, right: FileSnapshot): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "missing" || right.kind === "missing") return true;
	if (left.kind === "file" && right.kind === "file" && left.hash !== right.hash) return false;
	return left.mode === undefined || right.mode === undefined || left.mode === right.mode;
}

/** One path's verified round trip: where it is now, and where it must end up. */
interface RestorePlan {
	fs: WorkspaceFs;
	path: string;
	target: FileSnapshot;
	/** Current state, kept so a half-applied restore can be rolled back. */
	current: FileSnapshot;
	ids: number[];
	change: boolean;
}

/**
 * Makes the file side of a rewind real.
 *
 * Every mutation a native tool performs inside `run` is recorded before it
 * happens and confirmed after, so a rewind knows both what it is undoing and
 * what the file is supposed to look like right now. That second half is the
 * point: if anything outside salam touched a path in the meantime, the restore
 * refuses instead of overwriting work nobody asked it to discard.
 *
 * Only mutations that go through a `WorkspaceFs` are covered — `write`, `edit`
 * and every language-server workspace edit, including its create, rename and
 * delete resource operations, locally and over SSH. Shell commands and MCP
 * servers write through their own channels; of those, only what a foreground
 * shell command did to files the agent had seen is filed afterwards, through
 * `external` (see `SeenFileChanges`). Everything else is not tracked.
 */
export class FileCheckpoints {
	constructor(
		private readonly store: Store,
		private readonly workspaceFor: (context: ToolContext) => Workspace,
	) {}

	/**
	 * Runs one tool execution with its filesystem effects attributed to
	 * `checkpointId`. Unknown ids run unobserved: no checkpoint, no claim of
	 * restorability.
	 */
	run<T>(checkpointId: string, context: ToolContext, operation: () => Promise<T>): Promise<T> {
		const owner = this.store.checkpointOwner(checkpointId);
		if (!owner) return operation();
		const { sessionId } = owner;
		const observer: FsMutationObserver = {
			external: (_fs, changes) => this.recordExternal(sessionId, checkpointId, context, changes),
			observe: async <R>(fs: WorkspaceFs, mutation: FsMutation, apply: () => Promise<R>): Promise<R> => {
				let started = false;
				try {
					return await this.capture(sessionId, checkpointId, context, fs, mutation, () => {
						started = true;
						return apply();
					});
				} catch (error) {
					if (started) throw error;
					throw new ToolFailure(errorText(error), { publication: "unpublished" });
				}
			},
		};
		return observeMutations(observer, operation);
	}

	/**
	 * Puts every path tracked at `checkpointId` or later back the way it was.
	 *
	 * All paths are preflighted before any byte moves. Each later mutation is
	 * independently guarded, and partial failures are conditionally rolled back.
	 */
	async restore(
		sessionId: string,
		checkpointId: string,
		signal: AbortSignal,
	): Promise<{ files: number; paths: string[] }> {
		const point = this.store.checkpoint(sessionId, checkpointId);
		if (!point) throw new ToolFailure(`Unknown rewind point ${checkpointId}.`);
		if (!point.filesAvailable)
			throw new ToolFailure(
				`Rewind point ${checkpointId} is older than file tracking in this session, so its files cannot be restored. Rewind the conversation only.`,
			);
		const groups = new Map<string, FileMutation[]>();
		for (const record of this.store.mutationsFrom(sessionId, checkpointId)) {
			const key = `${record.workspaceId}\u0000${record.path}`;
			const bucket = groups.get(key);
			if (bucket) bucket.push(record);
			else groups.set(key, [record]);
		}
		const plans: RestorePlan[] = [];
		for (const bucket of groups.values()) plans.push(await this.preflight(sessionId, bucket, signal));
		for (const plan of plans) {
			if (!plan.change || plan.current.kind !== "dir" || plan.target.kind === "dir") continue;
			const inspect = async (path: string): Promise<void> => {
				for (const entry of await plan.fs.entries(path, signal)) {
					const child = plans.find((candidate) => candidate.fs === plan.fs && candidate.path === entry.path);
					if (!child?.change || child.current.kind === "missing")
						throw new ToolFailure(
							`${entry.path} is an externally added or untracked descendant. Nothing was restored.`,
						);
					if (entry.kind === "dir") await inspect(entry.path);
				}
			};
			await inspect(plan.path);
		}
		return unobserved(() => this.applyPlans(plans, signal));
	}

	private async capture<T>(
		sessionId: string,
		checkpointId: string,
		context: ToolContext,
		fs: WorkspaceFs,
		mutation: FsMutation,
		apply: () => Promise<T>,
	): Promise<T> {
		if (mutation.kind === "write" && mutation.bytes > CAPTURE_LIMIT)
			throw new ToolFailure(
				`Writing ${formatBytes(mutation.bytes)} to ${mutation.path} exceeds the ${formatBytes(CAPTURE_LIMIT)} rewind capture limit. The write was refused rather than recorded as something salam could undo.`,
			);
		const workspace = this.workspaceFor(context);
		const paths =
			mutation.kind === "move" && mutation.path !== mutation.to
				? [mutation.path, mutation.to]
				: [mutation.path];
		const before: FileSnapshot[] = [];
		for (const path of paths) before.push(await this.capturable(fs, path, context.signal));
		if (mutation.kind === "mkdir" || mutation.kind === "rmdir" || mutation.kind === "dirmode") {
			const snapshot = before[0]!;
			if (
				snapshot.kind !== (mutation.kind === "mkdir" ? "missing" : "dir") ||
				(mutation.kind === "rmdir" &&
					snapshot.kind === "dir" &&
					mutation.mode !== undefined &&
					mutation.mode !== snapshot.mode) ||
				(mutation.kind === "dirmode" &&
					snapshot.kind === "dir" &&
					mutation.expectedModes?.[0] !== undefined &&
					mutation.expectedModes[0] !== snapshot.mode)
			)
				throw new ToolFailure(`${mutation.path} changed before its directory checkpoint could be captured.`);
		} else {
			const expected =
				mutation.kind === "move"
					? [mutation.expectedSourceHash, mutation.expectedDestinationHash]
					: [mutation.expectedHash];
			for (const [index, snapshot] of before.entries()) {
				const capturedHash = snapshot.kind === "file" ? snapshot.hash : null;
				if (snapshot.kind === "dir" || capturedHash !== expected[index])
					throw new ToolFailure(
						`${paths[index]} changed before its checkpoint could be captured. No mutation was attempted.`,
					);
			}
		}
		mutation.expectedModes = before.map((snapshot) =>
			snapshot.kind === "missing" ? undefined : snapshot.mode,
		);
		if (mutation.kind === "write" && mutation.data) {
			const hash = sha256Hex(mutation.data);
			if (!this.store.hasBlob(hash)) this.store.putBlob(hash, mutation.data);
		}
		// Written before the bytes move: an interruption here leaves a record
		// that says "unknown", never one that says "safe to undo".
		const records = paths.map((path, index) =>
			this.store.recordMutation({
				sessionId,
				checkpointId,
				workspaceId: workspace.id,
				cwd: context.cwd,
				...(context.remote ? { remote: context.remote } : {}),
				path,
				operation: mutation.kind,
				...(paths.length > 1 ? { counterpart: paths[1 - index]! } : {}),
				before: before[index]!,
				at: Date.now(),
			}),
		);
		let failure: unknown;
		try {
			return await apply();
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			await this.settle(fs, paths, records, before, mutation, failure);
		}
	}

	/**
	 * Records the filesystem's commit receipt, not a later external save.
	 * Failure inspection is deliberately unsignalled. Only atomic proof settles
	 * a failure: an unknown remote operation may still commit after observation.
	 */
	private async settle(
		fs: WorkspaceFs,
		paths: string[],
		records: number[],
		before: FileSnapshot[],
		mutation: FsMutation,
		failure: unknown,
	): Promise<void> {
		for (const [index, path] of paths.entries()) {
			try {
				const confirmed = mutation.committed?.[index];
				if (confirmed) {
					const after: FileSnapshot =
						confirmed.kind === "missing"
							? { kind: "missing" }
							: confirmed.kind === "dir"
								? { kind: "dir", mode: confirmed.mode }
								: { kind: "file", hash: confirmed.hash, size: confirmed.size, mode: confirmed.mode };
					if (after.kind === "file" && !this.store.hasBlob(after.hash))
						throw new ToolFailure(`No retained committed bytes for ${path}; leaving its outcome pending.`);
					this.store.settleMutation(records[index]!, same(after, before[index]!) ? "failed" : "done", after);
				} else if (mutationPublication(failure) !== "unknown") {
					// Proof concerns our mutation, not whether the external version
					// is readable, regular, or still present.
					const after = await this.observe(fs, path).catch(() => undefined);
					this.store.settleMutation(records[index]!, "failed", after);
				}
			} catch {
				// The resulting state could not be read, so the record stays
				// `pending` and a later restore refuses it instead of guessing.
			}
		}
	}

	/**
	 * Files a change made outside `WorkspaceFs` — a shell command rewriting a file the agent had
	 * seen — as an already-settled mutation, so rewind and session_diff treat it like an edit.
	 * Both sides' bytes are retained; a restore still refuses if the file moved on since.
	 */
	private recordExternal(
		sessionId: string,
		checkpointId: string,
		context: ToolContext,
		changes: ExternalChange[],
	): void {
		const workspace = this.workspaceFor(context);
		const snapshot = (state: ExternalState): FileSnapshot => {
			if (state.kind === "missing") return state;
			const hash = sha256Hex(state.bytes);
			if (!this.store.hasBlob(hash)) this.store.putBlob(hash, state.bytes);
			return { kind: "file", hash, size: state.bytes.length, mode: state.mode };
		};
		for (const change of changes) {
			if (
				[change.before, change.after].some(
					(state) => state.kind === "file" && state.bytes.length > CAPTURE_LIMIT,
				)
			)
				continue;
			const id = this.store.recordMutation({
				sessionId,
				checkpointId,
				workspaceId: workspace.id,
				cwd: context.cwd,
				...(context.remote ? { remote: context.remote } : {}),
				path: change.path,
				operation: change.after.kind === "missing" ? "remove" : "write",
				before: snapshot(change.before),
				at: Date.now(),
			});
			this.store.settleMutation(id, "done", snapshot(change.after));
		}
	}

	/** Snapshots a path, refusing anything a rewind could not put back. */
	private async capturable(fs: WorkspaceFs, path: string, signal: AbortSignal): Promise<FileSnapshot> {
		const stat = await fs.stat(path, { hash: false, signal });
		if (stat.symlink)
			throw new ToolFailure(
				`${path} is a symbolic link. Salam refuses to change it while a rewind point is active, because restoring it would leave an ordinary file where the link used to be.`,
			);
		if (stat.kind === "missing") return { kind: "missing" };
		if (stat.kind === "dir") return { kind: "dir", mode: stat.mode };
		if (stat.kind === "other")
			throw new ToolFailure(
				`${path} is not a regular file, so its contents cannot be captured for a rewind.`,
			);
		if (stat.size > CAPTURE_LIMIT)
			throw new ToolFailure(
				`${path} is ${formatBytes(stat.size)}, above the ${formatBytes(CAPTURE_LIMIT)} rewind capture limit. The change was refused rather than recorded as something salam could undo.`,
			);
		const read = await fs.readBytes(path, CAPTURE_LIMIT, signal);
		if (read.truncated)
			throw new ToolFailure(
				`${path} grew past the ${formatBytes(CAPTURE_LIMIT)} rewind capture limit while it was being read. The change was refused.`,
			);
		const hash = sha256Hex(read.bytes);
		const confirmed = await fs.stat(path, { signal });
		if (
			confirmed.kind !== "file" ||
			confirmed.symlink ||
			confirmed.hash !== hash ||
			confirmed.mode !== stat.mode ||
			confirmed.size !== read.bytes.length
		)
			throw new ToolFailure(
				`${path} changed while its checkpoint was being captured. The change was refused.`,
			);
		if (!this.store.hasBlob(hash)) this.store.putBlob(hash, read.bytes);
		return { kind: "file", hash, size: read.bytes.length, mode: stat.mode };
	}

	private async observe(fs: WorkspaceFs, path: string): Promise<FileSnapshot> {
		const stat = await fs.stat(path);
		if (stat.symlink) throw new ToolFailure(`${path} is a symbolic link; refusing restore.`);
		if (stat.kind === "missing") return { kind: "missing" };
		if (stat.kind === "dir") return { kind: "dir", mode: stat.mode };
		if (stat.kind !== "file" || stat.symlink) throw new ToolFailure(`${path} is no longer a regular file.`);
		const hash = stat.hash ?? (await fs.hash(path));
		return { kind: "file", hash, size: stat.size, mode: stat.mode };
	}

	private async preflight(
		sessionId: string,
		bucket: FileMutation[],
		signal: AbortSignal,
	): Promise<RestorePlan> {
		const first = bucket[0]!;
		const workspace = this.workspaceFor({
			cwd: first.cwd,
			sessionId,
			agentId: "main",
			signal,
			emit: () => undefined,
			...(first.remote ? { remote: first.remote } : {}),
		});
		if (workspace.id !== first.workspaceId)
			throw new ToolFailure(
				`${first.path} was changed on a workspace this session can no longer reach. Nothing was restored.`,
			);
		const fs = workspace.fs;
		const ids = bucket.map((record) => record.id);
		const applied = bucket.filter((record) => record.status === "done");
		if (bucket.some((record) => record.status === "pending"))
			throw new ToolFailure(
				`A change to ${first.path} was interrupted before salam could confirm it. Its publication outcome is unknown and may still complete remotely; nothing was restored.`,
			);
		if (!applied.length) {
			// Every attempt was proven ineffective. The captured state is only
			// an unused no-op plan value; do not inspect or constrain external work.
			return { fs, path: first.path, target: first.before, current: first.before, ids, change: false };
		}
		for (let index = 1; index < applied.length; index++) {
			const previous = applied[index - 1]!.after;
			if (!previous || !same(previous, applied[index]!.before))
				throw new ToolFailure(
					`${first.path} was edited outside salam between two of its own writes, so rewinding it would silently discard that edit. Nothing was restored.`,
				);
		}
		const target = applied[0]!.before;
		const expected = applied[applied.length - 1]!.after;
		if (!expected)
			throw new ToolFailure(
				`The last change to ${first.path} was never confirmed, so it cannot be safely undone. Nothing was restored.`,
			);
		await missingParents(fs, dirname(first.path), signal);
		const current = await this.observe(fs, first.path);
		if (!same(current, expected))
			throw new ToolFailure(
				`${first.path} has changed since salam last wrote it. Nothing was restored — inspect it, then rewind the conversation only if you want to keep the current file.`,
			);
		if (target.kind === "file" && !this.store.hasBlob(target.hash))
			throw new ToolFailure(
				`The recorded contents of ${first.path} are no longer available, so it cannot be restored. Nothing was restored.`,
			);
		// A partial restore has to be able to put this file back exactly as it is
		// now, and nothing else guarantees these bytes are still recoverable.
		if (current.kind === "file" && !this.store.hasBlob(current.hash)) {
			if (current.size > CAPTURE_LIMIT)
				throw new ToolFailure(
					`${first.path} is ${formatBytes(current.size)}, too large to preserve in case the restore has to be rolled back. Nothing was restored.`,
				);
			const read = await fs.readBytes(first.path, CAPTURE_LIMIT, signal);
			if (read.truncated || sha256Hex(read.bytes) !== current.hash)
				throw new ToolFailure(`${first.path} changed while it was being read. Nothing was restored.`);
			this.store.putBlob(current.hash, read.bytes);
		}
		return { fs, path: first.path, target, current, ids, change: !same(target, current) };
	}

	private async applyPlans(
		plans: RestorePlan[],
		signal: AbortSignal,
	): Promise<{ files: number; paths: string[] }> {
		const steps = plans.flatMap((plan): RestorePlan[] =>
			plan.change &&
			plan.current.kind !== "missing" &&
			plan.target.kind !== "missing" &&
			plan.current.kind !== plan.target.kind
				? [
						{ ...plan, target: { kind: "missing" } },
						{ ...plan, current: { kind: "missing" } },
					]
				: [plan],
		);
		const finalModes: RestorePlan[] = [];
		for (let index = 0; index < steps.length; index++) {
			const plan = steps[index]!;
			if (
				!plan.change ||
				plan.target.kind !== "dir" ||
				plan.current.kind !== "missing" ||
				plan.target.mode === undefined
			)
				continue;
			const mode = plan.target.mode | 0o700;
			if (mode === plan.target.mode) continue;
			const writable: FileSnapshot = { kind: "dir", mode };
			finalModes.push({ ...plan, current: writable });
			steps[index] = { ...plan, target: writable };
		}
		steps.sort((a, b) => {
			const left = a.target.kind === "missing" ? 0 : a.target.kind === "dir" ? 1 : 2;
			const right = b.target.kind === "missing" ? 0 : b.target.kind === "dir" ? 1 : 2;
			return (
				left - right ||
				(left === 0
					? b.path.split("/").length - a.path.split("/").length
					: a.path.split("/").length - b.path.split("/").length)
			);
		});
		steps.push(...finalModes.sort((a, b) => b.path.split("/").length - a.path.split("/").length));
		const done: RestorePlan[] = [];
		const attempted: RestorePlan[] = [];
		try {
			for (const plan of steps) {
				if (!plan.change) continue;
				signal.throwIfAborted();
				attempted.push(plan);
				await this.put(plan.fs, plan.path, plan.target, plan.current, signal);
				done.push(plan);
			}
		} catch (error) {
			const rolled: string[] = [];
			const stuck: string[] = [];
			for (const plan of attempted.toReversed()) {
				if (!done.includes(plan) && mutationPublication(error) === "unknown") {
					stuck.push(`${plan.path} (unconfirmed publication; not rolled back)`);
					continue;
				}
				// Only bytes still provably ours may be put back; anything else was
				// touched by something we are not allowed to overwrite.
				const now = await this.observe(plan.fs, plan.path).catch(() => undefined);
				if (now && same(now, plan.current)) continue;
				if (!now || !same(now, plan.target)) {
					stuck.push(plan.path);
					continue;
				}
				try {
					await this.put(plan.fs, plan.path, plan.current, plan.target);
					rolled.push(plan.path);
				} catch (rollbackError) {
					stuck.push(`${plan.path}: ${errorText(rollbackError)}`);
				}
			}
			throw new ToolFailure(
				`Restoring files failed: ${errorText(error)}.${rolled.length ? ` Rolled back ${rolled.join(", ")}.` : ""}${stuck.length ? ` Left changed: ${stuck.join(", ")} — check these before continuing.` : ""}`,
			);
		}
		this.store.revertMutations(plans.flatMap((plan) => plan.ids));
		const paths = [...new Set(done.map((plan) => plan.path))];
		return { files: paths.length, paths };
	}

	private put(
		fs: WorkspaceFs,
		path: string,
		state: FileSnapshot,
		expected: FileSnapshot,
		signal?: AbortSignal,
	): Promise<void> {
		// Reuse the mutation envelope to restore permissions on the staged inode,
		// before publication. Never chmod a pathname after restoring its contents.
		return observeMutations(
			{
				observe: <T>(_fs: WorkspaceFs, mutation: FsMutation, apply: () => Promise<T>): Promise<T> => {
					mutation.expectedModes = [expected.kind === "missing" ? undefined : expected.mode];
					if (mutation.kind === "write" && state.kind === "file") mutation.mode = state.mode;
					return apply();
				},
			},
			async () => {
				if (state.kind === "missing") {
					if (expected.kind === "missing") return;
					if (expected.kind === "dir") await fs.rmdir(path, signal, expected.mode);
					else await fs.remove(path, signal, expected.hash);
					return;
				}
				if (state.kind === "dir") {
					if (expected.kind === "dir")
						await fs.chmodDirectory(path, state.mode ?? expected.mode ?? 0o755, signal, expected.mode);
					else await fs.mkdir(path, signal, state.mode);
					return;
				}
				const bytes = this.store.blob(state.hash);
				if (!bytes) throw new ToolFailure(`The recorded contents of ${path} are no longer available.`);
				const written = await fs.write(path, bytes, signal, expected.kind === "file" ? expected.hash : null);
				if (written !== state.hash)
					throw new ToolFailure(`Writing ${path} did not reproduce the recorded contents.`);
			},
		);
	}
}
