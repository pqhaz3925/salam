import { join } from "node:path";
import type { Arguments, HarnessTool, ToolContext, ToolOutput } from "../contracts.ts";
import { DapClient, type DapEvent, type DapEventBatch } from "./dap-client.ts";
import { argBool, argInt, argOptionalString, argString, errorText, ToolFailure } from "./util.ts";
import { defineTool, type ToolEnvironment, type Workspace } from "./workspace.ts";

interface DebugSession {
	client: DapClient;
	mode: "launch" | "attach";
	adapter: string;
	delivered: number;
}

/** Adapter-internal service events that carry no program or debug-state information. */
const SERVICE_EVENTS: Record<string, true> = { debugpySockets: true, debugpyWaitingForServer: true };

/** Hidden by default; `verbose` exposes them. Program output (stdout/stderr/console/important) and unknown events stay visible. */
function isServiceEvent(entry: DapEvent): boolean {
	if (Object.hasOwn(SERVICE_EVENTS, entry.event)) return true;
	if (entry.event !== "output") return false;
	const body = entry.body as { category?: unknown } | undefined;
	return body?.category === "telemetry";
}

function visibleEvents(events: DapEventBatch, verbose: boolean) {
	if (verbose) return events;
	const visible = events.events.filter((entry) => !isServiceEvent(entry));
	const hidden = events.events.length - visible.length;
	return hidden ? { ...events, events: visible, hiddenServiceEvents: hidden } : events;
}

