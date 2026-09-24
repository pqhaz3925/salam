import { dlopen } from "bun:ffi";
import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RemoteTarget } from "../contracts.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { type ExecResult, type Executor, LocalExecutor } from "./exec.ts";
import { RemoteExecutor } from "./ssh.ts";
import { type CommandInput, SupervisedCommand, type TerminalScreen } from "./supervised-command.ts";
import { randomToken, ToolFailure } from "./util.ts";

export type ProcessState = "running" | "exited" | "cancelled" | "failed";

/** What a background command is, from the outside. Safe to JSON-render as-is. */
export interface ProcessInfo {
	id: string;
	/** The command line as the agent wrote it. */
	command: string;
	cwd: string;
	/** Display name of the workspace it is bound to: `this machine` or a host. */
	target: string;
	sessionId: string;
	agentId: string;
	state: ProcessState;
	/** Exit status once known; null while running and when it never produced one. */
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	note?: string;
	terminationConfirmed?: boolean;
	interactive?: boolean;
	pty?: boolean;
	/** Ended because someone asked it to (command_stop, /kill, shutdown), not on its own. */
	stopRequested?: boolean;
}

/** What a watch observes on a background command; see `ProcessManager.watch`. */
export interface WatchSpec {
	/** JavaScript regex (Unicode) tested against each complete output line. */
	log?: string;
	/** Report the command ending. A pending log watch always reports an exit that preempts it. */
	exit: boolean;
	/** Keep reporting later matching lines instead of stopping after the first. */
	repeat: boolean;
	/** Output position to start from; lines before it are never tested. */
	cursor: number;
}

export interface WatchEvent {
	job: ProcessInfo;
	kind: "log" | "exit";
	/** Matching lines for `log`; the last lines of output for `exit`. */
	lines: string[];
	/** Output end at the time of the event, for command_output. */
	cursor: number;
	/** True when the log pattern was still unmatched when the command ended. */
	unmatched?: boolean;
	/** The watched log pattern, when there is one. */
	pattern?: string;
}

export interface ProcessOutput {
	job: ProcessInfo;
	/** Output from the requested cursor, bounded for display. Status is in job. */
	text: string;
	/** Pass back to resume exactly where this read stopped. */
	cursor: number;
	/** Output was dropped or clipped; `artifact` recovers what was retained. */
	truncated: boolean;
	artifact?: string;
	retainedFrom: number;
	dropped: number;
	ready?: boolean;
}

/**
 * Background commands the agent started and can come back to. The manager owns
 * their lifetime: they survive the tool call that started them and die when it
 * closes, never in between. A foreground command can join them mid-run.
 */
export interface ProcessManager {
	list(): ProcessInfo[];
	read(id: string, cursor?: number): Promise<ProcessOutput>;
	/**
	 * Waits for the job to stop, bounded by `timeoutMs` (0 waits indefinitely)
	 * and by `signal`. Neither a deadline nor an abort touches the process: they
	 * end the waiting and nothing else.
	 */
	wait(id: string, timeoutMs?: number, signal?: AbortSignal, cursor?: number): Promise<ProcessOutput>;
	/** Terminates the process tree and reports what actually happened. */
	stop(id: string, cursor?: number): Promise<ProcessOutput>;
	close(): Promise<void>;
	send(id: string, input: CommandInput, cursor?: number): Promise<ProcessOutput>;
	screen(id: string): Promise<TerminalScreen>;
	recover(): Promise<ProcessInfo[]>;
	waitReady(
		id: string,
		condition: ReadinessCondition,
		timeoutMs?: number,
		signal?: AbortSignal,
		cursor?: number,
	): Promise<ProcessOutput>;
	/**
	 * Moves the owner's running foreground commands into the background as
	 * ordinary jobs — same process, same output, same cursor space — and returns
	 * them; each one's foreground run resolves with its job at once. Commands
	 * that already exited or are being torn down finish where they are.
	 */
	promote(owner: ProcessOwner): ProcessInfo[];
	/**
	 * Observes a job without blocking anyone: `onEvent` fires when a complete
	 * output line matches `spec.log` (once, or throttled when repeating) and
	 * when the job ends on its own. An explicit stop reports nothing. The watch
	 * ends by itself after its last possible event; `cancel` ends it early.
	 */
	watch(id: string, spec: WatchSpec, onEvent: (event: WatchEvent) => void): { cancel(): void };
}

export interface ReadinessCondition {
	log?: string;
	port?: number;
	host?: string;
}

