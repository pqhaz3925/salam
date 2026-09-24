import { Buffer } from "node:buffer";
import { closeSync, openSync, writeSync } from "node:fs";
import type { Arguments, HarnessTool, ToolContext, ToolOutput } from "../contracts.ts";
import type { Executor, ProtocolProcess } from "./exec.ts";
import { JAVASCRIPT_KERNEL, JAVASCRIPT_LAUNCHER, PYTHON_KERNEL } from "./kernel-sources.ts";
import { argBool, argInt, argOptionalString, argString, errorText, ToolFailure } from "./util.ts";
import { defineTool, type ToolEnvironment } from "./workspace.ts";

type Invoker = (name: string, args: Arguments, context: ToolContext) => Promise<ToolOutput>;
interface CellResult {
	error?: string;
	stateLost: boolean;
}
interface Cell {
	id: number;
	accepting: boolean;
	calls: Map<number, { controller: AbortController; settled: Promise<void> }>;
	context: ToolContext;
	resolve: (result: CellResult) => void;
	controller: AbortController;
	preview: string;
	outputBytes: number;
}

/** One real interpreter and one append-only output journal, never a per-cell function scope. */
class Kernel {
	private incoming = "";
	private sequence = 0;
	private readonly ready = Promise.withResolvers<void>();
	private cell?: Cell;
	private fd: number;
	private loss?: string;
	private closing?: Promise<boolean>;
	private readonly child: ProtocolProcess;
	constructor(
		executor: Executor,
		argv: string[],
		cwd: string,
		readonly artifact: string,
		path: string,
		private readonly invoke: () => Invoker | undefined,
	) {
		this.fd = openSync(path, "a");
		try {
			this.child = executor.startProtocolProcess(argv, { cwd, processGroup: true });
		} catch (error) {
			closeSync(this.fd);
			this.fd = -1;
			throw error;
		}
		this.child.child.stdout?.setEncoding("utf8");
		this.child.child.stdout?.on("data", (chunk: string) => this.consume(chunk));
		this.child.child.stderr?.setEncoding("utf8");
		// Raw/native output cannot reliably be attributed across asynchronous cells.
		this.child.child.stderr?.on("data", (chunk: string) => this.output(chunk));
		this.child.child.on("error", (error) => this.fail(`Kernel process failed: ${error.message}`));
		this.child.child.on("close", (code, signal) =>
			this.fail(`Kernel exited (${signal ?? code ?? "unknown"}).`),
		);
		// Startup can fail before the first caller starts awaiting readiness.
		void this.ready.promise.catch(() => undefined);
	}
	get alive(): boolean {
		return this.loss === undefined;
	}
	get busy(): boolean {
		return this.cell !== undefined;
	}
	get stateLoss(): string | undefined {
		return this.loss;
	}

