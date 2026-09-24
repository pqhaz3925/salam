import type { Arguments, HarnessTool, Json, ToolContext, ToolOutput } from "../contracts.ts";
import type { ProcessInfo, ProcessOutput, ReadinessCondition } from "./processes.ts";
import { argBool, argInt, argOptionalString, argString, EmitThrottle, ToolFailure } from "./util.ts";
import { defineTool, displayPath, type ToolEnvironment } from "./workspace.ts";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 900;
/** A background job may outlive any single deadline, so its ceiling is a day. */
const MAX_BACKGROUND_TIMEOUT_SECONDS = 86_400;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 900;
/** Command lines are echoed in listings; long ones are elided there, not stored short. */
const LIST_COMMAND_CHARS = 90;

const readyProperty = {
	type: "object",
	description:
		"Observe readiness, not just process creation. All supplied conditions must pass on the execution host; an early exit is an error.",
	properties: {
		log: {
			type: "string",
			description: "JavaScript regular expression (Unicode flag) matched against retained stdout/stderr.",
		},
		port: {
			type: "integer",
			minimum: 1,
			maximum: 65535,
			description: "TCP port that must accept a connection on the execution host.",
		},
		host: { type: "string", description: "TCP host, default 127.0.0.1, resolved on the execution host." },
		timeout: {
			type: "integer",
			minimum: 1,
			maximum: MAX_WAIT_SECONDS,
			description: "Readiness wait deadline in seconds; default 30. Never kills the process.",
		},
	},
	additionalProperties: false,
};