export function createDebugTools(environment: ToolEnvironment): {
	tools: HarnessTool[];
	close(): Promise<void>;
} {
	const sessions = new Map<string, DebugSession>();
	const starting = new Set<string>();
	let closed = false;
	async function adapterCommand(
		args: Arguments,
		workspace: Workspace,
		context: ToolContext,
	): Promise<{ command: string[]; adapter: string }> {
		if (args.adapter_command !== undefined) {
			if (
				!Array.isArray(args.adapter_command) ||
				!args.adapter_command.length ||
				args.adapter_command.some((part) => typeof part !== "string" || part.length === 0)
			)
				throw new ToolFailure("adapter_command must be a nonempty string array (stdio DAP adapter argv).");
			return {
				command: args.adapter_command as string[],
				adapter: argOptionalString(args, "adapter") ?? "custom",
			};
		}
		const adapter = argString(args, "adapter", "debugpy");
		if (adapter === "debugpy") {
			const managedPython = join(environment.config.home, "adapters", "debugpy", "bin", "python");
			const python =
				!workspace.isRemote && (await Bun.file(managedPython).exists())
					? managedPython
					: await workspace.requireBinary(
							"python3",
							"Python debugging (install debugpy in that interpreter or supply adapter_command)",
							context.signal,
						);
			const check = await workspace.executor.exec([python, "-c", "import debugpy"], {
				cwd: workspace.base(context.cwd),
				signal: context.signal,
				timeoutMs: 10_000,
				maxCaptureBytes: 4000,
			});
			if (check.code !== 0)
				throw new ToolFailure(
					`debugpy is unavailable in ${python} on ${workspace.label}. Install debugpy into that interpreter (prefer a dedicated venv), then supply adapter_command: ["/path/to/venv/bin/python","-m","debugpy.adapter"]. No packages are installed automatically.\n${check.stderr}`,
				);
			return { adapter, command: [python, "-m", "debugpy.adapter"] };
		}
		if (adapter === "lldb-dap")
			return {
				adapter,
				command: [
					await workspace.requireBinary(
						"lldb-dap",
						"native DAP debugging (install LLVM with lldb-dap, or supply adapter_command)",
						context.signal,
					),
				],
			};
		throw new ToolFailure(
			"adapter must be debugpy or lldb-dap, or provide adapter_command for another stdio DAP adapter.",
		);
	}
	async function render(
		session: DebugSession,
		result: Record<string, unknown>,
		context: ToolContext,
		after: number,
		verbose: boolean,
	): Promise<ToolOutput> {
		const events = visibleEvents(session.client.readEvents(after), verbose);
		session.delivered = events.cursor;
		const payload = { ...result, ...events };
		const bounded = await environment.artifacts.bound(JSON.stringify(payload, null, 2), {
			sessionId: context.sessionId,
			label: "debug",
			maxChars: 48_000,
		});
		return {
			text: bounded.text,
			details: {
				cursor: events.cursor,
				lost: events.lost,
				adapterAlive: events.adapterAlive,
				sessionState: events.sessionState,
				artifact: events.artifact,
			},
		};
	}
	const tool = defineTool({
		name: "debug",
		description:
			"Status fields are separate: adapterAlive describes the adapter connection; sessionState describes the observed debug session (initializing, running, stopped, exited, terminated, or disconnected). terminated can coexist with a live adapter, and does not establish an attached target's lifetime after detach. " +
			"Real Debug Adapter Protocol sessions on the workspace host, scoped to session/agent/workspace. launch/attach selects debugpy (Python) or lldb-dap (native), or adapter_command argv for any stdio adapter. launch accepts program, args, optional configuration and breakpoints [{path,lines}]; configuration is native DAP launch/attach arguments (e.g. attach connect:{host,port}, processId, pathMappings). Uses internalConsole, not an external terminal. Breakpoint lines are 1-based; DAP responses report verification. Inspect events for observed stopped/terminated, then threads -> stack_trace -> scopes -> variables. continue/step/pause can return before a stop; events with wait_ms waits for later events. Every response includes cursor/lost and full recoverable event journal. Adapter service events (telemetry output, debugpySockets) are omitted and counted as hiddenServiceEvents; verbose:true shows them, including replay with cursor. timeout/cancellation may have already affected the target; cancellation attempts safe adapter cleanup. terminate terminates launched targets but only detaches attached targets. Attach cleanup requires confirmed disconnect before killing the adapter; failed detach preserves it for a later terminate retry. Arbitrary evaluation/debuggee writes are executable-code effects, not checkpointed file tools.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"launch",
						"attach",
						"set_breakpoints",
						"set_function_breakpoints",
						"set_exception_breakpoints",
						"continue",
						"step_over",
						"step_in",
						"step_out",
						"pause",
						"threads",
						"stack_trace",
						"scopes",
						"variables",
						"evaluate",
						"events",
						"terminate",
						"sessions",
					],
				},
				adapter: { type: "string" },
				adapter_command: { type: "array", items: { type: "string" }, minItems: 1 },
				program: { type: "string" },
				args: { type: "array", items: { type: "string" } },
				configuration: { type: "object", additionalProperties: true },
				breakpoints: {
					type: "array",
					items: {
						type: "object",
						properties: {
							path: { type: "string" },
							lines: { type: "array", items: { type: "integer", minimum: 1 } },
						},
						required: ["path", "lines"],
						additionalProperties: false,
					},
				},
				path: { type: "string" },
				lines: { type: "array", items: { type: "integer", minimum: 1 } },
				functions: { type: "array", items: { type: "string" } },
				filters: { type: "array", items: { type: "string" } },
				thread_id: { type: "integer", minimum: 0 },
				frame_id: { type: "integer", minimum: 0 },
				variables_reference: { type: "integer", minimum: 0 },
				expression: { type: "string" },
				context: { type: "string", enum: ["watch", "repl", "hover", "clipboard", "variables"] },
				start: { type: "integer", minimum: 0 },
				count: { type: "integer", minimum: 1, maximum: 1000 },
				cursor: { type: "integer", minimum: 0 },
				wait_ms: { type: "integer", minimum: 0, maximum: 30_000 },
				timeout: { type: "integer", minimum: 1, maximum: 300 },
				verbose: { type: "boolean" },
			},
			required: ["action"],
			additionalProperties: false,
		},
		async run(args, context) {
			if (closed) throw new ToolFailure("Debugger service is closed.");
			const workspace = environment.workspace(context);
			const cwd = workspace.base(context.cwd);
			const key = JSON.stringify([context.sessionId, context.agentId, workspace.id, cwd]);
			const action = argString(args, "action");
			const timeoutMs = argInt(args, "timeout", 30, 1, 300) * 1000;
			let session = sessions.get(key);
			if (action === "sessions")
				return {
					text: JSON.stringify(
						session
							? {
									adapter: session.adapter,
									mode: session.mode,
									...visibleEvents(
										session.client.readEvents(session.delivered),
										argBool(args, "verbose", false),
									),
								}
							: { session: null },
					),
				};
			if (action === "launch" || action === "attach") {
				if (starting.has(key)) throw new ToolFailure("Debugger startup is already in progress.");
				if (session?.client.adapterAlive)
					throw new ToolFailure("A debugger already exists in this scope. Terminate it first.");
				starting.add(key);
				let client: DapClient | undefined;
				try {
					if (session && !(await session.client.stop()))
						throw new ToolFailure(
							"Previous debugger process-tree termination is unconfirmed; refusing a replacement.",
						);
					const selected = await adapterCommand(args, workspace, context);
					const configuration = args.configuration ?? {};
					if (!configuration || typeof configuration !== "object" || Array.isArray(configuration))
						throw new ToolFailure("configuration must be an object.");
					const config: Record<string, unknown> = { cwd, ...configuration, console: "internalConsole" };
					if (args.program !== undefined)
						config.program = workspace.resolvePath(context.cwd, argString(args, "program"));
					if (args.args !== undefined) config.args = args.args;
					if (action === "launch" && !config.program && !config.module && !config.code)
						throw new ToolFailure("launch requires program (or configuration.module/code for Python).");
					const artifact = await environment.artifacts.store(context.sessionId, "debug-events", "");
					if (closed || context.signal.aborted) throw new ToolFailure("Debugger startup cancelled.");
					const process = workspace.executor.startProtocolProcess(selected.command, {
						cwd,
						processGroup: true,
					});
					try {
						client = new DapClient(process, artifact.uri, artifact.path);
					} catch (error) {
						await process.terminate();
						throw error;
					}
					session = { client, mode: action, adapter: selected.adapter, delivered: 0 };
					sessions.set(key, session);
					const cursor = client.cursor;
					client.capabilities = await client.request(
						"initialize",
						{
							clientID: "salam",
							clientName: "Salam",
							adapterID: selected.adapter,
							pathFormat: "path",
							linesStartAt1: true,
							columnsStartAt1: true,
							supportsVariableType: true,
							supportsVariablePaging: true,
							supportsRunInTerminalRequest: false,
						},
						context.signal,
						timeoutMs,
					);
					const launch = client.request(action, config, context.signal, timeoutMs);
					const launchFailure = Promise.withResolvers<void>();
					void launch.catch(launchFailure.reject);
					await Promise.race([
						client.waitEvents(cursor, timeoutMs, context.signal, ["initialized"]),
						launchFailure.promise,
					]);
					if (!client.readEvents(cursor).events.some((event) => event.event === "initialized"))
						throw new ToolFailure(
							"Adapter did not emit initialized; no debug session readiness was inferred.",
						);
					const initial = args.breakpoints ?? [];
					if (!Array.isArray(initial)) throw new ToolFailure("breakpoints must be an array.");
					const breakpointResults: Record<string, unknown>[] = [];
					for (const entry of initial) {
						if (
							!entry ||
							typeof entry.path !== "string" ||
							!Array.isArray(entry.lines) ||
							entry.lines.some((line: unknown) => !Number.isInteger(line) || Number(line) < 1)
						)
							throw new ToolFailure("Each breakpoint entry requires path and positive integer lines.");
						breakpointResults.push(
							await client.request(
								"setBreakpoints",
								{
									source: { path: workspace.resolvePath(context.cwd, entry.path) },
									breakpoints: entry.lines.map((line: number) => ({ line })),
								},
								context.signal,
								timeoutMs,
							),
						);
					}
					if (client.capabilities.supportsConfigurationDoneRequest)
						await client.request("configurationDone", {}, context.signal, timeoutMs);
					const response = await launch;
					await client.waitEvents(cursor, argInt(args, "wait_ms", 1000, 0, 30_000), context.signal, [
						"stopped",
						"terminated",
					]);
					if (context.signal.aborted) throw new ToolFailure("Debugger startup cancelled.");
					return await render(
						session,
						{ response, breakpoints: breakpointResults, capabilities: client.capabilities },
						context,
						0,
						argBool(args, "verbose", false),
					);
				} catch (error) {
					const confirmed = client ? await client.stop() : true;
					return {
						text: `${errorText(error)}\nDebugger startup failed; adapter process-tree termination ${confirmed ? "confirmed" : "NOT confirmed"}.${client ? ` Event journal: ${client.artifact}` : ""}`,
						isError: true,
					};
				} finally {
					starting.delete(key);
				}
			}
			if (!session)
				throw new ToolFailure("No debugger in this session/agent/workspace. Use launch or attach first.");
			const client = session.client;
			const after = argInt(args, "cursor", session.delivered, 0, Number.MAX_SAFE_INTEGER);
			try {
				if (action === "events") {
					const verbose = argBool(args, "verbose", false);
					const deadline = Date.now() + argInt(args, "wait_ms", 0, 0, 30_000);
					// Hidden service events must not end the wait early with nothing visible to report.
					for (let seen = after; ; seen = client.cursor) {
						await client.waitEvents(seen, Math.max(0, deadline - Date.now()), context.signal);
						const fresh = client.readEvents(seen);
						if (verbose || !fresh.adapterAlive || context.signal.aborted || Date.now() >= deadline) break;
						if (fresh.events.some((entry) => !isServiceEvent(entry))) break;
					}
					if (context.signal.aborted) throw new ToolFailure("Debugger event wait cancelled.");
					return await render(session, {}, context, after, verbose);
				}
				if (action === "terminate") {
					let disconnectError: string | undefined;
					if (client.adapterAlive && session.mode === "launch")
						await client
							.request("disconnect", { restart: false, terminateDebuggee: true }, undefined, timeoutMs)
							.catch((error) => {
								disconnectError = errorText(error);
							});
					const confirmed = await client.stop();
					const result = await render(
						session,
						{
							terminationConfirmed: confirmed,
							attachedTarget:
								session.mode === "attach"
									? confirmed
										? "detach confirmed before adapter termination"
										: "detach or adapter termination unconfirmed; inspect event journal"
									: undefined,
							disconnectError,
						},
						context,
						after,
						argBool(args, "verbose", false),
					);
					return { ...result, isError: !confirmed || Boolean(disconnectError) };
				}
				let command: string;
				let parameters: Record<string, unknown> = {};
				switch (action) {
					case "set_breakpoints": {
						if (
							!Array.isArray(args.lines) ||
							args.lines.some((line) => !Number.isInteger(line) || Number(line) < 1)
						)
							throw new ToolFailure(
								"lines must be an array of positive integers; [] clears the file's breakpoints.",
							);
						command = "setBreakpoints";
						parameters = {
							source: { path: workspace.resolvePath(context.cwd, argString(args, "path")) },
							breakpoints: args.lines.map((line) => ({ line })),
						};
						break;
					}
					case "set_function_breakpoints":
						if (!Array.isArray(args.functions) || args.functions.some((name) => typeof name !== "string"))
							throw new ToolFailure("functions must be a string array.");
						command = "setFunctionBreakpoints";
						parameters = { breakpoints: args.functions.map((name) => ({ name })) };
						break;
					case "set_exception_breakpoints":
						if (!Array.isArray(args.filters) || args.filters.some((filter) => typeof filter !== "string"))
							throw new ToolFailure("filters must be a string array of adapter exception filter IDs.");
						command = "setExceptionBreakpoints";
						parameters = { filters: args.filters };
						break;
					case "continue":
					case "step_over":
					case "step_in":
					case "step_out":
					case "pause":
						command =
							({ step_over: "next", step_in: "stepIn", step_out: "stepOut" } as Record<string, string>)[
								action
							] ?? action;
						if (args.thread_id === undefined)
							throw new ToolFailure("thread_id is required; obtain it from threads or the stopped event.");
						parameters = { threadId: argInt(args, "thread_id", 0, 0, Number.MAX_SAFE_INTEGER) };
						break;
					case "threads":
						command = "threads";
						break;
					case "stack_trace":
						if (args.thread_id === undefined) throw new ToolFailure("thread_id is required.");
						command = "stackTrace";
						parameters = {
							threadId: argInt(args, "thread_id", 0, 0, Number.MAX_SAFE_INTEGER),
							startFrame: argInt(args, "start", 0, 0, Number.MAX_SAFE_INTEGER),
							levels: argInt(args, "count", 20, 1, 1000),
						};
						break;
					case "scopes":
						if (args.frame_id === undefined) throw new ToolFailure("frame_id is required.");
						command = "scopes";
						parameters = { frameId: argInt(args, "frame_id", 0, 0, Number.MAX_SAFE_INTEGER) };
						break;
					case "variables":
						if (args.variables_reference === undefined)
							throw new ToolFailure("variables_reference is required (from scopes or variables).");
						command = "variables";
						parameters = {
							variablesReference: argInt(args, "variables_reference", 0, 0, Number.MAX_SAFE_INTEGER),
							start: argInt(args, "start", 0, 0, Number.MAX_SAFE_INTEGER),
							count: argInt(args, "count", 100, 1, 1000),
						};
						break;
					case "evaluate":
						command = "evaluate";
						parameters = {
							expression: argString(args, "expression"),
							context: argString(args, "context", "repl"),
							...(args.frame_id === undefined
								? {}
								: { frameId: argInt(args, "frame_id", 0, 0, Number.MAX_SAFE_INTEGER) }),
						};
						break;
					default:
						throw new ToolFailure(`Unknown debugger action: ${action}`);
				}
				const cursor = client.cursor;
				const response = await client.request(command, parameters, context.signal, timeoutMs);
				if (["continue", "step_over", "step_in", "step_out", "pause"].includes(action))
					await client.waitEvents(cursor, argInt(args, "wait_ms", 1000, 0, 30_000), context.signal, [
						"stopped",
						"terminated",
					]);
				if (context.signal.aborted) throw new ToolFailure("Debugger interaction cancelled.");
				return await render(session, { response }, context, after, argBool(args, "verbose", false));
			} catch (error) {
				if (context.signal.aborted) {
					const confirmed = await client.stop();
					return {
						text: `Debugger call cancelled; adapter process-tree termination ${confirmed ? "confirmed" : "NOT confirmed"}. Target/request effects are not rolled back. Events: ${client.artifact}`,
						isError: true,
					};
				}
				const result = await render(
					session,
					{
						error: errorText(error),
						...(error instanceof ToolFailure ? { errorDetails: error.details } : {}),
					},
					context,
					after,
					argBool(args, "verbose", false),
				);
				return { ...result, isError: true };
			}
		},
	});
	return {
		tools: [tool],
		async close() {
			closed = true;
			const outcomes = await Promise.all(
				[...sessions].map(async ([key, session]) => {
					const { client, mode } = session;
					if (client.adapterAlive && mode === "launch")
						await client
							.request("disconnect", { restart: false, terminateDebuggee: true }, undefined, 3000)
							.catch(() => undefined);
					const confirmed = await client.stop();
					if (confirmed && sessions.get(key) === session) sessions.delete(key);
					return confirmed;
				}),
			);
			if (outcomes.some((confirmed) => !confirmed))
				throw new ToolFailure(
					"Some debug adapters could not be safely detached/terminated; close may be retried. Attached adapters are not forcibly killed without confirmed detach.",
				);
		},
	};
}