interface PersistedJob {
	version: 1;
	id: string;
	key: string;
	startedAt: number;
	remote?: RemoteTarget;
	request: Omit<StartRequest, "executor">;
}

export interface StartRequest {
	/** Where the job runs. Captured now; it never migrates to another host. */
	executor: Executor;
	/** Fully formed argv, already wrapped in whatever shell the caller wants. */
	argv: readonly string[];
	/** The command line as the agent wrote it, for display only. */
	command: string;
	cwd: string;
	target: string;
	sessionId: string;
	agentId: string;
	/** Deadline in milliseconds; 0 lets the job run until it ends or is stopped. */
	timeoutMs: number;
	interactive?: boolean;
	pty?: boolean;
	cols?: number;
	rows?: number;
	stdin?: string;
}

/** Whose command it is: the pair every tool context carries. */
export interface ProcessOwner {
	sessionId: string;
	agentId: string;
}

export interface ForegroundRequest extends StartRequest {
	/** Interrupts the run and terminates the tree — until the command is promoted. */
	signal: AbortSignal;
	/**
	 * Whether `timeoutMs` still applies once promoted. A deadline the caller
	 * asked for does; a default one only bounded a wait nobody is doing anymore.
	 */
	keepDeadline: boolean;
	/** Live output while in the foreground; never called once promoted. */
	onOutput(chunk: string): void;
	/**
	 * Moves the command to the background after this long instead of letting a deadline
	 * kill it, so long work and its output survive (as Ctrl+B would, but on a timer).
	 */
	promoteAfterMs?: number;
}

/** How a foreground run ended: its command exited, or it became a background job. */
export type ForegroundOutcome =
	| { promoted: false; result: ExecResult }
	| { promoted: true; job: ProcessInfo; reason: "user" | "timeout" };

/** Concurrently running background jobs across every session. */
const MAX_RUNNING = 16;
/** Finished jobs kept for later reads before the oldest are forgotten. */
const MAX_FINISHED = 64;
/** How long `stop` waits for the local child to close before reporting back. */
const STOP_SETTLE_MS = 12_000;
/**
 * The same wait during shutdown. Shorter on purpose: the tree has already been
 * signalled and killed by then, so this only covers stdio draining, and a job
 * holding its pipes open must not hold up the whole harness.
 */
const CLOSE_SETTLE_MS = 3_000;

