import { Buffer } from "node:buffer";
import { closeSync, openSync, writeSync } from "node:fs";
import type { ProtocolProcess } from "./exec.ts";
import { errorText, ToolFailure } from "./util.ts";

export interface DapEvent {
	cursor: number;
	event: string;
	body?: unknown;
}
export type DapSessionState =
	| "initializing"
	| "running"
	| "stopped"
	| "exited"
	| "terminated"
	| "disconnected";
export interface DapEventBatch {
	events: DapEvent[];
	cursor: number;
	lost: boolean;
	adapterAlive: boolean;
	sessionState: DapSessionState;
	artifact: string;
}
interface PendingRequest {
	command: string;
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
	cleanup(): void;
}

/** DAP differs from LSP in both envelope and lifecycle; framing follows the existing LSP transport. */
export class DapClient {
	private sequence = 0;
	private incoming: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private readonly pending = new Map<number, PendingRequest>();
	private readonly events: DapEvent[] = [];
	private readonly wake = new Set<() => void>();
	private eventCursor = 0;
	private exited = false;
	private sessionState: DapSessionState = "initializing";
	private fd: number;
	private stderr = "";
	private stopping?: Promise<boolean>;
	private attached = false;
	capabilities: Record<string, unknown> = {};

	constructor(
		private readonly process: ProtocolProcess,
		readonly artifact: string,
		journalPath: string,
	) {
		this.fd = openSync(journalPath, "a");
		process.child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
		process.child.stderr?.setEncoding("utf8");
		process.child.stderr?.on("data", (text: string) => {
			this.stderr = (this.stderr + text).slice(-8000);
			this.record("adapter_stderr", { output: text });
		});
		process.child.on("error", (error) => this.fail(`Debug adapter failed: ${error.message}`));
		process.child.on("close", (code, signal) => {
			this.record("adapter_exited", { code, signal });
			this.fail(`Debug adapter exited (${signal ?? code ?? "unknown"}). ${this.stderr}`);
		});
	}
	get adapterAlive(): boolean {
		return !this.exited;
	}
	get cursor(): number {
		return this.eventCursor;
	}

