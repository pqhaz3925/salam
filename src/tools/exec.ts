import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RemoteTarget } from "../contracts.ts";
import { PROCESS_SUPERVISOR_SOURCE } from "./process-supervisor.ts";
import { SupervisedCommand, supervisorRequest } from "./supervised-command.ts";
import { ToolFailure } from "./util.ts";

export interface ExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string | Uint8Array;
	/** Keep stdin open for command_send; PTY implies interactive input. */
	interactive?: boolean;
	pty?: boolean;
	cols?: number;
	rows?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Keep long control waits off an SSH master's bounded channel pool. */
	independentTransport?: boolean;
	/** Hard safety ceiling on captured bytes per stream. */
	maxCaptureBytes?: number;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	/**
	 * Own the complete process group through a durable, identity-anchored
	 * supervisor. Also implied by interactive or pty.
	 */
	processGroup?: boolean;
}

export interface ExecResult {
	code: number;
	signal: string | null;
	stdout: string;
	stderr: string;
	/** Bytes dropped because `maxCaptureBytes` was hit; 0 in the normal case. */
	droppedStdoutBytes: number;
	timedOut: boolean;
	aborted: boolean;
	/** Non-empty when the command could not be started at all. */
	spawnError?: string;
	/** False means cleanup could not confirm the owned process group is gone. */
	terminationConfirmed?: boolean;
}

export interface BinaryExecResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
	truncated: boolean;
}

