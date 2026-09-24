import type { Arguments, HarnessTool, Json, ToolContext, ToolOutput } from "../contracts.ts";
import type { BoundedText } from "./artifacts.ts";
import { reportExternalChanges } from "./fs.ts";
import type { ProcessInfo, ProcessOutput, ReadinessCondition, WatchEvent } from "./processes.ts";
import { SeenFileChanges } from "./shell-changes.ts";
import { classifyShell } from "./shell-kind.ts";
import { GREP_VALUE_FLAGS, words } from "./shell-words.ts";
import { SYNTAX_ERRORS, syntaxRegressions } from "./syntax-check.ts";
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

/** A single foreground `sleep` at or above this is refused as a wait. */
const SLEEP_REFUSAL_SECONDS = 10;
const SLEEP_UNITS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * The longest literal `sleep` duration in a command line, in seconds (0 when
 * there is none). `sleep 1m 30s` sums its operands as coreutils does.
 */
export function longestSleep(command: string): number {
	let longest = 0;
	for (const match of command.matchAll(
		/(?:^|[\s;&|(`{]|\$\()sleep((?:\s+(?:\d+(?:\.\d+)?|\.\d+)[smhd]?)+)(?=$|[\s;&|)`}])/g,
	)) {
		let total = 0;
		for (const operand of match[1]!.trim().split(/\s+/)) {
			const parsed = /^(\d*\.?\d+)([smhd]?)$/.exec(operand);
			if (parsed) total += Number(parsed[1]) * SLEEP_UNITS[parsed[2]!]!;
		}
		longest = Math.max(longest, total);
	}
	return longest;
}

const SLEEP_ADVICE =
	"Do not sleep in the shell to wait. Start the work with shell background: true, then either block on it with command_wait (timeout, ready.log/ready.port) or call command_watch, which returns at once and wakes you when a log line matches or the command exits. For an external condition (CI, deploy, remote service), start a background polling command such as `until curl -fsS URL; do sleep 5; done` and watch its exit. If you truly need a plain timer, run `sleep N` with background: true and command_watch it.";

const json = (value: Record<string, string | number>) => JSON.stringify(value);

/**
 * The native tool call a plain file-inspection command maps to, or undefined.
 * Only a single simple command counts (optionally after `cd DIR &&`): any
 * pipe, redirection, chaining or substitution means the shell is doing real
 * work. The native tools number lines, page with offset/limit, report the
 * total length and spill oversized output to a recoverable artifact, so a
 * raw `cat`/`sed -n`/`head` or recursive `grep` only costs context.
 */