	private output(text: string, origin?: number): void {
		if (this.fd < 0) return;
		try {
			writeSync(this.fd, text);
		} catch (error) {
			void this.stop(`Output journal failed: ${errorText(error)}`);
			return;
		}
		if (this.cell && this.cell.id === origin) {
			this.cell.outputBytes += Buffer.byteLength(text);
			if (this.cell.preview.length < 48_000)
				this.cell.preview += text.slice(0, 48_000 - this.cell.preview.length);
		}
	}
	private consume(chunk: string): void {
		this.incoming += chunk;
		for (;;) {
			const end = this.incoming.indexOf("\n");
			if (end < 0) break;
			if (end > 32 * 1024 * 1024) {
				void this.stop("Kernel protocol frame exceeded 32 MiB.");
				return;
			}
			const line = this.incoming.slice(0, end);
			this.incoming = this.incoming.slice(end + 1);
			try {
				const message = JSON.parse(line) as {
					type: string;
					cell?: number;
					text?: string;
					error?: string;
					id?: number;
					name?: string;
					args?: unknown;
				};
				if (message.type === "ready") this.ready.resolve();
				else if (message.type === "output" && typeof message.text === "string")
					this.output(message.text, message.cell);
				else if (message.type === "done" && this.cell && this.cell.id === message.cell) {
					const cell = this.cell;
					cell.accepting = false;
					cell.controller.abort();
					if (message.error) this.output(`\n${message.error}\n`, cell.id);
					void Promise.allSettled([...cell.calls.values()].map((call) => call.settled)).then(() => {
						cell.resolve({
							error: message.error ? "Cell failed; see output and kernel journal." : undefined,
							stateLost: false,
						});
					});
				} else if (
					message.type === "tool_cancel" &&
					this.cell &&
					this.cell.id === message.cell &&
					message.id !== undefined
				) {
					this.cell.calls.get(message.id)?.controller.abort();
				} else if (message.type === "tool") {
					const cell = this.cell;
					if (
						!cell ||
						cell.id !== message.cell ||
						!cell.accepting ||
						cell.controller.signal.aborted ||
						message.id === undefined
					) {
						this.send({
							type: "tool_result",
							cell: message.cell,
							id: message.id,
							error: "Originating eval cell is no longer active.",
						});
						continue;
					}
					const controller = new AbortController();
					const abort = () => controller.abort();
					cell.controller.signal.addEventListener("abort", abort, { once: true });
					const id = message.id;
					const settled = this.callTool(message, cell, controller.signal)
						.catch((error) => {
							void this.stop(`Tool bridge failed: ${errorText(error)}`);
						})
						.finally(() => {
							cell.controller.signal.removeEventListener("abort", abort);
							cell.calls.delete(id);
						});
					cell.calls.set(id, { controller, settled });
				}
			} catch (error) {
				void this.stop(`Invalid kernel protocol: ${errorText(error)}`);
				return;
			}
		}
		if (this.incoming.length > 32 * 1024 * 1024) void this.stop("Kernel protocol frame exceeded 32 MiB.");
	}
	private async callTool(
		message: { id?: number; name?: string; args?: unknown },
		cell: Cell,
		signal: AbortSignal,
	): Promise<void> {
		try {
			const invoke = this.invoke();
			if (!invoke) throw new ToolFailure("Runtime tool invoker has not been installed.");
			if (signal.aborted) throw new ToolFailure("Eval tool call cancelled.");
			if (!message.name || message.name === "eval")
				throw new ToolFailure("Recursive eval invocation is forbidden.");
			if (!message.args || typeof message.args !== "object" || Array.isArray(message.args))
				throw new ToolFailure("Tool arguments must be an object.");
			const result = await invoke(message.name, message.args as Arguments, { ...cell.context, signal });
			if (result.isError)
				this.send({
					type: "tool_result",
					cell: cell.id,
					id: message.id,
					error: result.text || `Tool ${message.name} failed.`,
					details: result.details,
				});
			else this.send({ type: "tool_result", cell: cell.id, id: message.id, value: result });
		} catch (error) {
			this.send({
				type: "tool_result",
				cell: cell.id,
				id: message.id,
				error: errorText(error),
				...(error instanceof ToolFailure ? { details: error.details } : {}),
			});
		}
	}
	private send(message: unknown): void {
		if (!this.alive || this.child.child.stdin?.destroyed) return;
		this.child.child.stdin?.write(`${JSON.stringify(message)}\n`, (error) => {
			if (error) void this.stop(`Kernel input failed: ${error.message}`);
		});
	}
	private fail(reason: string): void {
		this.loss ??= reason;
		this.ready.reject(new ToolFailure(this.loss));
		this.cell?.controller.abort();
		this.cell?.resolve({ error: this.loss, stateLost: true });
		if (this.fd >= 0) {
			closeSync(this.fd);
			this.fd = -1;
		}
	}
	async stop(reason: string): Promise<boolean> {
		if (this.closing) return this.closing;
		this.fail(reason);
		this.closing = (async () => {
			const confirmed = await this.child.terminate();
			if (this.cell) await Promise.allSettled([...this.cell.calls.values()].map((call) => call.settled));
			return confirmed;
		})();
		try {
			const confirmed = await this.closing;
			if (!confirmed) this.closing = undefined;
			return confirmed;
		} catch (error) {
			this.closing = undefined;
			throw error;
		}
	}
	async run(code: string, context: ToolContext, timeoutMs: number, fresh = false): Promise<ToolOutput> {
		if (this.cell)
			throw new ToolFailure(
				"This language kernel is busy. Wait for its cell, or use reset to cancel it and discard state.",
			);
		const completion = Promise.withResolvers<CellResult>();
		const cell: Cell = {
			id: ++this.sequence,
			accepting: true,
			calls: new Map(),
			context,
			resolve: completion.resolve,
			controller: new AbortController(),
			preview: "",
			outputBytes: 0,
		};
		this.cell = cell;
		const abort = () => {
			void this.stop(
				"Evaluation cancelled; all interpreter bindings were lost. External tool effects are not rolled back.",
			);
		};
		context.signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			void this.stop(
				`Evaluation exceeded ${timeoutMs} ms; all interpreter bindings were lost. External tool effects are not rolled back.`,
			);
		}, timeoutMs);
		try {
			if (context.signal.aborted) abort();
			await this.ready.promise;
			if (this.alive) this.send({ type: "cell", cell: cell.id, code });
			const result = await completion.promise;
			cell.accepting = false;
			cell.controller.abort();
			await Promise.allSettled([...cell.calls.values()].map((call) => call.settled));
			let terminationConfirmed: boolean | undefined;
			if (result.stateLost) terminationConfirmed = await this.stop(result.error ?? "Kernel exited.");
			// A fresh kernel has nothing to preserve: never imply earlier cells' bindings still exist.
			const status = result.stateLost
				? "Kernel state lost."
				: fresh
					? result.error
						? "Fresh kernel: bindings from this cell (before the error) persist for later cells."
						: "Fresh kernel: bindings from this cell persist for later cells."
					: result.error
						? "Kernel bindings preserved (including changes before the error)."
						: "Kernel bindings preserved.";
			return {
				text: `${cell.preview}${result.error ? `\n${result.error}\n` : ""}\n${status}${terminationConfirmed === false ? " WARNING: process-tree termination could not be confirmed." : ""}\nFull kernel output journal: ${this.artifact}${cell.outputBytes > Buffer.byteLength(cell.preview) ? " (cell output truncated above)" : ""}`,
				isError: Boolean(result.error),
				details: {
					stateLost: result.stateLost,
					outputBytes: cell.outputBytes,
					artifact: this.artifact,
					...(terminationConfirmed === undefined ? {} : { terminationConfirmed }),
				},
			};
		} catch (error) {
			const confirmed = await this.stop(`Kernel startup/evaluation failed: ${errorText(error)}`);
			return {
				text: `${cell.preview}${errorText(error)}\nKernel state lost. Process-tree termination ${confirmed ? "confirmed" : "NOT confirmed"}. Output: ${this.artifact}`,
				isError: true,
				details: { stateLost: true, terminationConfirmed: confirmed, artifact: this.artifact },
			};
		} finally {
			cell.accepting = false;
			cell.controller.abort();
			await Promise.allSettled([...cell.calls.values()].map((call) => call.settled));
			clearTimeout(timer);
			context.signal.removeEventListener("abort", abort);
			this.cell = undefined;
		}
	}
}