function readiness(args: Arguments): (ReadinessCondition & { timeout: number }) | undefined {
	if (args.ready === undefined || args.ready === null) return undefined;
	if (typeof args.ready !== "object" || Array.isArray(args.ready))
		throw new ToolFailure("ready must be an object.");
	const ready = args.ready as Arguments;
	const log = argOptionalString(ready, "log");
	const port = ready.port === undefined ? undefined : argInt(ready, "port", 0, 1, 65535);
	if (!log && port === undefined) throw new ToolFailure("ready requires log and/or port.");
	if (log) {
		try {
			new RegExp(log, "u");
		} catch (error) {
			throw new ToolFailure(
				`Invalid readiness regex: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return {
		log,
		port,
		host: argOptionalString(ready, "host"),
		timeout: argInt(ready, "timeout", DEFAULT_WAIT_SECONDS, 1, MAX_WAIT_SECONDS),
	};
}

function durationSince(start: number, end: number | undefined): string {
	const seconds = Math.round(((end ?? Date.now()) - start) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${seconds % 60}s`;
}

function statusLabel(job: ProcessInfo): string {
	if (job.state === "running") return "running";
	if (job.state === "exited") return `exited ${job.exitCode ?? "?"}`;
	return job.state;
}

function jobDetails(job: ProcessInfo): Record<string, Json> {
	return {
		id: job.id,
		command: job.command,
		cwd: job.cwd,
		target: job.target,
		sessionId: job.sessionId,
		agentId: job.agentId,
		state: job.state,
		exitCode: job.exitCode,
		startedAt: job.startedAt,
		endedAt: job.endedAt ?? null,
		interactive: job.interactive ?? false,
		pty: job.pty ?? false,
		...(job.note === undefined ? {} : { note: job.note }),
		...(job.terminationConfirmed === undefined ? {} : { terminationConfirmed: job.terminationConfirmed }),
	};
}

/**
 * Shared shape for every read of a job: a header the model can orient by, the
 * output slice itself, and the cursor to resume from.
 */
function renderOutput(output: ProcessOutput): ToolOutput {
	const job = output.job;
	const header = `${job.id} [${statusLabel(job)}] ${job.target}$ ${job.command}`;
	return {
		text: `${header}\n${output.text.length > 0 ? output.text : "(no output)"}${job.note ? `\n[${job.note}]` : ""}\n[cursor=${output.cursor}; retained_from=${output.retainedFrom}; dropped=${output.dropped} UTF-16 units; truncated=${output.truncated}${output.ready ? "; readiness=observed" : ""}]`,
		isError: job.state === "failed" || (job.state === "exited" && job.exitCode !== 0),
		details: {
			...jobDetails(job),
			cursor: output.cursor,
			truncated: output.truncated,
			retainedFrom: output.retainedFrom,
			dropped: output.dropped,
			...(output.ready === undefined ? {} : { ready: output.ready }),
			...(output.artifact === undefined ? {} : { artifact: output.artifact }),
		},
	};
}

export function createShellTool(environment: ToolEnvironment): HarnessTool {
	return defineTool({
		name: "shell",
		description:
			"Run a shell command in the active workspace. When the session targets a remote host the command runs there, not locally. Output is streamed while it runs and bounded in the result. Prefer `glob`, `grep`, `read` and `edit` over ad-hoc find/grep/cat/sed — they are faster and give better structure.\n" +
			"Set background: true for servers, builds or log tails. Set interactive: true to keep pipe stdin open, or pty: true for a real terminal (REPLs and full-screen programs); these default to background. Use command_send for text/keys/EOF/resize and command_screen for the current terminal screen. Noninteractive stdin is closed after optional stdin text. Readiness requires observed ready.log and/or ready.port. Jobs survive owner crashes via authenticated supervisors and are recovered on restart; normal shutdown stops their process trees. Do not daemonize or escape the managed process group.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Command line to execute, interpreted by the shell." },
				cwd: { type: "string", description: "Directory to run in. Defaults to the working directory." },
				timeout: {
					type: "integer",
					description: `Seconds before the process tree is terminated. Foreground: ${DEFAULT_TIMEOUT_SECONDS} by default, ${MAX_TIMEOUT_SECONDS} at most. Background: no deadline by default; pass a positive value up to ${MAX_BACKGROUND_TIMEOUT_SECONDS} to have it killed on its own.`,
					minimum: 0,
					maximum: MAX_BACKGROUND_TIMEOUT_SECONDS,
				},
				background: {
					type: "boolean",
					description:
						"Start the command and return its id at once instead of waiting for it. Use it for work that outlives this tool call; never for something whose output you need right now.",
				},
				interactive: {
					type: "boolean",
					description: "Keep stdin open after startup. Defaults background to true.",
				},
				pty: {
					type: "boolean",
					description:
						"Allocate a real pseudo-terminal, implies interactive input. stdout and stderr are merged.",
				},
				cols: { type: "integer", minimum: 2, maximum: 500, description: "Terminal columns; default 100." },
				rows: { type: "integer", minimum: 2, maximum: 300, description: "Terminal rows; default 30." },
				stdin: {
					type: "string",
					description: "Initial input. Without interactive/pty, EOF follows immediately.",
				},
				ready: readyProperty,
				description: {
					type: "string",
					description: "Short human-readable summary of what this command does.",
				},
			},
			required: ["command"],
			additionalProperties: false,
		},
		async run(args, context): Promise<ToolOutput> {
			const command = argString(args, "command");
			if (command.trim().length === 0) throw new ToolFailure("`command` is empty.");
			const pty = argBool(args, "pty", false);
			const interactive = argBool(args, "interactive", false) || pty;
			const background = argBool(args, "background", interactive);
			const ready = readiness(args);
			if (ready && !background) throw new ToolFailure("ready requires background: true.");
			const execution = {
				interactive,
				pty,
				cols: argInt(args, "cols", 100, 2, 500),
				rows: argInt(args, "rows", 30, 2, 300),
				stdin: argOptionalString(args, "stdin"),
			};
			const timeoutSeconds = background
				? argInt(args, "timeout", 0, 0, MAX_BACKGROUND_TIMEOUT_SECONDS)
				: argInt(args, "timeout", DEFAULT_TIMEOUT_SECONDS, 0, MAX_TIMEOUT_SECONDS);
			const workspace = environment.workspace(context);
			const cwd = workspace.resolvePath(context.cwd, argOptionalString(args, "cwd") ?? ".");

			// A remote non-interactive shell does not read the user's profile, so the
			// remote side runs a login shell to pick up their real PATH. Locally the
			// harness already inherits the user's environment.
			const shell = (await workspace.executor.which("bash", context.signal)) ?? "/bin/sh";
			const shellFlag = workspace.isRemote && shell.endsWith("bash") ? "-lc" : "-c";
			const base = workspace.base(context.cwd);
			const header = `${workspace.isRemote ? `${workspace.label}:` : ""}${displayPath(base, cwd)}$ ${command}`;

			if (background) {
				// Started against the workspace executor captured here, with no signal
				// attached: the job belongs to the registry from this point on, not to
				// the tool call, and nothing it prints reaches the conversation unasked.
				const job = environment.processes.start({
					executor: workspace.executor,
					argv: [shell, shellFlag, command],
					command,
					cwd,
					target: workspace.label,
					sessionId: context.sessionId,
					agentId: context.agentId,
					timeoutMs: timeoutSeconds * 1000,
					...execution,
				});
				if (ready) {
					try {
						return renderOutput(
							await environment.processes.waitReady(job.id, ready, ready.timeout * 1000, context.signal),
						);
					} catch (error) {
						throw new ToolFailure(
							`${error instanceof Error ? error.message : String(error)} The managed command is ${job.id}; inspect or stop it with command_output/command_stop.`,
						);
					}
				}
				const deadline = timeoutSeconds > 0 ? `, deadline ${timeoutSeconds}s` : "";
				return {
					text: `${header}\n[started in the background on ${job.target} as ${job.id}${deadline}]\nRead it with command_output ${job.id}, block on it with command_wait ${job.id}, end it with command_stop ${job.id}.`,
					details: { ...jobDetails(job), background: true },
				};
			}

			// Started through the registry so the user can promote it mid-run: the
			// same process then becomes a background job, keeping its output.
			const keepDeadline = args.timeout !== undefined && args.timeout !== null;
			const stream = new EmitThrottle(context.emit);
			const outcome = await environment.processes.run({
				executor: workspace.executor,
				argv: [shell, shellFlag, command],
				command,
				cwd,
				target: workspace.label,
				sessionId: context.sessionId,
				agentId: context.agentId,
				timeoutMs: timeoutSeconds * 1000,
				...execution,
				keepDeadline,
				signal: context.signal,
				onOutput: (chunk) => stream.push(chunk),
			});
			stream.close();
			if (outcome.promoted) {
				// Everything printed so far, and the cursor after it: the model never
				// saw the live stream, and reading on from here repeats nothing.
				const output = await environment.processes.read(outcome.job.id);
				const job = output.job;
				const state =
					job.state === "running"
						? `still running${keepDeadline ? `, deadline ${timeoutSeconds}s from its start` : ""}`
						: (job.note ?? statusLabel(job));
				return {
					text: `${header}\n${output.text.length > 0 ? output.text : "(no output yet)"}\n[moved to the background on ${job.target} by the user as ${job.id}; ${state}]\nContinue with command_output ${job.id} cursor ${output.cursor}, block on it with command_wait ${job.id} cursor ${output.cursor}, end it with command_stop ${job.id}.`,
					details: {
						...jobDetails(job),
						background: true,
						promoted: true,
						cursor: output.cursor,
						truncated: output.truncated,
						...(output.artifact === undefined ? {} : { artifact: output.artifact }),
					},
				};
			}
			const result = outcome.result;

			const sections: string[] = [];
			if (result.stdout.length > 0) sections.push(result.stdout.replace(/\n$/, ""));
			if (result.stderr.length > 0) sections.push(`[stderr]\n${result.stderr.replace(/\n$/, "")}`);
			if (result.droppedStdoutBytes > 0) {
				sections.push(
					`[${result.droppedStdoutBytes} bytes of output discarded: the command produced more than the capture ceiling]`,
				);
			}
			const body = sections.join("\n") || "(no output)";
			const bounded = await environment.artifacts.bound(body, {
				sessionId: context.sessionId,
				label: "shell",
			});

			const status =
				result.terminationConfirmed === false
					? `ended, but process-group cleanup on ${workspace.label} could not be confirmed`
					: result.timedOut
						? `timed out after ${timeoutSeconds}s and the process tree was terminated`
						: result.aborted
							? "was interrupted and the process tree was terminated"
							: result.spawnError
								? `could not start: ${result.spawnError}`
								: result.code === 0
									? undefined
									: `exited with ${result.code}${result.signal ? ` (${result.signal})` : ""}`;

			const failed = status !== undefined;
			return {
				text: `${header}\n${bounded.text}${failed ? `\n[command ${status}]` : ""}`,
				isError: failed,
				details: {
					workspace: workspace.label,
					cwd,
					exitCode: result.code,
					signal: result.signal,
					timedOut: result.timedOut,
					aborted: result.aborted,
					...(result.terminationConfirmed === undefined
						? {}
						: { terminationConfirmed: result.terminationConfirmed }),
					truncated: bounded.clipped,
					...(bounded.artifact ? { artifact: bounded.artifact } : {}),
				},
			};
		},
	});
}

