import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecOptions, ExecResult, Executor, RunningCommand } from "./exec.ts";
import { PROCESS_SUPERVISOR_FILENAME, PROCESS_SUPERVISOR_SOURCE } from "./process-supervisor.ts";
import { ToolFailure } from "./util.ts";

export interface TerminalSize {
	cols: number;
	rows: number;
}
export interface TerminalScreen extends TerminalSize {
	text: string;
	cursorX: number;
	cursorY: number;
	cursorVisible: boolean;
	alternate: boolean;
}
export interface CommandInput {
	text?: string;
	keys?: string[];
	eof?: boolean;
	cols?: number;
	rows?: number;
}
export interface SupervisorChunk {
	stream: "stdout" | "stderr";
	text: string;
	start: number;
	end: number;
}
export interface SupervisorSnapshot {
	state: "running" | "exited";
	code: number | null;
	pid: number | null;
	start: number;
	cursor: number;
	byteStart: number;
	byteCursor: number;
	chunks: SupervisorChunk[];
	screen: TerminalScreen | null;
	timedOut: boolean;
	aborted: boolean;
	terminationConfirmed: boolean | null;
	spawnError?: string;
	neverStarted?: boolean;
	screenError?: string;
	wireCursor?: number;
	wireStart?: number;
}

const installations = new WeakMap<Executor, Promise<string>>();
const INSTALL = `import os,sys,stat,tempfile\nroot=os.path.join(os.path.expanduser('~'),'.cache','salam','process-helpers')\nos.makedirs(root,mode=0o700,exist_ok=True)\ns=os.lstat(root)\nif s.st_uid!=os.getuid() or not stat.S_ISDIR(s.st_mode) or s.st_mode & 0o077: raise RuntimeError('Unsafe process helper directory')\np=os.path.join(root,sys.argv[1])\nsource=sys.stdin.buffer.read()\nif not os.path.isfile(p) or open(p,'rb').read()!=source:\n fd,t=tempfile.mkstemp(dir=root)\n with os.fdopen(fd,'wb') as f: f.write(source); f.flush(); os.fsync(f.fileno())\n os.chmod(t,0o700); os.replace(t,p)\nprint(p)`;

function helperPath(executor: Executor): Promise<string> {
	let pending = installations.get(executor);
	if (!pending) {
		pending = executor
			.exec(["python3", "-c", INSTALL, PROCESS_SUPERVISOR_FILENAME], {
				stdin: PROCESS_SUPERVISOR_SOURCE,
				timeoutMs: 30_000,
			})
			.then((result) => {
				if (result.code !== 0 || result.spawnError)
					throw new ToolFailure(
						`Cannot install process supervisor (Python 3 is required): ${result.stderr || result.spawnError || result.code}`,
					);
				const path = result.stdout.trim();
				if (!path.startsWith("/"))
					throw new ToolFailure("Process supervisor returned an invalid helper path.");
				return path;
			})
			.catch((error: unknown) => {
				installations.delete(executor);
				throw error;
			});
		installations.set(executor, pending);
	}
	return pending;
}