export interface SpawnSpec {
	file: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface PreparedCommand {
	spec: SpawnSpec;
}

/** A command that is already running and whose lifetime the caller owns. */
export interface RunningCommand {
	/** Resolves once the child closed and both streams drained. Never rejects. */
	readonly done: Promise<ExecResult>;
	/**
	 * Signals the whole process tree. Resolves true when termination is
	 * confirmed; remotely that means the kill actually observed the tree die.
	 * Resolving does not mean `done` has settled — stdio may still be draining.
	 */
	terminate(): Promise<boolean>;
	/**
	 * Hands the command to a new owner without touching the process: the abort
	 * signal stops applying, the deadline too unless `keepDeadline`, and captured
	 * output is released — from here on output reaches only the `onStdout` and
	 * `onStderr` callbacks, and `done` reports the exit with empty streams.
	 * Returns false, changing nothing, once the command has closed or its tree
	 * is already being torn down: its current owner is finishing it.
	 */
	detach(keepDeadline: boolean): boolean;
}

export interface ProtocolProcess {
	child: ChildProcess;
	terminate(): Promise<boolean>;
}

const DEFAULT_CAPTURE_BYTES = 24 * 1024 * 1024;
const KILL_GRACE_MS = 2500;

interface Capture {
	chunks: Buffer[];
	kept: number;
	total: number;
}

interface RunOutcome {
	result: ExecResult;
	stdoutBytes: Buffer;
}

interface RunningPrepared {
	outcome: Promise<RunOutcome>;
	terminate(): Promise<boolean>;
	detach(keepDeadline: boolean): boolean;
}

function startPrepared(prepared: PreparedCommand, options: ExecOptions): RunningPrepared {
	let captureLimit = options.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES;
	const { promise, resolve } = Promise.withResolvers<RunOutcome>();

	let child: ChildProcess;
	try {
		child = spawn(prepared.spec.file, prepared.spec.args, {
			cwd: prepared.spec.cwd,
			env: prepared.spec.env ? { ...process.env, ...prepared.spec.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		return {
			outcome: Promise.resolve({
				result: {
					code: 127,
					signal: null,
					stdout: "",
					stderr: "",
					droppedStdoutBytes: 0,
					timedOut: false,
					aborted: false,
					spawnError: error instanceof Error ? error.message : String(error),
				},
				stdoutBytes: Buffer.alloc(0),
			}),
			// Nothing was started, so there is nothing left to confirm dead.
			terminate: () => Promise.resolve(true),
			detach: () => false,
		};
	}

	const out: Capture = { chunks: [], kept: 0, total: 0 };
	const err: Capture = { chunks: [], kept: 0, total: 0 };
	const outDecoder = options.onStdout ? new TextDecoder("utf-8", { fatal: false }) : undefined;
	const errDecoder = options.onStderr ? new TextDecoder("utf-8", { fatal: false }) : undefined;
	let timedOut = false;
	let aborted = false;
	let settled = false;
	let spawnError: string | undefined;
	let timer: Timer | undefined;
	let termination: Promise<boolean> | undefined;
	let terminationResult: boolean | undefined;

	const localAlive = (): boolean => {
		if (child.pid === undefined) return false;
		return !settled && child.exitCode === null && child.signalCode === null;
	};
	const killTree = (signal: NodeJS.Signals): void => {
		if (child.pid === undefined) return;
		if (settled || child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill(signal);
		} catch {
			/* Already reaped. */
		}
	};
	const terminateLocal = async (): Promise<boolean> => {
		if (!localAlive()) return true;
		killTree("SIGTERM");
		const deadline = Date.now() + KILL_GRACE_MS;
		while (localAlive() && Date.now() < deadline) await delay(50);
		if (localAlive()) killTree("SIGKILL");
		for (let attempt = 0; attempt < 20 && localAlive(); attempt++) await delay(50);
		return !localAlive();
	};
	const teardown = (): Promise<boolean> => {
		if (terminationResult === true) return Promise.resolve(true);
		termination ??= (async () => {
			terminationResult = await terminateLocal();
			return terminationResult;
		})().finally(() => {
			termination = undefined;
		});
		return termination;
	};

	const onAbort = () => {
		aborted = true;
		// The close result awaits this confirmation, including timeout/abort paths.
		void teardown();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const detach = (keepDeadline: boolean): boolean => {
		if (
			settled ||
			aborted ||
			timedOut ||
			options.signal?.aborted ||
			termination !== undefined ||
			terminationResult !== undefined
		)
			return false;
		options.signal?.removeEventListener("abort", onAbort);
		if (!keepDeadline) clearTimeout(timer);
		captureLimit = 0;
		out.chunks = [];
		out.kept = 0;
		err.chunks = [];
		err.kept = 0;
		return true;
	};

	if (options.timeoutMs && options.timeoutMs > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			void teardown();
		}, options.timeoutMs);
	}

	child.stdout?.on("data", (chunk: Buffer) => {
		out.total += chunk.length;
		if (out.kept + chunk.length <= captureLimit) {
			out.chunks.push(chunk);
			out.kept += chunk.length;
		}
		if (outDecoder && options.onStdout) options.onStdout(outDecoder.decode(chunk, { stream: true }));
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		err.total += chunk.length;
		if (err.kept + chunk.length <= captureLimit) {
			err.chunks.push(chunk);
			err.kept += chunk.length;
		}
		if (errDecoder && options.onStderr) options.onStderr(errDecoder.decode(chunk, { stream: true }));
	});

	child.on("error", (error) => {
		spawnError = error instanceof Error ? error.message : String(error);
	});

	if (child.stdin) {
		child.stdin.on("error", () => {
			// The child may exit before draining stdin; EPIPE is expected.
		});
		child.stdin.end(
			options.stdin === undefined
				? undefined
				: typeof options.stdin === "string"
					? Buffer.from(options.stdin, "utf8")
					: Buffer.from(options.stdin),
		);
	}

	child.on("close", async (code, signalName) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		if (outDecoder && options.onStdout) options.onStdout(outDecoder.decode());
		if (errDecoder && options.onStderr) options.onStderr(errDecoder.decode());
		const terminationConfirmed = termination ? await termination : terminationResult;
		const stdoutBytes = Buffer.concat(out.chunks, out.kept);
		resolve({
			result: {
				code: code ?? (signalName ? 128 : 1),
				signal: signalName ?? null,
				stdout: stdoutBytes.toString("utf8"),
				stderr: Buffer.concat(err.chunks, err.kept).toString("utf8"),
				droppedStdoutBytes: out.total - out.kept,
				timedOut,
				aborted,
				spawnError,
				...(terminationConfirmed === undefined ? {} : { terminationConfirmed }),
			},
			stdoutBytes,
		});
	});

	return { outcome: promise, terminate: teardown, detach };
}

/**
 * A place where commands run. `LocalExecutor` runs them on this machine;
 * `RemoteExecutor` (ssh.ts) runs the exact same argv on an SSH target. Every
 * filesystem, search, AST and LSP operation goes through one of these, which is
 * what makes a remote session incapable of touching local files.
 */
export abstract class Executor {
	abstract readonly id: string;
	abstract readonly remote: RemoteTarget | undefined;
	abstract readonly defaultCwd: string;
	protected abstract prepare(argv: readonly string[], options: ExecOptions): PreparedCommand;

	private readonly resolved = new Map<string, Promise<string | null>>();

	async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
		if (options.signal?.aborted) throw new ToolFailure("Interrupted before the command started.");
		if (argv.length === 0) throw new ToolFailure("Refusing to run an empty command.");
		if (options.processGroup || options.interactive || options.pty) return this.start(argv, options).done;
		const { result } = await startPrepared(this.prepare(argv, options), options).outcome;
		return result;
	}

	async execBytes(argv: readonly string[], options: ExecOptions = {}): Promise<BinaryExecResult> {
		if (options.signal?.aborted) throw new ToolFailure("Interrupted before the command started.");
		if (options.processGroup || options.interactive || options.pty) {
			const protocol = this.protocol(argv, options, false);
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			const limit = options.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES;
			let kept = 0;
			let errorKept = 0;
			let total = 0;
			const stdoutDecoder = new TextDecoder();
			const stderrDecoder = new TextDecoder();
			return new Promise<BinaryExecResult>((resolve, reject) => {
				protocol.child.stdout?.on("data", (chunk: Buffer) => {
					total += chunk.length;
					const slice = chunk.subarray(0, Math.max(0, limit - kept));
					if (slice.length) {
						out.push(Buffer.from(slice));
						kept += slice.length;
					}
					options.onStdout?.(stdoutDecoder.decode(chunk, { stream: true }));
				});
				protocol.child.stderr?.on("data", (chunk: Buffer) => {
					const slice = chunk.subarray(0, Math.max(0, limit - errorKept));
					if (slice.length) {
						err.push(Buffer.from(slice));
						errorKept += slice.length;
					}
					options.onStderr?.(stderrDecoder.decode(chunk, { stream: true }));
				});
				protocol.child.once("error", reject);
				protocol.child.once("close", async (code) => {
					options.onStdout?.(stdoutDecoder.decode());
					options.onStderr?.(stderrDecoder.decode());
					if (!(await protocol.terminate())) {
						reject(new ToolFailure("Binary command ended but process-tree teardown was not confirmed."));
						return;
					}
					resolve({
						code: code ?? 1,
						stdout: Buffer.concat(out, kept),
						stderr: Buffer.concat(err, errorKept).toString("utf8"),
						truncated: total > kept,
					});
				});
				protocol.child.stdin?.on("error", () => {
					/* The command can exit before reading its input. */
				});
				protocol.child.stdin?.end();
			});
		}
		const { result, stdoutBytes } = await startPrepared(this.prepare(argv, options), options).outcome;
		return {
			code: result.code,
			stdout: stdoutBytes,
			stderr: result.stderr,
			truncated: result.droppedStdoutBytes > 0,
		};
	}

	/**
	 * Starts a command and hands back its lifetime instead of awaiting it. Same
	 * spawn, capture and process-group teardown as `exec`; the difference is that
	 * the caller decides when — and whether — the tree is signalled, which is what
	 * lets a background job outlive the tool call that started it.
	 */
	start(argv: readonly string[], options: ExecOptions = {}): RunningCommand {
		if (options.signal?.aborted) throw new ToolFailure("Interrupted before the command started.");
		if (argv.length === 0) throw new ToolFailure("Refusing to run an empty command.");
		if (options.processGroup || options.interactive || options.pty) {
			const command = new SupervisedCommand(
				this,
				crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "").slice(0, 8),
				argv,
				options,
			);
			void command.done.then((result) => {
				if (result.terminationConfirmed) return command.forget();
			});
			return command;
		}
		const running = startPrepared(this.prepare(argv, options), options);
		return {
			done: running.outcome.then((outcome) => outcome.result),
			terminate: running.terminate,
			detach: running.detach,
		};
	}