/**
 * The control surface for `shell` with `background: true`. Kept beside the shell
 * tool because they are one feature: a command the agent starts, leaves running,
 * and comes back to.
 */
export function createProcessTools(environment: ToolEnvironment): HarnessTool[] {
	const processes = environment.processes;
	const idProperty = {
		type: "string",
		description: "Command id returned by `shell` with `background: true`.",
	};
	const cursorProperty = {
		type: "integer",
		description:
			"Pass the exact cursor returned by a previous read (UTF-16 offset, not byte count); do not estimate it. Omit to read all retained output.",
		minimum: 0,
	};
	/**
	 * Ids are addressable only inside the session that started them, so one
	 * session can never read or kill another's work by guessing an id.
	 */
	const owned = (id: string, context: ToolContext): ProcessInfo => {
		const wanted = id.trim();
		const job = processes.list().find((entry) => entry.id === wanted);
		if (job === undefined || job.sessionId !== context.sessionId) {
			throw new ToolFailure(
				`No background command with id \`${wanted}\` in this session. Use command_list to see the current ones.`,
			);
		}
		return job;
	};

	return [
		defineTool({
			name: "command_list",
			description:
				"List the background commands started in this session, with their state, exit code and age. Finished commands stay listed so their output can still be read.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			async run(_args, context): Promise<ToolOutput> {
				const jobs = processes.list().filter((job) => job.sessionId === context.sessionId);
				if (jobs.length === 0) {
					return { text: "No background commands in this session.", details: { jobs: [] } };
				}
				const rows = jobs.map((job) => {
					const line =
						job.command.length > LIST_COMMAND_CHARS
							? `${job.command.slice(0, LIST_COMMAND_CHARS - 1)}…`
							: job.command;
					return `${job.id}  ${statusLabel(job).padEnd(12)}  ${durationSince(job.startedAt, job.endedAt).padStart(6)}  ${job.target}$ ${line.replaceAll("\n", " ")}`;
				});
				return {
					text: `${jobs.length} background command${jobs.length === 1 ? "" : "s"}:\n${rows.join("\n")}`,
					details: { jobs: jobs.map(jobDetails) },
				};
			},
		}),
		defineTool({
			name: "command_output",
			description:
				"Read output from a background command without waiting for it. Returns everything since `cursor` plus a new cursor, so repeated calls never repeat output. Output is retained in a bounded buffer: if the command floods it, the oldest output is dropped and the result says so.",
			parameters: {
				type: "object",
				properties: { id: idProperty, cursor: cursorProperty },
				required: ["id"],
				additionalProperties: false,
			},
			async run(args, context): Promise<ToolOutput> {
				const job = owned(argString(args, "id"), context);
				const cursor = argInt(args, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
				return renderOutput(await processes.read(job.id, cursor));
			},
		}),
		defineTool({
			name: "command_wait",
			description:
				"Wait for a background command to finish, up to timeout seconds, then return output from cursor. Supply ready.log and/or ready.port to wait for observed readiness instead; log matches only output at or after cursor, all conditions must pass, and an early exit or readiness timeout is an error. Waiting never kills the command. Use command_stop to end it.",
			parameters: {
				type: "object",
				properties: {
					id: idProperty,
					timeout: {
						type: "integer",
						description: `Seconds to wait before returning regardless. Defaults to ${DEFAULT_WAIT_SECONDS}.`,
						minimum: 1,
						maximum: MAX_WAIT_SECONDS,
					},
					cursor: cursorProperty,
					ready: readyProperty,
				},
				required: ["id"],
				additionalProperties: false,
			},
			async run(args, context): Promise<ToolOutput> {
				const job = owned(argString(args, "id"), context);
				const cursor = argInt(args, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
				const seconds = argInt(args, "timeout", DEFAULT_WAIT_SECONDS, 1, MAX_WAIT_SECONDS);
				const ready = readiness(args);
				return renderOutput(
					ready
						? await processes.waitReady(
								job.id,
								ready,
								(args.timeout === undefined ? ready.timeout : seconds) * 1000,
								context.signal,
								cursor,
							)
						: await processes.wait(job.id, seconds * 1000, context.signal, cursor),
				);
			},
		}),
		defineTool({
			name: "command_stop",
			description:
				"Terminate a background command and its whole process tree, then return its final output. Reports the command as stopped only when its exit was observed — on a remote host an unconfirmed kill is reported as such instead of assumed.",
			parameters: {
				type: "object",
				properties: { id: idProperty, cursor: cursorProperty },
				required: ["id"],
				additionalProperties: false,
			},
			async run(args, context): Promise<ToolOutput> {
				const job = owned(argString(args, "id"), context);
				const cursor = argInt(args, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
				return renderOutput(await processes.stop(job.id, cursor));
			},
		}),
		defineTool({
			name: "command_send",
			description:
				'Send text, named keys, EOF and/or a terminal resize to an owned interactive command. Text is literal (no implicit newline); keys:["ENTER"] submits LF on pipes or CR on PTYs. EOF closes a pipe or sends terminal Ctrl+D. Resize requires both cols and rows. Returns output with an exact resume cursor; input processing may continue afterwards.',
			parameters: {
				type: "object",
				properties: {
					id: idProperty,
					cursor: cursorProperty,
					text: { type: "string" },
					keys: {
						type: "array",
						items: { type: "string" },
						description:
							"ENTER, TAB, ESCAPE, BACKSPACE, DELETE, arrows, HOME/END, PAGEUP/PAGEDOWN, F1–F12 or CTRL_A–CTRL_Z.",
					},
					eof: { type: "boolean" },
					cols: { type: "integer", minimum: 2, maximum: 500 },
					rows: { type: "integer", minimum: 2, maximum: 300 },
				},
				required: ["id"],
				additionalProperties: false,
			},
			async run(args, context): Promise<ToolOutput> {
				const job = owned(argString(args, "id"), context);
				if (
					args.keys !== undefined &&
					(!Array.isArray(args.keys) || args.keys.some((key) => typeof key !== "string"))
				)
					throw new ToolFailure("keys must be an array of strings.");
				if (
					args.text === undefined &&
					args.keys === undefined &&
					args.eof !== true &&
					args.cols === undefined &&
					args.rows === undefined
				)
					throw new ToolFailure("Provide text, keys, eof or terminal dimensions.");
				return renderOutput(
					await processes.send(
						job.id,
						{
							text: argOptionalString(args, "text"),
							keys: args.keys as string[] | undefined,
							eof: argBool(args, "eof", false),
							cols: args.cols === undefined ? undefined : argInt(args, "cols", 100, 2, 500),
							rows: args.rows === undefined ? undefined : argInt(args, "rows", 30, 2, 300),
						},
						argInt(args, "cursor", 0, 0, Number.MAX_SAFE_INTEGER),
					),
				);
			},
		}),
		defineTool({
			name: "command_screen",
			description:
				"Inspect the current cell screen of a PTY command, not its historical ANSI output. Preserves cursor positioning, alternate-screen state, erase/scroll operations and terminal dimensions. Use command_output for the loss-aware historical stream.",
			parameters: {
				type: "object",
				properties: { id: idProperty },
				required: ["id"],
				additionalProperties: false,
			},
			async run(args, context): Promise<ToolOutput> {
				const job = owned(argString(args, "id"), context);
				const screen = await processes.screen(job.id);
				return {
					text: `${job.id} [${statusLabel(job)}] terminal ${screen.cols}x${screen.rows}; cursor=${screen.cursorX + 1},${screen.cursorY + 1}; alternate=${screen.alternate}\n${screen.text}`,
					details: { ...jobDetails(job), ...screen },
				};
			},
		}),
	];
}