export async function supervisorRequest<T = SupervisorSnapshot>(
	executor: Executor,
	key: string,
	request: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<T> {
	const path = await helperPath(executor);
	const result = await executor.exec(["python3", path], {
		stdin: JSON.stringify({ ...request, key }),
		timeoutMs: request.op === "wait" ? 45_000 : 20_000,
		maxCaptureBytes: 16 * 1024 * 1024,
		independentTransport: request.op === "wait",
		signal,
	});
	let response: T & { error?: string; errorCode?: string };
	try {
		response = JSON.parse(result.stdout) as T & { error?: string; errorCode?: string };
	} catch {
		throw new ToolFailure(
			`Process supervisor transport unavailable: ${result.stderr || result.spawnError || result.stdout || `exit ${result.code}`}`,
		);
	}
	if (response.error || result.code !== 0)
		throw new SupervisorError(
			response.error || `Process supervisor exited with ${result.code}: ${result.stderr}`,
			response.errorCode,
		);
	return response;
}

/** Bounded patience for a supervisor that is alive but refusing connections. */
const STATUS_RETRIES = 20;
const STATUS_RETRY_MS = 100;

class SupervisorError extends ToolFailure {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

const KEYS: Record<string, string> = {
	ENTER: "\r",
	TAB: "\t",
	ESCAPE: "\x1b",
	BACKSPACE: "\x7f",
	DELETE: "\x1b[3~",
	UP: "\x1b[A",
	DOWN: "\x1b[B",
	RIGHT: "\x1b[C",
	LEFT: "\x1b[D",
	HOME: "\x1b[H",
	END: "\x1b[F",
	PAGEUP: "\x1b[5~",
	PAGEDOWN: "\x1b[6~",
	SHIFT_TAB: "\x1b[Z",
	F1: "\x1bOP",
	F2: "\x1bOQ",
	F3: "\x1bOR",
	F4: "\x1bOS",
	F5: "\x1b[15~",
	F6: "\x1b[17~",
	F7: "\x1b[18~",
	F8: "\x1b[19~",
	F9: "\x1b[20~",
	F10: "\x1b[21~",
	F11: "\x1b[23~",
	F12: "\x1b[24~",
};
function inputData(input: CommandInput, pty: boolean): string {
	let data = input.text ?? "";
	for (const key of input.keys ?? []) {
		const normalized = key.toUpperCase().replaceAll("-", "_");
		const control = /^CTRL_([A-Z[\]\\^_])$/.exec(normalized);
		if (normalized === "ENTER") {
			data += pty ? "\r" : "\n";
			continue;
		}
		if (control) data += String.fromCharCode(control[1]!.charCodeAt(0) & 31);
		else if (KEYS[normalized] !== undefined) data += KEYS[normalized];
		else
			throw new ToolFailure(
				`Unknown terminal key: ${key}. Use ENTER, TAB, ESCAPE, arrows, HOME/END, PAGEUP/PAGEDOWN, F1–F12 or CTRL_A–CTRL_Z.`,
			);
	}
	return Buffer.from(data).toString("base64");
}

/** The client may disappear; ownership, deadline, output and terminal state live
 * in the supervisor. The opaque key authenticates its private Unix socket. */
export class SupervisedCommand implements RunningCommand {
	readonly done: Promise<ExecResult>;
	private readonly resolve: (result: ExecResult) => void;
	private readonly ready: Promise<void>;
	private snapshotValue: SupervisorSnapshot | undefined;
	private cursor = 0;
	private byteCursor = 0;
	private finished = false;
	private detached = false;
	private abortRequested = false;
	private stopping = false;
	private captureBytes = 0;
	private stdout: string[] = [];
	private stderr: string[] = [];
	private dropped = 0;
	private refreshPending: Promise<SupervisorSnapshot> | undefined;
	private liftDeadline = false;
	private launchAttempted: boolean;
	private observing = true;
	private readonly observationController = new AbortController();
	private finalSnapshot: SupervisorSnapshot | undefined;
	private forgetting: Promise<boolean> | undefined;

	constructor(
		readonly executor: Executor,
		readonly key: string,
		argv: readonly string[],
		private readonly options: ExecOptions,
		recover = false,
	) {
		const completion = Promise.withResolvers<ExecResult>();
		this.done = completion.promise;
		this.resolve = completion.resolve;
		this.launchAttempted = recover;
		this.ready = (async () => {
			await helperPath(executor);
			this.launchAttempted = true;
			const snapshot = await supervisorRequest(
				executor,
				key,
				recover
					? { op: "status" }
					: {
							op: "start",
							argv,
							cwd: options.cwd ?? executor.defaultCwd,
							env: options.env,
							timeoutMs: options.timeoutMs ?? 0,
							interactive: options.interactive,
							pty: options.pty,
							cols: options.cols ?? 100,
							rows: options.rows ?? 30,
							stdin:
								options.stdin === undefined
									? ""
									: (typeof options.stdin === "string"
											? Buffer.from(options.stdin, "utf8")
											: Buffer.from(options.stdin)
										).toString("base64"),
						},
			);
			this.accept(snapshot);
		})();
		options.signal?.addEventListener("abort", this.abort, { once: true });
		if (options.signal?.aborted) this.abort();
		void this.observe();
	}

	private readonly abort = (): void => {
		this.abortRequested = true;
		void this.terminate().catch(() => {
			/* Retain control and retry via command_stop; never claim a kill. */
		});
	};

	private accept(snapshot: SupervisorSnapshot): void {
		if (snapshot.neverStarted && this.snapshotValue?.pid !== undefined && this.snapshotValue.pid !== null) {
			this.failDead(
				new Error("Supervisor state disappeared after launch; process-tree termination is unconfirmed."),
			);
			return;
		}
		if (
			this.snapshotValue &&
			(snapshot.cursor < this.snapshotValue.cursor || (this.finished && snapshot.state === "running"))
		)
			return;
		this.snapshotValue = { ...snapshot, chunks: [] };
		if (snapshot.start > this.cursor) this.dropped += snapshot.byteStart - this.byteCursor;
		for (const chunk of snapshot.chunks) {
			if (chunk.end <= this.cursor) continue;
			const text = chunk.text.slice(Math.max(0, this.cursor - chunk.start));
			if (chunk.stream === "stdout") this.options.onStdout?.(text);
			else this.options.onStderr?.(text);
			const bytes = Buffer.byteLength(text);
			if (!this.detached && this.captureBytes + bytes <= (this.options.maxCaptureBytes ?? 24 * 1024 * 1024)) {
				(chunk.stream === "stdout" ? this.stdout : this.stderr).push(text);
				this.captureBytes += bytes;
			} else if (!this.detached) this.dropped += bytes;
			this.cursor = chunk.end;
		}
		this.cursor = snapshot.cursor;
		this.byteCursor = snapshot.byteCursor;
		if (snapshot.state !== "running" && !this.finished) {
			this.finished = true;
			this.options.signal?.removeEventListener("abort", this.abort);
			this.resolve({
				code: snapshot.code !== null && snapshot.code < 0 ? 128 - snapshot.code : (snapshot.code ?? 1),
				signal: snapshot.code !== null && snapshot.code < 0 ? `SIG${-snapshot.code}` : null,
				stdout: this.stdout.join(""),
				stderr: this.stderr.join(""),
				droppedStdoutBytes: this.dropped,
				timedOut: snapshot.timedOut,
				aborted: this.abortRequested || snapshot.aborted,
				...(snapshot.spawnError ? { spawnError: snapshot.spawnError } : {}),
				terminationConfirmed: snapshot.terminationConfirmed === true,
			});
		}
	}

	private async observe(): Promise<void> {
		try {
			await this.ready;
		} catch (error) {
			if (!this.launchAttempted) {
				this.accept({
					state: "exited",
					code: 127,
					pid: null,
					start: 0,
					cursor: 0,
					byteStart: 0,
					byteCursor: 0,
					chunks: [],
					screen: null,
					timedOut: false,
					aborted: this.abortRequested,
					terminationConfirmed: true,
					spawnError: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			if (error instanceof SupervisorError && error.code === "dead") {
				this.failDead(error);
				return;
			}
			// A lost start acknowledgement is not proof of process death. Retry
			// authenticated status without launching another child.
		}
		while (!this.finished && this.observing) {
			try {
				if (this.liftDeadline) {
					await supervisorRequest(this.executor, this.key, { op: "deadline", timeoutMs: 0 });
					this.liftDeadline = false;
				}
				const snapshot = await supervisorRequest(
					this.executor,
					this.key,
					{ op: "wait", cursor: this.cursor, waitMs: 30_000 },
					this.observationController.signal,
				);
				if (this.observing) this.accept(snapshot);
			} catch (error) {
				if (!this.observing) return;
				if (error instanceof SupervisorError && error.code === "dead") {
					this.failDead(error);
					return;
				}
				if (this.abortRequested) {
					this.failUnconfirmed(error);
					return;
				}
				await delay(1000);
			}
		}
	}

	private failDead(error: Error): void {
		this.failUnconfirmed(error);
	}

	private failUnconfirmed(error: unknown): void {
		this.accept({
			state: "exited",
			code: null,
			pid: this.snapshotValue?.pid ?? null,
			start: this.cursor,
			cursor: this.cursor,
			byteStart: this.byteCursor,
			byteCursor: this.byteCursor,
			chunks: [],
			screen: null,
			timedOut: false,
			aborted: this.abortRequested,
			terminationConfirmed: false,
			spawnError: error instanceof Error ? error.message : String(error),
		});
	}

	suspendObservation(): void {
		this.observing = false;
		this.observationController.abort();
	}

	/** Transfer the final bounded snapshot into client memory before discarding
	 * execution-host state. No unconfirmed ownership is ever forgotten. */
	forget(): Promise<boolean> {
		this.forgetting ??= (async () => {
			const snapshot = await this.output(0);
			if (snapshot.state === "running" || snapshot.terminationConfirmed !== true) return false;
			this.finalSnapshot = snapshot;
			if (!snapshot.neverStarted && this.launchAttempted)
				await supervisorRequest(this.executor, this.key, { op: "forget" });
			return true;
		})()
			.catch(() => false)
			.finally(() => {
				this.forgetting = undefined;
			});
		return this.forgetting;
	}
	async refresh(): Promise<SupervisorSnapshot> {
		await this.ready.catch(() => undefined);
		if (this.finalSnapshot) return this.finalSnapshot;
		if (!this.launchAttempted && this.snapshotValue) return this.snapshotValue;
		this.refreshPending ??= this.status(this.cursor)
			.then((snapshot) => {
				if (this.finalSnapshot) return this.finalSnapshot;
				this.accept(snapshot);
				return snapshot;
			})
			.finally(() => {
				this.refreshPending = undefined;
			});
		return this.refreshPending;
	}

	/**
	 * A status read. Two transient refusals are not failures: a read still in
	 * flight when `forget` retires the supervisor (the final snapshot, already
	 * in client memory, is the answer), and a live supervisor that briefly
	 * refuses connections (its lease is held; the helper says "retry").
	 */
	private async status(cursor: number): Promise<SupervisorSnapshot> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await supervisorRequest(this.executor, this.key, { op: "status", cursor });
			} catch (error) {
				if (this.finalSnapshot) return this.finalSnapshot;
				if (!(error instanceof SupervisorError && error.code === "retry") || attempt >= STATUS_RETRIES)
					throw error;
				await delay(STATUS_RETRY_MS);
			}
		}
	}

	async output(cursor = 0): Promise<SupervisorSnapshot> {
		await this.ready.catch(() => undefined);
		if (this.finished && this.snapshotValue?.terminationConfirmed === false) return this.snapshotValue;
		if (this.finalSnapshot) return this.finalSnapshot;
		if (!this.launchAttempted && this.snapshotValue) return this.snapshotValue;
		const snapshot = await this.status(cursor);
		if (this.finalSnapshot) return this.finalSnapshot;
		// Polling and explicit reads can complete out of order; never rewind the
		// callback cursor or overwrite newer screen/output state.
		if (!this.snapshotValue || snapshot.cursor >= this.snapshotValue.cursor) this.accept(snapshot);
		return snapshot;
	}

	async send(input: CommandInput): Promise<void> {
		await this.ready.catch(() => undefined);
		if ((input.cols === undefined) !== (input.rows === undefined))
			throw new ToolFailure("Resize requires both cols and rows.");
		await supervisorRequest(this.executor, this.key, {
			op: "send",
			data: inputData(input, this.options.pty === true),
			eof: input.eof,
			cols: input.cols,
			rows: input.rows,
		});
	}

	async screen(): Promise<TerminalScreen> {
		await this.ready.catch(() => undefined);
		const snapshot =
			this.finalSnapshot ??
			(await supervisorRequest<SupervisorSnapshot>(this.executor, this.key, {
				op: "screen",
				cursor: this.cursor,
			}));
		if (!snapshot.screen)
			throw new ToolFailure(snapshot.screenError ?? "This command has no terminal. Start it with pty: true.");
		return snapshot.screen;
	}

	async tcp(port: number, host = "127.0.0.1"): Promise<boolean> {
		await this.ready.catch(() => undefined);
		const result = await supervisorRequest<{ ready: boolean }>(this.executor, this.key, {
			op: "tcp",
			port,
			host,
		});
		return result.ready;
	}

	detach(keepDeadline: boolean): boolean {
		if (this.finished || this.abortRequested || this.stopping || this.options.signal?.aborted) return false;
		this.detached = true;
		this.stdout = [];
		this.stderr = [];
		this.captureBytes = 0;
		this.options.signal?.removeEventListener("abort", this.abort);
		if (!keepDeadline) {
			this.liftDeadline = true;
			void this.ready
				.then(() => supervisorRequest(this.executor, this.key, { op: "deadline", timeoutMs: 0 }))
				.then(() => {
					this.liftDeadline = false;
				})
				.catch(() => {
					/* Retried by observe after transient transport loss. */
				});
		}
		return true;
	}

	async terminate(): Promise<boolean> {
		this.stopping = true;
		await this.ready.catch(() => undefined);
		if (!this.launchAttempted || this.finalSnapshot?.terminationConfirmed) return true;
		try {
			await supervisorRequest(this.executor, this.key, { op: "stop" });
			const until = Date.now() + 12_000;
			do {
				const snapshot = await supervisorRequest(this.executor, this.key, {
					op: "wait",
					cursor: this.cursor,
					waitMs: Math.max(1, until - Date.now()),
				});
				this.accept(snapshot);
				if (snapshot.state !== "running") return snapshot.terminationConfirmed === true;
			} while (Date.now() < until);
		} catch (error) {
			// Settles the foreground gate honestly; the key remains available for
			// a later authenticated stop after a real transport outage.
			this.failUnconfirmed(error);
		}
		if (!this.finished)
			this.failUnconfirmed(
				new Error("Owned process termination did not settle before its control deadline."),
			);
		return false;
	}
}