	/** Bidirectional protocol pipes with the same anchored, owned process-tree
	 * teardown on both local and SSH workspaces. The bridge never closes stdin
	 * on startup; its supervisor survives transport loss long enough to stop it. */
	startProtocolProcess(argv: readonly string[], options: ExecOptions = {}): ProtocolProcess {
		return this.protocol(argv, options, true);
	}

	private protocol(argv: readonly string[], options: ExecOptions, stopOnEof: boolean): ProtocolProcess {
		if (argv.length === 0) throw new ToolFailure("Refusing to run an empty command.");
		if (options.signal?.aborted) throw new ToolFailure("Interrupted before the command started.");
		const key = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
		const request = JSON.stringify({
			op: "bridge",
			key,
			argv,
			cwd: options.cwd ?? this.defaultCwd,
			env: options.env,
			timeoutMs: options.timeoutMs ?? 0,
			pty: options.pty,
			cols: options.cols ?? 100,
			rows: options.rows ?? 30,
			stopOnEof,
			stdin:
				options.stdin === undefined
					? ""
					: (typeof options.stdin === "string"
							? Buffer.from(options.stdin, "utf8")
							: Buffer.from(options.stdin)
						).toString("base64"),
		});
		const prepared = this.prepare(["python3", "-c", PROCESS_SUPERVISOR_SOURCE, request], {
			...options,
			processGroup: false,
		});
		const child = spawn(prepared.spec.file, prepared.spec.args, {
			cwd: prepared.spec.cwd,
			env: prepared.spec.env ? { ...process.env, ...prepared.spec.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stopping: Promise<boolean> | undefined;
		let confirmed = false;
		let bridgeClosed = false;
		const forget = async (): Promise<void> => {
			if (!confirmed || !bridgeClosed) return;
			try {
				const state = await supervisorRequest(this, key, { op: "status" });
				if ((state.wireStart ?? 0) < (state.wireCursor ?? 0)) return;
				await supervisorRequest(this, key, { op: "forget", wireCursor: state.wireCursor ?? 0 });
			} catch {
				/* Keep final state if the acknowledged drain cannot be confirmed. */
			}
		};
		const terminate = (): Promise<boolean> => {
			if (confirmed) {
				void forget();
				return Promise.resolve(true);
			}
			stopping ??= (async () => {
				// Startup and cancellation may race. Retry only authenticated
				// control, never a PID learned from a stale marker.
				const until = Date.now() + 15_000;
				do {
					try {
						const state = await supervisorRequest(this, key, { op: "stop" });
						if (
							state.terminationConfirmed === true &&
							state.state !== "running" &&
							(!state.neverStarted || bridgeClosed)
						) {
							confirmed = true;
							child.stdin?.end();
							await forget();
							return true;
						}
					} catch {
						if (child.exitCode !== null || child.signalCode !== null) return false;
					}
					await delay(100);
				} while (Date.now() < until);
				return false;
			})().finally(() => {
				stopping = undefined;
			});
			return stopping;
		};
		const abort = () => {
			void terminate();
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		child.once("close", () => {
			bridgeClosed = true;
			options.signal?.removeEventListener("abort", abort);
			void terminate();
		});
		return { child, terminate };
	}

	/** Long-lived stdio child used for language servers. */
	startProcess(argv: readonly string[], options: ExecOptions = {}): ChildProcess {
		const prepared = this.prepare(argv, options);
		return spawn(prepared.spec.file, prepared.spec.args, {
			cwd: prepared.spec.cwd,
			env: prepared.spec.env ? { ...process.env, ...prepared.spec.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	/** Absolute path of `name` on this executor, or null when it is not installed. */
	which(name: string, signal?: AbortSignal): Promise<string | null> {
		const cached = this.resolved.get(name);
		if (cached) return cached;
		const lookup = this.locate(name, signal).catch(() => null);
		this.resolved.set(name, lookup);
		return lookup;
	}

	/**
	 * `command -v` is a shell builtin, so it cannot be spawned directly; each
	 * executor resolves binaries the way its own environment allows.
	 */
	protected abstract locate(name: string, signal?: AbortSignal): Promise<string | null>;

	abstract close(): Promise<void>;
}

export class LocalExecutor extends Executor {
	readonly id = "local";
	readonly remote = undefined;

	/**
	 * @param binDirs Directories searched before `$PATH`, so a project's own
	 *   `node_modules/.bin` tooling wins over whatever happens to be installed
	 *   globally.
	 */
	constructor(
		readonly defaultCwd: string,
		private readonly binDirs: readonly string[] = [],
	) {
		super();
	}

	protected prepare(argv: readonly string[], options: ExecOptions): PreparedCommand {
		return {
			spec: {
				file: argv[0]!,
				args: argv.slice(1),
				cwd: options.cwd ?? this.defaultCwd,
				env: options.env,
			},
		};
	}

	protected async locate(name: string): Promise<string | null> {
		for (const directory of this.binDirs) {
			const candidate = join(directory, name);
			if (await Bun.file(candidate).exists()) return candidate;
		}
		return Bun.which(name) ?? null;
	}

	async close(): Promise<void> {
		// Nothing persistent to release locally.
	}
}