export function createEvalTools(environment: ToolEnvironment): {
	tools: HarnessTool[];
	close(): Promise<void>;
	setInvoker(invoke: Invoker): void;
} {
	const kernels = new Map<string, Kernel>();
	const starting = new Set<string>();
	let invoker: Invoker | undefined;
	let closed = false;
	const tool = defineTool({
		name: "eval",
		description:
			"Run a persistent JavaScript (Node.js 22+ with python3 protocol launcher) or Python (python3, 3.8+) cell on the current workspace host. Top-level bindings and await persist per session/agent/workspace/language. JS: await tool.read({path:'file'}); Python: await tool.read(path='file'). Tool calls go through Runtime validation/checkpoints; tool failures raise exceptions with text and details. Direct interpreter file/process access is ordinary executable code, not a tracked tool write. display/print/console output is previewed and journaled; native/inherited stdout and stderr are recorded in the full journal without cell attribution. timeout or cancellation destroys the kernel and reports lost state; reset explicitly discards bindings. Recursive eval is forbidden. Kernels are not sandboxes. Background work may append to the journal, but cannot invoke tools after its originating cell finishes. Nested tool cancellation settles before a cell returns.",
		parameters: {
			type: "object",
			properties: {
				language: { type: "string", enum: ["js", "py"] },
				code: { type: "string" },
				reset: {
					type: "boolean",
					description:
						"Discard this language's kernel, including a running cell; optional code starts a fresh kernel.",
				},
				timeout: {
					type: "integer",
					minimum: 1,
					maximum: 3600,
					description: "Cell deadline in seconds, including startup; default 60. A timeout destroys state.",
				},
			},
			required: ["language"],
			additionalProperties: false,
		},
		async run(args, context): Promise<ToolOutput> {
			if (closed) throw new ToolFailure("Evaluation service is closed.");
			const language = argString(args, "language");
			if (language !== "js" && language !== "py") throw new ToolFailure("language must be js or py.");
			const workspace = environment.workspace(context);
			const cwd = workspace.base(context.cwd);
			const key = JSON.stringify([context.sessionId, context.agentId, workspace.id, cwd, language]);
			if (starting.has(key)) throw new ToolFailure("Kernel startup is already in progress.");
			let kernel = kernels.get(key);
			const code = argOptionalString(args, "code");
			let notice = "";
			let fresh = false;
			if (argBool(args, "reset", false)) {
				if (kernel) {
					const confirmed = await kernel.stop("Kernel explicitly reset; all bindings were discarded.");
					if (!confirmed)
						return {
							text: "Kernel state discarded, but process-tree termination was NOT confirmed. A replacement was not started.",
							isError: true,
							details: { stateLost: true, terminationConfirmed: false },
						};
					if (kernels.get(key) === kernel) kernels.delete(key);
				}
				kernel = undefined;
				notice = "Kernel reset; previous bindings discarded.\n";
				if (code === undefined) return { text: notice, details: { stateLost: true, reset: true } };
			}
			if (code === undefined) throw new ToolFailure("code is required unless reset is true.");
			if (kernel && !kernel.alive) {
				const confirmed = await kernel.stop(kernel.stateLoss ?? "Kernel exited.");
				if (!confirmed)
					throw new ToolFailure(
						"Previous kernel termination is unconfirmed; refusing to start a replacement.",
					);
				notice += `Previous kernel state was lost: ${kernel.stateLoss} Starting a fresh kernel.\n`;
				kernel = undefined;
			}
			if (!kernel) {
				if (starting.has(key) || kernels.get(key)?.alive)
					throw new ToolFailure("Kernel changed during reset/startup; retry the cell.");
				starting.add(key);
				try {
					const binary = await workspace.requireBinary(
						language === "js" ? "node" : "python3",
						`${language} evaluation`,
						context.signal,
					);
					const python =
						language === "js"
							? await workspace.requireBinary(
									"python3",
									"isolated JavaScript protocol descriptor",
									context.signal,
								)
							: binary;
					const artifact = await environment.artifacts.store(context.sessionId, `eval-${language}`, "");
					if (closed || context.signal.aborted) throw new ToolFailure("Kernel startup cancelled.");
					kernel = new Kernel(
						workspace.executor,
						language === "js"
							? [python, "-u", "-c", JAVASCRIPT_LAUNCHER, binary, "-e", JAVASCRIPT_KERNEL]
							: [binary, "-u", "-c", PYTHON_KERNEL],
						cwd,
						artifact.uri,
						artifact.path,
						() => invoker,
					);
					kernels.set(key, kernel);
					fresh = true;
					if (!notice)
						notice = `Started a fresh ${language} kernel: no bindings from earlier cells exist (first use here, or salam restarted since).\n`;
				} finally {
					starting.delete(key);
				}
			}
			const result = await kernel.run(code, context, argInt(args, "timeout", 60, 1, 3600) * 1000, fresh);
			return { ...result, text: notice + result.text };
		},
	});
	return {
		tools: [tool],
		setInvoker(invoke) {
			invoker = invoke;
		},
		async close() {
			closed = true;
			const outcomes = await Promise.all(
				[...kernels].map(async ([key, kernel]) => {
					const confirmed = await kernel.stop("Evaluation service closed; kernel state discarded.");
					if (confirmed && kernels.get(key) === kernel) kernels.delete(key);
					return confirmed;
				}),
			);
			if (outcomes.some((confirmed) => !confirmed))
				throw new ToolFailure(
					"Some eval process trees could not be confirmed terminated; close may be retried.",
				);
		},
	};
}