export function nativeEquivalent(command: string): string | undefined {
	const line = command.trim().replace(/^cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*&&\s*/, "");
	if (/[|;&<>`\n]|\$\(/.test(line)) return undefined;
	const argv = words(line);
	if (!argv?.length) return undefined;
	const [program, ...rest] = argv;
	const flags = rest.filter((word) => word.startsWith("-"));
	const operands = rest.filter((word) => !word.startsWith("-"));
	switch (program) {
		case "cat":
		case "nl":
		case "less":
		case "more":
			if (operands.length === 0 || flags.some((flag) => !["-n", "-b"].includes(flag))) return undefined;
			return operands.map((path) => `read ${json({ path })}`).join(", ");
		case "head": {
			const count = /^-(?:n)?(\d+)$/.exec(flags.join(""))?.[1] ?? (flags.length ? undefined : "10");
			const numeric = rest[0] === "-n" && /^\d+$/.test(rest[1] ?? "") ? rest[1] : count;
			const paths = rest[0] === "-n" ? rest.slice(2) : operands;
			if (!numeric || paths.length !== 1) return undefined;
			return `read ${json({ path: paths[0]!, limit: Number(numeric) })}`;
		}
		case "tail": {
			if (flags.some((flag) => /^-[fF]/.test(flag)) || operands.length === 0) return undefined;
			const path = operands.at(-1)!;
			return `read ${json({ path })} (its header states the total line count; pass offset to start near the end). For a growing log, use shell background: true with command_output or command_watch`;
		}
		case "sed": {
			if (rest[0] !== "-n" || rest.length !== 3) return undefined;
			const range = /^(\d+)(?:,(\d+))?p$/.exec(rest[1]!);
			if (!range) return undefined;
			const from = Number(range[1]);
			const to = Number(range[2] ?? range[1]);
			return `read ${json({ path: rest[2]!, offset: from, limit: Math.max(1, to - from + 1) })}`;
		}
		case "wc":
			if (flags.join("") !== "-l" || operands.length !== 1) return undefined;
			return `read ${json({ path: operands[0]!, limit: 1 })} (its header states the total line count)`;
		case "grep":
		case "egrep":
		case "rg": {
			// A flag taking a separate value would be misread as the pattern: leave those alone.
			if (operands.length === 0 || flags.some((flag) => GREP_VALUE_FLAGS.has(flag))) return undefined;
			const pattern = operands[0]!;
			if (operands.length > 2) return undefined;
			const path = operands[1] ?? ".";
			const files = flags.some((flag) => /^-[a-zA-Z]*l/.test(flag) || flag === "--files-with-matches");
			return `grep ${json({ pattern, path, ...(files ? { mode: "files" } : {}) })} (context, glob filters, case_sensitive, paging)`;
		}
		case "find": {
			const name = rest.indexOf("-name");
			const iname = rest.indexOf("-iname");
			const at = name >= 0 ? name : iname;
			if (at < 0 || !rest[at + 1]) return undefined;
			const allowed = new Set(["-name", "-iname", "-type", "f", "d", rest[at + 1]!, rest[0]!]);
			if (rest.some((word) => !allowed.has(word))) return undefined;
			const root = rest[0]!.startsWith("-") ? "." : rest[0]!;
			return `glob ${json({ pattern: `**/${rest[at + 1]!}`, path: root })}`;
		}
		default:
			return undefined;
	}
}

/** Human text for one watch event, delivered to the watching session as mail. */
export function describeWatchEvent(event: WatchEvent): string {
	const job = event.job;
	const header = `${job.id} ${job.target}$ ${job.command.length > LIST_COMMAND_CHARS ? `${job.command.slice(0, LIST_COMMAND_CHARS - 1)}…` : job.command}`;
	const resume = `Read on with command_output ${job.id} cursor ${event.cursor}.`;
	if (event.kind === "log") {
		const count = event.lines.length;
		return `[command_watch] ${header}\n${count} line${count === 1 ? "" : "s"} matched /${event.pattern ?? ""}/ (command ${statusLabel(job)}):\n${event.lines.join("\n")}\n${resume}`;
	}
	const ending = `${statusLabel(job)} after ${durationSince(job.startedAt, job.endedAt)}${job.note ? ` (${job.note})` : ""}`;
	const unmatched = event.unmatched ? ` The watched pattern /${event.pattern ?? ""}/ never matched.` : "";
	const tail = event.lines.length ? `\nLast output:\n${event.lines.join("\n")}` : "\n(no output)";
	return `[command_watch] ${header}\nCommand ${ending}.${unmatched}${tail}\n${resume}`;
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

/**
 * `bare` is the shell offered by a restricted tool set (`--lean`): no refusals that point at
 * native read/grep/glob or wait/watch tools the model does not have. With `background` it may
 * still start managed jobs, read and stopped through command_output and command_stop;
 * without it, it runs in the foreground only.
 */
export function createShellTool(
	environment: ToolEnvironment,
	{ bare = false, background: backgroundJobs = false } = {},
): HarnessTool {
	const seen = new SeenFileChanges(environment);
	const full = defineTool({
		name: "shell",
		description:
			"Run a shell command in the active workspace. When the session targets a remote host the command runs there, not locally. Output is streamed while it runs and bounded in the result. Prefer `glob`, `grep`, `read` and `edit` over ad-hoc find/grep/cat/sed — they are faster and give better structure.\n" +
			"Never use `sleep` to wait for something: foreground sleeps of 10s or more are refused; use background + command_wait/command_watch instead.\n" +
			"Never inspect files through the shell: a plain cat, head, tail, sed -n, wc -l, nl, grep/rg or find -name is refused with the exact read/grep/glob call to make instead (read gives numbered lines, the total line count, offset/limit paging and recoverable overflow).\n" +
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
			if (!background) {
				const slept = longestSleep(command);
				if (!bare && slept >= SLEEP_REFUSAL_SECONDS)
					throw new ToolFailure(`Refused: this command sleeps ${slept}s in the foreground. ${SLEEP_ADVICE}`);
				const native = bare ? undefined : nativeEquivalent(command);
				if (native)
					throw new ToolFailure(
						`Refused: use the native tool instead — ${native}. It works on local and remote workspaces, numbers lines, reports the file's total length, pages with offset/limit and keeps oversized output recoverable, so there is no need for wc -l, sed -n, head or cat. Use shell only when the native tool cannot do the job (a device or /proc file, or output that needs a real pipeline).`,
					);
			}
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
					text: `${header}\n[started in the background on ${job.target} as ${job.id}${deadline}]\n${bare ? `Read it with command_output ${job.id}, end it with command_stop ${job.id}.` : `Read it with command_output ${job.id}, block on it with command_wait ${job.id}, get woken on a log line or its exit with command_watch ${job.id}, end it with command_stop ${job.id}.`}`,
					details: { ...jobDetails(job), background: true },
				};
			}

			// Started through the registry so the user can promote it mid-run: the
			// same process then becomes a background job, keeping its output.
			// With background jobs available (--lean), a command outliving its timeout moves to the
			// background instead of being killed: long work and its output survive.
			const promoteOnTimeout = bare && backgroundJobs && timeoutSeconds > 0;
			const keepDeadline = !promoteOnTimeout && args.timeout !== undefined && args.timeout !== null;
			const baseline = await seen.before(context, workspace, bare ? { text: command, cwd } : undefined);
			// Like edit's stale-read guard: a command that may write is not run against a file that
			// changed underneath the agent. Reads, searches, tests and the like still run.
			if (baseline.stale?.length) {
				const parts = classifyShell(command);
				if (!parts || parts.some((part) => MAY_WRITE.has(part.verb)))
					throw new ToolFailure(
						`Refused: ${baseline.stale.map((path) => displayPath(workspace.base(context.cwd), path)).join(", ")} changed on disk since your last command that touched it, and not by you. Read it again (cat, sed -n) before changing it; nothing was run.`,
					);
			}
			const stream = new EmitThrottle(context.emit);
			const outcome = await environment.processes.run({
				executor: workspace.executor,
				argv: [shell, shellFlag, command],
				command,
				cwd,
				target: workspace.label,
				sessionId: context.sessionId,
				agentId: context.agentId,
				timeoutMs: promoteOnTimeout ? 0 : timeoutSeconds * 1000,
				...(promoteOnTimeout ? { promoteAfterMs: timeoutSeconds * 1000 } : {}),
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
					text: `${header}\n${output.text.length > 0 ? output.text : "(no output yet)"}\n[moved to the background on ${job.target} ${outcome.reason === "timeout" ? `after its ${timeoutSeconds}s timeout, instead of being stopped,` : "by the user"} as ${job.id}; ${state}]\nContinue with command_output ${job.id} cursor ${output.cursor}${bare ? "" : `, block on it with command_wait ${job.id} cursor ${output.cursor}`}, end it with command_stop ${job.id}.`,
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
			// Without `read`, the spill is only reachable as a local file (or not at all over SSH).
			const recoverable = (text: BoundedText) =>
				bare && text.artifact
					? text.text.replace(
							`read ${text.artifact}`,
							context.remote ? "a narrower command" : `sed -n or grep on ${text.artifactPath}`,
						)
					: text.text;
			const changes = await seen.after(context, workspace, baseline, bare);
			reportExternalChanges(
				workspace.fs,
				changes.flatMap((change) => (change.record ? [change.record] : [])),
			);
			// The UI draws every diff; the model gets only edits to files that existed before and
			// after, capped per file — a file its own command created or deleted is one line.
			const diff = changes
				.map((change) => change.diff)
				.filter(Boolean)
				.join("");
			const modelDiff = changes
				.filter((change) => change.diff && !change.note)
				.map((change) => capDiff(change.diff, change.shown))
				.join("");
			let changed = "";
			const broken = await syntaxRegressions(
				changes.flatMap((change) => (change.text ? [{ shown: change.shown, ...change.text }] : [])),
			);
			if (broken.length > 0) changed += `\n${SYNTAX_ERRORS} ${broken.join("; ")}]`;
			if (changes.length > 0) {
				const listed = changes.map((change) =>
					change.note ? `${change.shown} (${change.note})` : change.shown,
				);
				const shownDiff = modelDiff
					? await environment.artifacts.bound(modelDiff, {
							sessionId: context.sessionId,
							label: "shell-changes",
						})
					: undefined;
				changed += `\n[files you had seen changed on disk while this command ran: ${listed.join(", ")}]${shownDiff ? `\n${recoverable(shownDiff)}` : ""}`;
				// The model now sees the new content, so a follow-up edit need not re-read it first.
				if (!shownDiff?.clipped)
					for (const change of changes)
						if (change.after)
							environment.freshness.record(
								context,
								workspace.id,
								change.path,
								change.after.hash,
								change.after.size,
							);
			}
			return {
				text: `${header}\n${recoverable(bounded)}${failed ? `\n[command ${status}]` : ""}${changed}`,
				...(diff ? { diff } : {}),
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
	if (!bare) return full;
	const { command, cwd, description } = full.parameters.properties as Record<string, unknown>;
	return {
		...full,
		description: backgroundJobs
			? "Run a shell command in the active workspace. When the session targets a remote host the command runs there, not locally. Output is bounded in the result. Set background: true for servers, watchers and other long-running work: it returns an id at once, command_output reads what it printed and command_stop ends it. Processes left behind by a foreground command are stopped when it exits, so do not use `&` or nohup; use background instead. A foreground command still running at its timeout is moved to the background rather than stopped. Files you name or read are tracked: the result reports what the command changed in them, with any syntax errors it introduced, and a command that may write a file changed on disk since you last touched it is refused until you read it again."
			: "Run a shell command in the active workspace and wait for it to finish. When the session targets a remote host the command runs there, not locally. Output is bounded in the result. Processes left behind by the command are stopped when it exits.",
		parameters: {
			...full.parameters,
			properties: {
				command,
				cwd,
				timeout: {
					type: "integer",
					description: backgroundJobs
						? `Foreground: seconds (${DEFAULT_TIMEOUT_SECONDS} by default, ${MAX_TIMEOUT_SECONDS} at most) before a still-running command moves to the background. Background: seconds before it is stopped; no deadline by default.`
						: `Seconds before the process tree is terminated: ${DEFAULT_TIMEOUT_SECONDS} by default, ${MAX_TIMEOUT_SECONDS} at most.`,
					minimum: 0,
					maximum: backgroundJobs ? MAX_BACKGROUND_TIMEOUT_SECONDS : MAX_TIMEOUT_SECONDS,
				},
				...(backgroundJobs
					? {
							background: {
								type: "boolean",
								description:
									"Start the command and return its id at once instead of waiting for it. Never for something whose output you need right now.",
							},
						}
					: {}),
				stdin: { type: "string", description: "Input written to the command, followed by EOF." },
				description,
			},
		},
	};
}

/** Labels of commands that may change the files they name; unrecognised commands count too. */
const MAY_WRITE = new Set(["Write", "Update", "Delete", "Move", "Copy", "Create"]);

/** Diff lines kept per changed file in the model's copy of a shell command's changes. */
const DIFF_LINES_PER_FILE = 80;

function capDiff(diff: string, shown: string): string {
	const lines = diff.split("\n");
	if (lines.length <= DIFF_LINES_PER_FILE) return diff;
	return `${lines.slice(0, DIFF_LINES_PER_FILE).join("\n")}\n… ${lines.length - DIFF_LINES_PER_FILE} more diff lines for ${shown}\n`;
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
			name: "command_watch",
			description:
				"Watch a background command without blocking: returns at once, and later a message wakes you (or reaches you at your next step) when a complete output line matches `log` and/or when the command ends on its own. Use it instead of sleeping or repeated polling, then carry on with other work or end your turn. `exit` defaults to true; a log watch whose pattern never matched always reports the exit. `repeat` keeps reporting later matching lines, batched at most every 10s. One watch per command: a new call replaces it, cancel: true removes it. Stopping the command yourself reports nothing.",
			parameters: {
				type: "object",
				properties: {
					id: idProperty,
					log: {
						type: "string",
						description:
							"JavaScript regular expression (Unicode flag) tested against each complete output line.",
					},
					exit: {
						type: "boolean",
						description: "Report the command ending on its own. Defaults to true.",
					},
					repeat: {
						type: "boolean",
						description: "Keep reporting later matching lines instead of only the first. Defaults to false.",
					},
					cursor: {
						...cursorProperty,
						description:
							"Only test output at or after this cursor (from a previous read). Omit to include all retained output, so a line printed just before the watch still counts.",
					},
					cancel: { type: "boolean", description: "Remove this command's watch instead of setting one." },
				},
				required: ["id"],
				additionalProperties: false,
			},
			async run(args, context): Promise<ToolOutput> {
				const job = owned(argString(args, "id"), context);
				if (argBool(args, "cancel", false))
					return {
						text: environment.unwatchJob(job.id) ? `Stopped watching ${job.id}.` : `${job.id} had no watch.`,
						details: { ...jobDetails(job), watching: false },
					};
				const log = argOptionalString(args, "log") || undefined;
				const exit = argBool(args, "exit", true);
				const repeat = argBool(args, "repeat", false);
				if (!log && !exit) throw new ToolFailure("Watch for a log pattern and/or the exit.");
				if (repeat && !log) throw new ToolFailure("repeat needs a log pattern.");
				const cursor = argInt(args, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
				if (job.state !== "running") {
					// Nothing left to wait for: answer now rather than with an instant wake-up.
					const rendered = renderOutput(await processes.read(job.id, cursor));
					return { ...rendered, text: `${rendered.text}\n[already ${statusLabel(job)}; no watch was set]` };
				}
				environment.watchJob(job.id, { log, exit, repeat, cursor });
				const what = [
					log ? `${repeat ? "every line" : "the first line"} matching /${log}/` : "",
					exit ? "its exit" : "",
				]
					.filter(Boolean)
					.join(" and ");
				return {
					text: `Watching ${job.id} for ${what}. You will get a message when it happens; continue with other work or end your turn instead of waiting.`,
					details: { ...jobDetails(job), watching: true, log: log ?? null, exit, repeat, cursor },
				};
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
