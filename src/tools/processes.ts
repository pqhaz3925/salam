import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dlopen } from "bun:ffi";
import type { RemoteTarget } from "../contracts.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { LocalExecutor, type Executor, type ExecResult } from "./exec.ts";
import { RemoteExecutor } from "./ssh.ts";
import { SupervisedCommand, type CommandInput, type TerminalScreen } from "./supervised-command.ts";
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
}

/** How a foreground run ended: its command exited, or it became a background job. */
export type ForegroundOutcome =
	| { promoted: false; result: ExecResult }
	| { promoted: true; job: ProcessInfo };

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
	running: SupervisedCommand | undefined;
	private stopRequested = false;
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
		try {
			unlinkSync(join(this.stateDirectory, `${job.id}.lease`));
		} catch {
			/* Already absent. */
		}
		this.releaseLease(job.id);
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
		this.foreground.set(job, () => {
			if (this.closed || !command.detach(request.keepDeadline)) return undefined;
			inForeground = false;
			this.foreground.delete(job);
			this.evict();
			this.jobs.set(job.id, job);
			const info = job.info();
			resolve({ promoted: true, job: info });
			return info;
		});
		void command.done.then((result) => {
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

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
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