let lockFile: ((fd: number, operation: number) => number) | undefined;
function acquireLease(path: string, create = true): number | undefined {
	if (!lockFile) {
		const libraries =
			process.platform === "darwin"
				? ["/usr/lib/libSystem.B.dylib"]
				: ["libc.so.6", `/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`];
		for (const library of libraries) {
			try {
				const native = dlopen(library, { flock: { args: ["i32", "i32"], returns: "i32" } });
				lockFile = (fd, operation) => native.symbols.flock(fd, operation);
				break;
			} catch {
				/* Try the platform's other libc, never a PID-based fallback. */
			}
		}
		if (!lockFile) throw new ToolFailure("Process ownership requires native flock support.");
	}
	let fd: number;
	try {
		fd = openSync(path, create ? "a" : "r+", 0o600);
	} catch (error) {
		if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (lockFile(fd, 2 | 4) === 0) return fd;
	closeSync(fd);
	return undefined;
}

/**
 * How often a watch reads new output: at first every second, backing off
 * while the command is quiet up to a local or (each poll being an SSH round
 * trip) remote ceiling, and back to a second as soon as output flows. An exit
 * is observed at once either way; only log matches wait for a poll.
 */
const WATCH_POLL_MS = 1_000;
const WATCH_POLL_MAX_LOCAL_MS = 3_000;
const WATCH_POLL_MAX_REMOTE_MS = 10_000;
/** A repeating watch reports at most this often, batching the lines between. */
const WATCH_REPEAT_MS = 10_000;
/** Bounds on what one watch event carries into the conversation. */
const WATCH_MAX_LINES = 20;
const WATCH_TAIL_LINES = 15;
const WATCH_LINE_CHARS = 400;

function clipLine(line: string): string {
	return line.length > WATCH_LINE_CHARS ? `${line.slice(0, WATCH_LINE_CHARS - 1)}…` : line;
}

/** Compact durations for status lines: `9s`, `3m`, `3m20s`. */
function humanDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${seconds % 60}s`;
}

class Job {
	readonly id: string;
	readonly startedAt: number;
	readonly interactive: boolean;
	readonly pty: boolean;
	readonly command: string;
	readonly cwd: string;
	readonly target: string;
	readonly sessionId: string;
	readonly agentId: string;
	/** Deadline the job runs under; a promoted command keeps only an explicit one. */
	readonly timeoutMs: number;
	state: ProcessState = "running";
	exitCode: number | null = null;
	endedAt: number | undefined;
	/** Why it ended, when an exit code alone would misrepresent it. */
	note: string | undefined;
	private readonly waiters = new Set<() => void>();
	/** Runs over SSH: every output poll is a round trip. */
	readonly remote: boolean;
	running: SupervisedCommand | undefined;
	stopRequested = false;
	terminationConfirmed: boolean | undefined;
	private stopping: Promise<void> | undefined;

	constructor(
		request: StartRequest,
		timeoutMs = request.timeoutMs,
		id = `cmd-${randomToken(8)}`,
		startedAt = Date.now(),
	) {
		this.id = id;
		this.startedAt = startedAt;
		this.interactive = request.interactive === true || request.pty === true;
		this.pty = request.pty === true;
		this.command = request.command;
		this.cwd = request.cwd;
		this.target = request.target;
		this.remote = request.executor.remote !== undefined;
		this.sessionId = request.sessionId;
		this.agentId = request.agentId;
		this.timeoutMs = timeoutMs;
	}

	info(): ProcessInfo {
		return {
			id: this.id,
			command: this.command,
			cwd: this.cwd,
			target: this.target,
			sessionId: this.sessionId,
			agentId: this.agentId,
			state: this.state,
			exitCode: this.exitCode,
			startedAt: this.startedAt,
			interactive: this.interactive,
			pty: this.pty,
			...(this.endedAt === undefined ? {} : { endedAt: this.endedAt }),
			...(this.note === undefined ? {} : { note: this.note }),
			...(this.terminationConfirmed === undefined ? {} : { terminationConfirmed: this.terminationConfirmed }),
			...(this.stopRequested ? { stopRequested: true } : {}),
		};
	}

	attach(command: SupervisedCommand): void {
		this.running = command;
		void command.done.then(
			(result) => this.finish(result),
			(error: unknown) => {
				this.endedAt = Date.now();
				this.state = "failed";
				this.note = `runner failed: ${error instanceof Error ? error.message : String(error)}`;
				this.resolveWaiters();
			},
		);
	}

	private finish(result: ExecResult): void {
		if (this.state !== "running") return;
		this.endedAt = Date.now();
		this.exitCode = result.spawnError ? null : result.code;
		this.terminationConfirmed = result.terminationConfirmed;
		const lifetime = humanDuration(this.endedAt - this.startedAt);
		if (result.spawnError) {
			this.state = "failed";
			this.note = `command failed: ${result.spawnError}${result.terminationConfirmed === false ? "; process-tree termination is unconfirmed" : ""}`;
		} else if (result.terminationConfirmed === false) {
			this.state = "failed";
			this.note = `process exited after ${lifetime}, but cleanup on ${this.target} was not confirmed — descendants may still be running`;
		} else if (this.stopRequested) {
			this.state = "cancelled";
			this.note = `stopped after ${lifetime}; the process tree was terminated`;
		} else if (result.timedOut) {
			this.state = "cancelled";
			this.note = `hit its ${humanDuration(this.timeoutMs)} deadline after ${lifetime} and the process tree was terminated`;
		} else if (result.aborted) {
			this.state = "cancelled";
			this.note = `was interrupted after ${lifetime} and the process tree was terminated`;
		} else {
			this.state = "exited";
			this.note =
				result.code === 0
					? `exited cleanly after ${lifetime}`
					: `exited with ${result.code}${result.signal ? ` (${result.signal})` : ""} after ${lifetime}`;
		}
		this.resolveWaiters();
	}

	/**
	 * Signals the tree and waits, bounded by `settleMs`, for the child to close.
	 * A job that refuses to die stays `running` with an explanatory note rather
	 * than being reported as stopped. Concurrent stops share one termination;
	 * once it has finished, a later stop signals again, because a job that
	 * survived the first attempt is exactly the one worth retrying.
	 */
	terminate(settleMs = STOP_SETTLE_MS): Promise<void> {
		this.stopping ??= this.runTermination(settleMs).finally(() => {
			this.stopping = undefined;
		});
		return this.stopping;
	}

	private async runTermination(settleMs: number): Promise<void> {
		if ((this.state !== "running" && this.terminationConfirmed !== false) || this.running === undefined)
			return;
		this.stopRequested = true;
		this.terminationConfirmed = await this.running.terminate();
		if (this.state === "failed" && this.terminationConfirmed) {
			this.state = "cancelled";
			this.note = "process group termination confirmed";
			this.resolveWaiters();
		}
		await this.settle(settleMs);
		if (this.state !== "running") return;
		this.note = this.terminationConfirmed
			? `was signalled but has not exited yet after ${humanDuration(settleMs)}`
			: `was signalled, but neither its exit nor termination on ${this.target} could be confirmed`;
	}

	private resolveWaiters(): void {
		for (const resolve of this.waiters) resolve();
	}

	/**
	 * Resolves when the job stops, when the deadline passes, or when the waiter
	 * aborts. Waiting is observation only — it never signals the process.
	 */
	settle(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (this.state !== "running" || signal?.aborted) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		let timer: Timer | undefined;
		const finished = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finished);
			this.waiters.delete(finished);
			resolve();
		};
		if (timeoutMs > 0) {
			timer = setTimeout(finished, timeoutMs);
			timer.unref?.();
		}
		signal?.addEventListener("abort", finished, { once: true });
		this.waiters.add(finished);
		return promise;
	}
}

/**
 * Registry of background commands. Jobs are started through `start` — the shell
 * tool's private door — or promoted from a foreground `run`, and afterwards
 * addressed by id, which is what lets an agent kick off a long build, do
 * something else, and come back to it.
 *
 * Nothing here streams once a command is a job: a finished tool call never
 * keeps writing into the conversation. Output accumulates in a bounded buffer
 * and is only ever pulled.
 */
export class ProcessRegistry implements ProcessManager {
	private readonly jobs = new Map<string, Job>();
	private closed = false;
	/** Foreground runs that can still be promoted, each with the move that does it. */
	private readonly foreground = new Map<Job, () => ProcessInfo | undefined>();

	private readonly stateDirectory: string;
	private readonly ownedExecutors = new Set<Executor>();
	private recovery: Promise<ProcessInfo[]> | undefined;
	private readonly leases = new Map<string, number>();
	private readonly cleanups = new Set<Promise<void>>();
	private readonly watches = new Set<AbortController>();

	constructor(
		private readonly artifacts: ArtifactStore,
		stateDirectory = join(artifacts.root, "..", "processes"),
		private readonly executorResolver?: (remote: RemoteTarget | undefined, cwd: string) => Executor,
	) {
		this.stateDirectory = stateDirectory;
		mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
	}

	/** Attach by authenticated supervisor identity, never by saved PID. An
	 * interrupted foreground command is recovered as an ordinary managed job. */
	recover(): Promise<ProcessInfo[]> {
		this.recovery ??= (async () => {
			if (this.closed) throw new ToolFailure("The tool host has been closed.");
			const recovered: ProcessInfo[] = [];
			for (const name of readdirSync(this.stateDirectory)) {
				if (!/^cmd-[a-z0-9]+\.json$/.test(name)) continue;
				const id = name.slice(0, -5);
				if (this.leases.has(id)) continue;
				// Records without a lease may belong to a still-live older host.
				// There is no safe evidence permitting us to adopt or evict them.
				const lease = acquireLease(join(this.stateDirectory, `${id}.lease`), false);
				if (lease === undefined) continue;
				this.leases.set(id, lease);
				let record: PersistedJob;
				try {
					record = JSON.parse(readFileSync(join(this.stateDirectory, name), "utf8")) as PersistedJob;
				} catch (error) {
					this.releaseLease(id);
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				if (record.version !== 1 || !/^[0-9a-f]{40}$/.test(record.key) || name !== `${record.id}.json`) {
					this.releaseLease(id);
					throw new ToolFailure(`Invalid process recovery record: ${name}`);
				}
				let executor: Executor;
				if (this.executorResolver) executor = this.executorResolver(record.remote, record.request.cwd);
				else {
					executor = record.remote
						? new RemoteExecutor(record.remote, join(this.stateDirectory, ".."))
						: new LocalExecutor(record.request.cwd);
					this.ownedExecutors.add(executor);
				}
				const request: StartRequest = { ...record.request, executor };
				const job = new Job(request, request.timeoutMs, record.id, record.startedAt);
				const command = new SupervisedCommand(
					executor,
					record.key,
					request.argv,
					{ cwd: request.cwd, pty: request.pty, maxCaptureBytes: 0 },
					true,
				);
				job.attach(command);
				this.jobs.set(job.id, job);
				this.cleanAfterCompletion(job, command);
				// Recovery attaches all unlocked records synchronously. Network
				// observation runs independently; unreachable hosts remain retryable.
				recovered.push(job.info());
			}
			this.evict();
			return recovered;
		})();
		return this.recovery;
	}

	private releaseLease(id: string): void {
		const fd = this.leases.get(id);
		if (fd !== undefined) {
			this.leases.delete(id);
			closeSync(fd);
		}
	}

	private async cleanFinished(job: Job, command: SupervisedCommand): Promise<void> {
		if (!(await command.forget())) return;
		// Only this flock holder may remove the record. Remove the lease
		// pathname before releasing it; contenders re-read under their lock.
		if (!this.leases.has(job.id)) return;
		try {
			unlinkSync(join(this.stateDirectory, `${job.id}.json`));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.saveWatch(job.id, undefined);
		try {
			unlinkSync(join(this.stateDirectory, `${job.id}.lease`));
		} catch {
			/* Already absent. */
		}
		this.releaseLease(job.id);
	}

	/**
	 * Records (or with `undefined`, forgets) a job's watch beside its recovery
	 * record, so a restarted host re-arms it. Only the lease holder writes.
	 */
	saveWatch(id: string, spec: WatchSpec | undefined): void {
		if (!this.leases.has(id)) return;
		const path = join(this.stateDirectory, `${id}.watch.json`);
		if (!spec) {
			try {
				unlinkSync(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return;
		}
		const temporary = `${path}.${randomToken()}.tmp`;
		writeFileSync(temporary, JSON.stringify({ version: 1, spec }), { mode: 0o600 });
		renameSync(temporary, path);
	}

	/** Watches saved for jobs this registry now owns, e.g. after `recover`. */
	savedWatches(): { id: string; spec: WatchSpec }[] {
		const found: { id: string; spec: WatchSpec }[] = [];
		for (const id of this.jobs.keys()) {
			if (!this.leases.has(id)) continue;
			try {
				const saved = JSON.parse(readFileSync(join(this.stateDirectory, `${id}.watch.json`), "utf8")) as {
					version?: number;
					spec?: WatchSpec;
				};
				if (saved.version === 1 && saved.spec) found.push({ id, spec: saved.spec });
			} catch {
				/* No watch, or an unreadable one: nothing to re-arm. */
			}
		}
		return found;
	}

	private cleanAfterCompletion(job: Job, command: SupervisedCommand): void {
		const cleanup = command.done
			.then(async (result) => {
				if (result.terminationConfirmed) await this.cleanFinished(job, command);
			})
			.catch(() => {
				/* Keep the record/lease when final ownership transfer fails. */
			});
		this.cleanups.add(cleanup);
		void cleanup.finally(() => this.cleanups.delete(cleanup));
	}
	private launch(
		job: Job,
		request: StartRequest,
		options: { signal?: AbortSignal; onOutput?: (text: string) => void } = {},
	): SupervisedCommand {
		const key = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
		const { executor, ...persisted } = request;
		const lease = acquireLease(join(this.stateDirectory, `${job.id}.lease`));
		if (lease === undefined)
			throw new ToolFailure("Command identity is already owned by another live registry.");
		this.leases.set(job.id, lease);
		// Commit identity before starting anything: an abrupt owner loss cannot
		// leave a launched supervisor with no recovery handle.
		const record: PersistedJob = {
			version: 1,
			id: job.id,
			key,
			startedAt: job.startedAt,
			remote: executor.remote,
			request: persisted,
		};
		const temporary = join(this.stateDirectory, `${job.id}.${key}.tmp`);
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(fd, JSON.stringify(record));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		try {
			linkSync(temporary, join(this.stateDirectory, `${job.id}.json`));
		} finally {
			unlinkSync(temporary);
		}
		const command = new SupervisedCommand(executor, key, request.argv, {
			cwd: request.cwd,
			timeoutMs: request.timeoutMs,
			interactive: request.interactive,
			pty: request.pty,
			cols: request.cols,
			rows: request.rows,
			stdin: request.stdin,
			signal: options.signal,
			maxCaptureBytes: options.onOutput ? undefined : 0,
			onStdout: options.onOutput,
			onStderr: options.onOutput,
		});
		this.cleanAfterCompletion(job, command);
		return command;
	}

	start(request: StartRequest): ProcessInfo {
		if (this.closed) throw new ToolFailure("The tool host has been closed.");
		let running = 0;
		for (const job of this.jobs.values())
			if (job.state === "running" || job.terminationConfirmed === false) running++;
		if (running >= MAX_RUNNING) {
			throw new ToolFailure(
				`${MAX_RUNNING} background commands are already running. Stop one with command_stop before starting another.`,
			);
		}
		this.evict();
		const job = new Job(request);
		const command = this.launch(job, request);
		job.attach(command);
		this.jobs.set(job.id, job);
		return job.info();
	}

	/**
	 * Runs a command in the caller's foreground: output streams to `onOutput`,
	 * `signal` and the deadline end it, and the outcome is its exit — unless
	 * `promote` moves it to the background first, which resolves the outcome
	 * with the job it became. Its supervisor retains output from the first byte,
	 * so promotion changes ownership without changing process or cursor space.
	 */
	async run(request: ForegroundRequest): Promise<ForegroundOutcome> {
		if (this.closed) throw new ToolFailure("The tool host has been closed.");
		if (request.signal.aborted) throw new ToolFailure("Interrupted before the command started.");
		const job = new Job(request, request.keepDeadline ? request.timeoutMs : 0);
		const { promise, resolve } = Promise.withResolvers<ForegroundOutcome>();
		let inForeground = true;
		const command = this.launch(job, request, {
			signal: request.signal,
			onOutput: (chunk) => {
				if (inForeground) request.onOutput(chunk);
			},
		});
		job.attach(command);
		// Exit and promotion are decided on one thread: whichever comes first
		// takes the command, and `detach` refuses once it has closed or is being
		// torn down, so the other side never also claims it.
		const promote = (reason: "user" | "timeout") => {
			if (this.closed || !command.detach(request.keepDeadline)) return undefined;
			clearTimeout(timer);
			inForeground = false;
			this.foreground.delete(job);
			this.evict();
			this.jobs.set(job.id, job);
			const info = job.info();
			resolve({ promoted: true, job: info, reason });
			return info;
		};
		this.foreground.set(job, () => promote("user"));
		const timer = request.promoteAfterMs
			? setTimeout(() => promote("timeout"), request.promoteAfterMs)
			: undefined;
		void command.done.then((result) => {
			clearTimeout(timer);
			if (!inForeground) return;
			this.foreground.delete(job);
			if (result.terminationConfirmed === false) {
				this.jobs.set(job.id, job);
				result.stderr += `\n[cleanup unconfirmed; owned command ${job.id} remains controllable with command_stop and recoverable after restart]`;
			}
			resolve({ promoted: false, result });
		});
		return promise;
	}

	promote(owner: ProcessOwner): ProcessInfo[] {
		const promoted: ProcessInfo[] = [];
		for (const [job, move] of this.foreground) {
			if (job.sessionId !== owner.sessionId || job.agentId !== owner.agentId) continue;
			const info = move();
			if (info !== undefined) promoted.push(info);
		}
		return promoted;
	}

	list(): ProcessInfo[] {
		const infos: ProcessInfo[] = [];
		for (const job of this.jobs.values()) infos.push(job.info());
		return infos;
	}

	read(id: string, cursor = 0): Promise<ProcessOutput> {
		return this.output(this.require(id), cursor);
	}

	async wait(id: string, timeoutMs = 30_000, signal?: AbortSignal, cursor = 0): Promise<ProcessOutput> {
		const job = this.require(id);
		await job.settle(timeoutMs, signal);
		return this.output(job, cursor);
	}

	async stop(id: string, cursor = 0): Promise<ProcessOutput> {
		const job = this.require(id);
		await job.terminate();
		if (job.terminationConfirmed && job.running) await this.cleanFinished(job, job.running);
		return this.output(job, cursor);
	}

	async send(id: string, input: CommandInput, cursor = 0): Promise<ProcessOutput> {
		const job = this.require(id);
		if (!job.running) throw new ToolFailure("Command control is unavailable.");
		await job.running.send(input);
		return this.output(job, cursor);
	}

	async screen(id: string): Promise<TerminalScreen> {
		const job = this.require(id);
		if (!job.running) throw new ToolFailure("Command control is unavailable.");
		return job.running.screen();
	}

	async waitReady(
		id: string,
		condition: ReadinessCondition,
		timeoutMs = 30_000,
		signal?: AbortSignal,
		cursor = 0,
	): Promise<ProcessOutput> {
		const job = this.require(id);
		if (!condition.log && condition.port === undefined)
			throw new ToolFailure("Readiness requires a log regex and/or TCP port.");
		let pattern: RegExp | undefined;
		try {
			if (condition.log) pattern = new RegExp(condition.log, "u");
		} catch (error) {
			throw new ToolFailure(
				`Invalid readiness regex: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		let logObserved = !pattern;
		const until = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
		do {
			if (signal?.aborted)
				throw new ToolFailure("Interrupted while waiting for readiness; the command was not stopped.");
			const snapshot = await job.running!.output(cursor);
			if (snapshot.state !== "running" || snapshot.code !== null)
				throw new ToolFailure(
					`${id} exited before readiness was observed (exit ${snapshot.code ?? "unknown"}).`,
				);
			if (pattern && !logObserved)
				logObserved = pattern.test(
					snapshot.chunks.map((chunk) => chunk.text.slice(Math.max(0, cursor - chunk.start))).join(""),
				);
			const tcpObserved =
				condition.port === undefined || (await job.running!.tcp(condition.port, condition.host));
			if (logObserved && tcpObserved) {
				const confirmed = await job.running!.refresh();
				if (confirmed.state !== "running" || confirmed.code !== null)
					throw new ToolFailure(`${id} exited before readiness could be confirmed.`);
				const output = await this.output(job, cursor);
				if (output.job.state !== "running")
					throw new ToolFailure(`${id} exited before readiness could be returned.`);
				return { ...output, ready: true };
			}
			await delay(Math.min(100, Math.max(0, until - Date.now())));
		} while (Date.now() < until);
		throw new ToolFailure(
			`Readiness timeout for ${id}; ${pattern && !logObserved ? "log pattern was not observed" : "TCP connection was not established"}. The command was not stopped.`,
		);
	}

	watch(id: string, spec: WatchSpec, onEvent: (event: WatchEvent) => void): { cancel(): void } {
		const job = this.require(id);
		if (!job.running) throw new ToolFailure("Command output is unavailable.");
		let pattern: RegExp | undefined;
		try {
			if (spec.log) pattern = new RegExp(spec.log, "u");
		} catch (error) {
			throw new ToolFailure(`Invalid watch regex: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!pattern && !spec.exit) throw new ToolFailure("A watch needs a log pattern and/or exit.");
		const stop = new AbortController();
		this.watches.add(stop);
		const running = job.running;
		void (async () => {
			let cursor = spec.cursor;
			let partial = "";
			let pending: string[] = [];
			let lastFired = 0;
			let matched = false;
			let poll = WATCH_POLL_MS;
			const pollCeiling = job.remote ? WATCH_POLL_MAX_REMOTE_MS : WATCH_POLL_MAX_LOCAL_MS;
			const recent: string[] = [];
			const remember = (line: string) => {
				recent.push(line);
				if (recent.length > WATCH_TAIL_LINES) recent.shift();
			};
			const test = (line: string) => {
				remember(line);
				if (!pattern || (matched && !spec.repeat)) return;
				pattern.lastIndex = 0;
				if (!pattern.test(line)) return;
				if (pending.length < WATCH_MAX_LINES) pending.push(clipLine(line));
				matched = true;
			};
			const flush = (force: boolean) => {
				if (!pending.length || stop.signal.aborted || this.closed) return;
				if (!force && spec.repeat && lastFired && Date.now() - lastFired < WATCH_REPEAT_MS) return;
				onEvent({ job: job.info(), kind: "log", lines: pending, cursor, pattern: spec.log });
				pending = [];
				lastFired = Date.now();
			};
			try {
				for (;;) {
					if (stop.signal.aborted || this.closed) return;
					const ended = job.state !== "running";
					const before = cursor;
					const snapshot = await running.output(cursor);
					// Cancelled while the read was in flight: report nothing it returned.
					if (stop.signal.aborted || this.closed) return;
					const from = Math.max(cursor, snapshot.start);
					const text = snapshot.chunks
						.filter((chunk) => chunk.end > from)
						.map((chunk) => chunk.text.slice(Math.max(0, from - chunk.start)))
						.join("");
					cursor = snapshot.cursor;
					const lines = (partial + text).split(/\r?\n/);
					partial = lines.pop() ?? "";
					for (const line of lines) test(line);
					if (ended) {
						if (partial) test(partial);
						flush(true);
						const info = job.info();
						const unmatched = Boolean(pattern) && !matched;
						if (!info.stopRequested && (spec.exit || unmatched) && !stop.signal.aborted && !this.closed)
							onEvent({
								job: info,
								kind: "exit",
								lines: recent.map(clipLine),
								cursor,
								...(unmatched ? { unmatched } : {}),
								...(spec.log ? { pattern: spec.log } : {}),
							});
						return;
					}
					flush(false);
					// A one-shot log watch without exit reporting is finished once it fired.
					if (matched && !spec.repeat && !spec.exit && !pending.length) return;
					poll = snapshot.cursor > before ? WATCH_POLL_MS : Math.min(poll * 2, pollCeiling);
					await job.settle(poll, stop.signal);
				}
			} catch {
				/* Output became unavailable (evicted or shut down); the watch simply ends. */
			} finally {
				this.watches.delete(stop);
			}
		})();
		return { cancel: () => stop.abort() };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const watch of this.watches) watch.abort();
		// Termination has to finish before the executors do: an SSH job is killed
		// over the same ControlMaster the workspace is about to tear down.
		const pending: Promise<void>[] = [];
		for (const job of this.jobs.values()) {
			if (job.state === "running" || job.terminationConfirmed === false)
				pending.push(job.terminate(CLOSE_SETTLE_MS));
		}
		for (const [job] of this.foreground) pending.push(job.terminate(CLOSE_SETTLE_MS));
		await Promise.allSettled(pending);
		await Promise.allSettled(
			[...this.jobs.values()]
				.filter((job) => job.terminationConfirmed && job.running)
				.map((job) => this.cleanFinished(job, job.running!)),
		);
		for (const job of this.jobs.values()) job.running?.suspendObservation();
		for (const [job] of this.foreground) job.running?.suspendObservation();
		await Promise.allSettled(this.cleanups);
		for (const executor of this.ownedExecutors) await executor.close();
		for (const id of this.leases.keys()) this.releaseLease(id);
	}

	private require(id: string): Job {
		const job = this.jobs.get(id.trim());
		if (job === undefined) {
			throw new ToolFailure(
				`No background command with id \`${id}\`. Use command_list to see the current ones.`,
			);
		}
		return job;
	}

	/** Forgets the oldest finished jobs once too many have piled up. */
	private evict(): void {
		let finished = 0;
		for (const job of this.jobs.values())
			if (job.state !== "running" && job.terminationConfirmed !== false) finished++;
		if (finished <= MAX_FINISHED) return;
		for (const [id, job] of this.jobs) {
			if (job.state === "running" || job.terminationConfirmed === false) continue;
			this.jobs.delete(id);
			// Final execution-host output has already transferred to the client
			// before its recovery record is removed by cleanAfterCompletion.
			if (--finished <= MAX_FINISHED) return;
		}
	}

	private async output(job: Job, cursor: number): Promise<ProcessOutput> {
		if (!job.running) throw new ToolFailure("Command output is unavailable.");
		const requested = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
		const snapshot = await job.running.output(requested);
		if (requested > snapshot.cursor)
			throw new ToolFailure(`Cursor ${requested} is beyond the current output end ${snapshot.cursor}.`);
		let from = Math.max(requested, snapshot.start);
		const partsOfOutput: string[] = [];
		for (const chunk of snapshot.chunks) {
			if (chunk.end <= from) continue;
			let offset = Math.max(0, from - chunk.start);
			// A manually supplied cursor inside a surrogate pair must not produce
			// malformed Unicode. Returned cursors always land on a full boundary.
			if (
				offset > 0 &&
				offset < chunk.text.length &&
				/[\uDC00-\uDFFF]/.test(chunk.text[offset]!) &&
				/[\uD800-\uDBFF]/.test(chunk.text[offset - 1]!)
			) {
				offset--;
				from--;
			}
			partsOfOutput.push(chunk.text.slice(offset));
		}
		const dropped = Math.max(0, snapshot.start - requested);
		const info = job.info();
		const bounded = await this.artifacts.bound(partsOfOutput.join(""), {
			sessionId: job.sessionId,
			label: "command",
		});
		const parts: string[] = [];
		if (dropped > 0) {
			parts.push(
				`[${dropped} UTF-16 units of earlier output dropped: the command produced more than the retained buffer]`,
			);
		}
		if (bounded.text.length > 0) parts.push(bounded.text);
		return {
			job: info,
			text: parts.join("\n"),
			cursor: snapshot.cursor,
			retainedFrom: snapshot.start,
			dropped,
			truncated: dropped > 0 || bounded.clipped,
			...(bounded.artifact === undefined ? {} : { artifact: bounded.artifact }),
		};
	}
}