	private fail(reason: string): void {
		this.exited = true;
		if (this.sessionState !== "terminated" && this.sessionState !== "exited")
			this.sessionState = "disconnected";
		for (const request of this.pending.values()) {
			request.cleanup();
			request.reject(new ToolFailure(reason));
		}
		this.pending.clear();
		for (const wake of this.wake) wake();
		if (this.fd >= 0) {
			closeSync(this.fd);
			this.fd = -1;
		}
	}
	private record(event: string, body?: unknown): void {
		switch (event) {
			case "process":
			case "continued":
				this.sessionState = "running";
				break;
			case "stopped":
				this.sessionState = "stopped";
				break;
			case "exited":
				if (this.sessionState !== "terminated") this.sessionState = "exited";
				break;
			case "terminated":
				this.sessionState = "terminated";
				break;
		}
		const entry: DapEvent = { cursor: ++this.eventCursor, event, ...(body === undefined ? {} : { body }) };
		const serialized = JSON.stringify(entry);
		this.events.push(
			serialized.length > 32_000
				? {
						cursor: entry.cursor,
						event,
						body: { preview: serialized.slice(0, 32_000), truncated: true, artifact: this.artifact },
					}
				: entry,
		);
		if (this.events.length > 1000) this.events.shift();
		try {
			if (this.fd >= 0) writeSync(this.fd, `${serialized}\n`);
		} catch (error) {
			this.fail(`Debugger event journal failed: ${errorText(error)}`);
			void this.stop();
		}
		for (const wake of this.wake) wake();
	}
	private send(message: Record<string, unknown>): void {
		if (this.exited) throw new ToolFailure("Debug adapter is no longer running.");
		const body = JSON.stringify({ seq: ++this.sequence, ...message });
		this.process.child.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, (error) => {
			if (error) this.fail(`Debug adapter input failed: ${error.message}`);
		});
	}
	private consume(chunk: Buffer): void {
		this.incoming = this.incoming.length ? Buffer.concat([this.incoming, chunk]) : chunk;
		try {
			for (;;) {
				const end = this.incoming.indexOf("\r\n\r\n");
				if (end < 0) {
					if (this.incoming.length > 8192) throw new ToolFailure("Invalid DAP header (over 8 KiB).");
					return;
				}
				const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(
					this.incoming.subarray(0, end).toString("ascii"),
				);
				const length = match ? Number(match[1]) : NaN;
				if (!Number.isSafeInteger(length) || length < 0 || length > 32 * 1024 * 1024)
					throw new ToolFailure("Invalid DAP Content-Length (maximum 32 MiB).");
				if (this.incoming.length < end + 4 + length) return;
				const message = JSON.parse(
					this.incoming.subarray(end + 4, end + 4 + length).toString("utf8"),
				) as Record<string, unknown>;
				this.incoming = this.incoming.subarray(end + 4 + length);
				if (message.type === "event") this.record(String(message.event), message.body);
				else if (message.type === "response") {
					const request = this.pending.get(Number(message.request_seq));
					if (!request) continue;
					this.pending.delete(Number(message.request_seq));
					request.cleanup();
					if (message.success === true) {
						if (request.command === "disconnect") this.attached = false;
						if (
							(request.command === "launch" || request.command === "attach") &&
							this.sessionState === "initializing"
						)
							this.sessionState = "running";
						request.resolve((message.body ?? {}) as Record<string, unknown>);
					} else
						request.reject(
							new ToolFailure(
								`${String(message.command)}: ${String(message.message ?? "adapter rejected request")}`,
								JSON.parse(JSON.stringify(message.body ?? {})),
							),
						);
				} else if (message.type === "request") {
					this.send({
						type: "response",
						request_seq: message.seq,
						command: message.command,
						success: false,
						message:
							"Client does not support reverse requests; use internalConsole and a directly launched adapter.",
					});
				}
			}
		} catch (error) {
			this.fail(`DAP protocol failed: ${errorText(error)}`);
			void this.stop();
		}
	}
	request(
		command: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<Record<string, unknown>> {
		if (signal?.aborted) return Promise.reject(new ToolFailure(`Debugger ${command} cancelled.`));
		if (this.exited)
			return Promise.reject(new ToolFailure(`Debug adapter is no longer running. ${this.stderr}`));
		const deferred = Promise.withResolvers<Record<string, unknown>>();
		const id = this.sequence + 1;
		const abort = () => {
			const request = this.pending.get(id);
			if (!request) return;
			this.pending.delete(id);
			request.cleanup();
			request.reject(
				new ToolFailure(`Debugger ${command} cancelled; request effects may already have occurred.`),
			);
		};
		const timer = setTimeout(() => {
			this.pending.delete(id);
			signal?.removeEventListener("abort", abort);
			deferred.reject(
				new ToolFailure(`Debugger ${command} timed out; request effects may already have occurred.`),
			);
		}, timeoutMs);
		this.pending.set(id, {
			command,
			resolve: deferred.resolve,
			reject: deferred.reject,
			cleanup: () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			},
		});
		signal?.addEventListener("abort", abort, { once: true });
		try {
			// Once attach is sent, timeout/cancellation cannot establish whether it took effect.
			if (command === "attach") this.attached = true;
			this.send({ type: "request", command, arguments: args });
		} catch (error) {
			this.pending.get(id)?.cleanup();
			this.pending.delete(id);
			deferred.reject(new ToolFailure(errorText(error)));
		}
		return deferred.promise;
	}
	readEvents(after: number): DapEventBatch {
		return {
			events: this.events.filter((entry) => entry.cursor > after),
			cursor: this.eventCursor,
			lost: after < (this.events[0]?.cursor ?? 1) - 1,
			adapterAlive: this.adapterAlive,
			sessionState: this.sessionState,
			artifact: this.artifact,
		};
	}
	async waitEvents(after: number, timeoutMs: number, signal?: AbortSignal, names?: string[]): Promise<void> {
		const matches = () =>
			this.events.some((event) => event.cursor > after && (!names || names.includes(event.event)));
		if (matches() || this.exited || signal?.aborted) return;
		const deferred = Promise.withResolvers<void>();
		const wake = () => {
			if (matches() || this.exited || signal?.aborted) deferred.resolve();
		};
		this.wake.add(wake);
		signal?.addEventListener("abort", wake, { once: true });
		const timer = setTimeout(deferred.resolve, timeoutMs);
		try {
			await deferred.promise;
		} finally {
			clearTimeout(timer);
			this.wake.delete(wake);
			signal?.removeEventListener("abort", wake);
		}
	}
	async stop(): Promise<boolean> {
		if (this.stopping) return this.stopping;
		this.stopping = (async () => {
			if (this.attached) {
				try {
					// Cleanup must not reuse the cancelled action's signal.
					await this.request("disconnect", { restart: false, terminateDebuggee: false }, undefined, 3000);
				} catch (error) {
					this.record("detach_unconfirmed", { error: errorText(error), adapterPreserved: true });
					return false;
				}
			}
			const confirmed = await this.process.terminate();
			this.fail(
				`Debug adapter stopped. Process-tree termination ${confirmed ? "confirmed" : "NOT confirmed"}.`,
			);
			return confirmed;
		})();
		try {
			const confirmed = await this.stopping;
			if (!confirmed) this.stopping = undefined;
			return confirmed;
		} catch (error) {
			this.stopping = undefined;
			throw error;
		}
	}
}
