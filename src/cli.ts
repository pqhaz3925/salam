#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import type { AppController, AppSnapshot } from "./contracts.ts";
import { createIntegrations } from "./integrations/index.ts";
import { createProviderGateway } from "./providers/index.ts";
import { createRuntime, listSessions } from "./runtime/index.ts";
import { createTools } from "./tools/index.ts";
import {
	heldEntries,
	listRecovery,
	parseAge,
	pruneRecovery,
	RECOVERY_LIMIT,
	type RecoveryEntry,
	recoveryRoots,
} from "./tools/recovery-store.ts";
import { startUI } from "./ui/index.tsx";
import { resumeCommand } from "./ui/resume.ts";

const HELP = `salam — a local-first coding harness

Usage:
  salam                            Start the terminal interface
  salam -p "task"                   Run a task and print the result
  salam -p "task" --json            Stream JSON events
  salam --resume ID|latest         Resume a saved conversation (unique prefix accepted)
  salam --model PROVIDER/MODEL     Select the model
  salam models                     List available model choices
  salam auth                       Show credential availability (never tokens)
  salam login PROVIDER             Authorize a subscription
  salam sessions                   List saved conversations
  salam recovery                   List retained file-recovery entries (never pruned automatically)
  salam recovery prune ENTRY...    Remove the named entries (paths or entry-N as listed)
  salam recovery prune --older-than 14d
                                   Remove entries older than an age (m/h/d/w); entries any
                                   process still holds open are skipped unless --force

Options:
  --cwd PATH                      Working directory
  --home PATH                     Private salam state directory (default ~/.salam)
  --config PATH                   Additional configuration JSON
  --remote NAME                   Work on a configured SSH target
  --tools NAME,NAME               Offer only these tools, with a system prompt that names no others
  --lean                          Shell-first set: shell (with background jobs via command_output/
                                  command_stop), web_search, web_fetch, ask, view_image, todo and
                                  goal_complete/goal_pause for /goal, agents_*, history_read/
                                  history_search; auto memory as
                                  plain files through the shell, as in Claude Code; no MCP
  --help, -h                      Show this help
  --version, -v                   Show the version

In the terminal:
  /help  /model  /effort  /title  /sessions  /resume  /new  /agents  /context  /todo
  /rewind  /recap  /usage  /compact  /tools  /remote  /auth  /login  /quit
  /goal  /loop  /jobs  /wait  /output  /kill  /memory
  Enter submits (queues while a turn is running); Shift+Enter or Alt+Enter inserts a newline.
  Ctrl+Enter (or Ctrl+G) interrupts a running turn and sends the new instruction immediately.
  Earlier queued messages are retained before the new instruction.
  Esc or Ctrl+C cancels without auto-restarting; Enter with a new message then continues immediately.
  Esc closes an open menu first. Press Ctrl+C twice while idle to exit.
  Ctrl+B moves a running foreground shell command to the background without restarting it.
  Ctrl+O expands/collapses complete tool output; answers and thinking remain visible.
  Mouse wheel/trackpad scrolls history, including over the composer; PgUp/PgDown also work.
  Scrolling up pauses auto-follow; scrolling to the bottom or Ctrl+End resumes live output.
  Dragging over text selects it and copies it to the system clipboard on release (over SSH via
  OSC 52 when the terminal allows it); Cmd+C copies the selection where the terminal forwards Cmd.
  macOS Terminal.app keeps Cmd+C for its own selection: hold Fn while dragging to select natively.
  Questions from agents appear above the composer while work continues: Up/Down choose, Space
  ticks multi-select options, typing gives your own answer, Enter sends, Esc cancels the question.
  A todo row shows progress and the current item while a plan has unfinished items; /todo lists
  every item (Up/Down/PgUp/PgDown scroll, Esc closes).
  After exit salam prints the exact salam --resume command for the session that was open.

Session controls:
  /effort                         Choose off, low, medium or high; /effort LEVEL sets directly.
  Effort is saved with the session and changes the next request, without resetting history.
  /model                          Choose a model; /model PROVIDER/MODEL switches directly.
  Switching keeps this dialog: each model keeps its own native history and cache prefix,
  and only the events it has not seen yet are appended when you return to it.
  The choice is remembered for new sessions: per directory, else the last one anywhere
  (<home>/model-state.json). --model and SALAM_MODEL override it; it overrides config "model".
  /title [TEXT|auto]               Show or rename this dialog. By default the model titles a session
  from its first message (config "autoTitle": false keeps the message itself); /title TEXT is
  never overwritten, /title auto regenerates. The terminal window shows the title.
  /resume                         Choose a saved session; /resume ID|latest selects directly.
  /rewind                         Choose a labelled user, model, tool or agent event, then a restore mode.
  /rewind ID conversation          Fork history before that event; the source branch is kept intact.
  /rewind ID files                 Restore tracked file/directory changes only, without git.
  /rewind ID both                  Restore tracked files and fork history before that event.
  Each model's prefix cache key carries over the fork, but provider cache retention is never guaranteed.
  File rewind refuses external changes. A foreground shell command's changes to files the agent
  had already seen are tracked (with --lean/--tools, also files named in the command, such as
  cat > new.py); other shell and MCP side effects are not.
  /recap [focus]                   Summarize without changing the working context.
  /usage [session|provider|all]     Recorded tokens/cache/cost estimates and actual quota windows.
  /memory [on|off|list]            Inspect project memory, persist an auto-memory toggle, or list its files.
  MEMORY.md loads at startup (first 200 lines / 25 KB); topic Markdown files are read on demand.
  Default memory lives in <home>/projects/<project-key>/memory; git worktrees share a project.
  autoMemoryEnabled and autoMemoryDirectory configure this separately from per-session context_notes.
  /goal TEXT                      Start work toward a persistent goal until verified completion.
  /goal [status|pause|resume|clear] Inspect or control it; resumed sessions load goals paused.
  Active goals continue past the ordinary turn cap; interruption and provider errors pause them.
  /loop [INTERVAL] TASK            Run periodically while idle (e.g. 30s, 5m, 2h; default 10m).
  /loop [list|stop ID|stop all]    Inspect or stop loops; session changes and exit remove them.
  Loops never overlap or build a backlog. First run happens after the interval.
  /jobs  /output ID               List background commands or read their output.
  /wait ID [SECONDS]              Wait up to 30s by default; cancelling the wait leaves it running.
  /kill ID                        Stop the command's process tree on its original local/SSH target.
  Agents use shell background=true; Ctrl+B can also promote a command already running in the foreground.
  Normal shutdown stops owned commands; authenticated supervisors recover local/SSH jobs after a crash.
  Commands also work with -p, e.g. salam --resume latest -p "/usage session".

Configuration: ~/.salam/config.json, then <cwd>/.salam/config.json.
SALAM_HOME and SALAM_MODEL override defaults. Commands run with your user
permissions: bypass mode is intentional. Only use trusted repositories and MCPs.

Runtime and tools:
  Bun 1.4.1+ is required; bin/salam uses the project-local Bun via Node.
  Install rg locally for text search. AST search and the TypeScript LSP are bundled.
  Fenced code is highlighted offline from bundled tree-sitter grammars: JS/TS/TSX, Python, shell,
  JSON, Go, Rust, C/C++, Java, CSS, HTML, YAML, TOML, Markdown and Zig; diff/patch fences too.
  SSH targets need Python 3 and their search/LSP executables on PATH.
  SSH host-key verification stays enabled; the helper is cached in ~/.cache/salam.
  Agents can inspect/switch their own target with workspace_switch (local or an SSH name).
  Switching retains that agent's conversation; other agents stay on their own targets.
  /remote NAME|local is the user shortcut and starts a new session on that target.
  Worktrees require a clean Git checkout. Salam never auto-stashes or auto-commits.
  File reads page by line/column over a 2 MiB prefix; larger ranges need scoped shell.
  Edits are limited to 8 MiB files. Oversized tool results remain in artifact storage.
  web_fetch retrieves public pages via native Anthropic web_fetch or Codex open_page, with sources.
  web_search runs OpenAI/Codex hosted web search on "webSearchModel" (default openai-codex/gpt-5.6-luna),
  independent of the active model and without the conversation, returning a sourced summary; it needs
  Codex authentication (/login openai-codex) even while working with Anthropic or other providers.
  Native fetch/search usage is recorded separately from the conversation's context-window usage;
  /usage lists searches under the search model. Catalog cost estimates are not subscription charges.
  Saved sessions freeze tool schemas; /new loads newly installed tools such as web_search.

Providers and context:
  Existing Claude Code, Codex/OMP and Devin credentials are read without displaying them.
  Custom OpenAI uses Chat Completions; custom Anthropic uses Messages.
  Custom Anthropic gateways default to Bearer authentication. Providers accept
  "headers" with environment templates, e.g. {"x-api-key": "\${CUSTOM_API_KEY}"}.
  Native signed compaction and mid-turn context extensions are enabled only for
  supported Anthropic models; Codex can roll context using a persistent notebook.
  Switching models mid-dialog keeps each model's own native reasoning and tool history;
  foreign turns are relayed as plain context, never replayed as another model's opaque reasoning.

Example configuration:
{
  "model": "anthropic/claude-fable-5-1",
  "webSearchModel": "openai-codex/gpt-5.6-luna",
  "providers": {
    "local": {
      "kind": "custom-openai",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "apiKeyEnv": "LOCAL_API_KEY",
      "models": [{ "id": "coding-model", "contextWindow": 128000 }]
    }
  },
  "remotes": { "dev": { "host": "user@host", "cwd": "/srv/project" } },
  "mcpServers": {
    "browser": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  }
}
`;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function recoveryCommand(
	args: string[],
	olderThan: string | undefined,
	force: boolean,
	cwd: string | undefined,
): Promise<void> {
	const roots = await recoveryRoots(resolve(cwd ?? process.cwd()));
	const entries = await listRecovery(roots);
	const [sub, ...names] = args;
	if (sub === undefined) {
		if (olderThan !== undefined || force)
			throw new Error("--older-than and --force need salam recovery prune.");
		if (!entries.length) {
			process.stdout.write(`No recovery entries${roots.length ? ` in ${roots.join(", ")}` : ""}.\n`);
			return;
		}
		const held = await heldEntries(roots);
		for (const root of roots) {
			const mine = entries.filter((entry) => entry.root === root);
			const total = mine.reduce((sum, entry) => sum + entry.bytes, 0);
			process.stdout.write(`${root} — ${mine.length} of ${RECOVERY_LIMIT} entries, ${formatBytes(total)}\n`);
			for (const entry of mine)
				process.stdout.write(
					`  ${entry.directory.slice(root.length + 1).padEnd(11)} ${new Date(entry.createdAt ?? 0).toISOString().slice(0, 16).replace("T", " ")}  ${(entry.operation ?? "?").padEnd(6)} ${formatBytes(entry.bytes).padStart(9)}  ${entry.path ?? "(no manifest)"}${held?.has(entry.directory) ? "  [open]" : ""}\n`,
				);
		}
		if (!held) process.stdout.write("(lsof unavailable: open-file status unknown)\n");
		process.stdout.write(
			"Remove with: salam recovery prune ENTRY... or salam recovery prune --older-than 14d\n",
		);
		return;
	}
	if (sub !== "prune") throw new Error(`Unknown recovery command ${sub}. Run salam --help.`);
	if (!names.length && olderThan === undefined)
		throw new Error("Name entries to remove, or pass --older-than AGE (e.g. 14d). Nothing was removed.");
	if (names.length && olderThan !== undefined) throw new Error("Choose either entry names or --older-than.");
	let selected: RecoveryEntry[];
	if (olderThan !== undefined) {
		const cutoff = Date.now() - parseAge(olderThan);
		selected = entries.filter((entry) => (entry.createdAt ?? 0) < cutoff);
	} else {
		selected = [];
		for (const name of names) {
			const matches = entries.filter(
				(entry) => entry.directory === resolve(name) || entry.directory.endsWith(`/${name}`),
			);
			if (matches.length !== 1)
				throw new Error(
					`${name} ${matches.length ? `is ambiguous (${matches.map((entry) => entry.directory).join(", ")}); give the full path` : "is not a recovery entry"}. Nothing was removed.`,
				);
			selected.push(matches[0]!);
		}
	}
	if (!selected.length) {
		process.stdout.write("No entries matched; nothing was removed.\n");
		return;
	}
	const result = await pruneRecovery(selected, await heldEntries(roots), force);
	const freed = result.removed.reduce((sum, entry) => sum + entry.bytes, 0);
	process.stdout.write(`Removed ${result.removed.length} entries (${formatBytes(freed)}).\n`);
	for (const entry of result.held)
		process.stdout.write(
			`Kept ${entry.directory}: a process still has it open (--force removes it anyway).\n`,
		);
	for (const { entry, error } of result.failed) process.stdout.write(`Failed ${entry.directory}: ${error}\n`);
	if (result.failed.length) process.exitCode = 1;
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		options: {
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
			print: { type: "string", short: "p" },
			json: { type: "boolean" },
			cwd: { type: "string" },
			home: { type: "string" },
			config: { type: "string" },
			model: { type: "string" },
			resume: { type: "string" },
			remote: { type: "string" },
			tools: { type: "string" },
			lean: { type: "boolean" },
			"older-than": { type: "string" },
			force: { type: "boolean" },
		},
	});
	if (values.help) {
		process.stdout.write(HELP);
		return;
	}
	if (values.version) {
		process.stdout.write("salam 0.1.0\n");
		return;
	}
	if (values.lean && values.tools !== undefined) throw new Error("Choose either --lean or --tools");
	const tools = values.lean
		? [
				"shell",
				"command_output",
				"command_stop",
				"web_search",
				"web_fetch",
				"ask",
				"view_image",
				"todo",
				"goal_complete",
				"goal_pause",
				"agents_spawn",
				"agents_status",
				"agents_wait",
				"agents_send",
				"agents_cancel",
				"history_read",
				"history_search",
			]
		: values.tools
				?.split(",")
				.map((name) => name.trim())
				.filter(Boolean);
	if (tools?.length === 0) throw new Error("--tools needs at least one tool name");
	if (values.json && values.print === undefined) throw new Error('--json requires -p "task"');
	const action = positionals[0];
	if (action === "recovery") {
		await recoveryCommand(positionals.slice(1), values["older-than"], values.force === true, values.cwd);
		return;
	}
	if (values["older-than"] !== undefined || values.force)
		throw new Error("--older-than and --force apply only to salam recovery prune.");
	if (action && !["models", "auth", "login", "sessions"].includes(action))
		throw new Error(`Unknown command ${action}. Run salam --help.`);
	if (action && values.print !== undefined) throw new Error("Choose either a command or --print");
	if (positionals.length > (action === "login" ? 2 : 1))
		throw new Error("Unexpected command arguments. Run salam --help.");
	if (!action && values.print === undefined && (!process.stdin.isTTY || !process.stdout.isTTY))
		throw new Error('Interactive mode needs a terminal. Use salam -p "task" for non-interactive input.');
	const config = await loadConfig({
		cwd: values.cwd,
		home: values.home,
		file: values.config,
		model: values.model,
	});
	if (tools) {
		config.tools = [...new Set(tools)];
		// MCP servers contribute their own instructions; start none unless MCP tools are offered.
		if (!tools.some((name) => name.startsWith("mcp_"))) config.mcpServers = {};
	}
	if (action === "sessions") {
		for (const session of listSessions(config))
			process.stdout.write(
				`${session.id}  ${new Date(session.updatedAt).toISOString()}  ${session.provider}/${session.model}  ${session.title.replace(/[\r\n]/g, " ")}\n`,
			);
		return;
	}
	const gateway = await createProviderGateway(config);
	let controller: AppController | undefined;
	let closeTools: (() => Promise<void>) | undefined;
	let closeIntegrations: (() => Promise<void>) | undefined;
	let exitSignal: NodeJS.Signals | undefined;
	const interrupt = (signal: NodeJS.Signals) => {
		exitSignal = signal;
		controller?.cancel();
	};
	const onSigterm = () => interrupt("SIGTERM");
	const onSigint = () => interrupt("SIGINT");
	const interactive = !action && values.print === undefined;
	try {
		if (action === "auth") {
			for (const entry of await gateway.authStatus())
				process.stdout.write(
					`${entry.available ? "ready  " : "missing"}  ${entry.provider.padEnd(18)} ${entry.source}\n`,
				);
			return;
		}
		if (action === "models") {
			for (const model of await gateway.models())
				process.stdout.write(
					`${model.provider}/${model.model}${model.contextWindow ? `  (${model.contextWindow.toLocaleString()} context)` : ""}\n`,
				);
			return;
		}
		if (action === "login") {
			const provider = positionals[1];
			if (!provider) throw new Error("Usage: salam login anthropic|openai-codex|devin");
			let muted = false;
			const output = new Writable({
				write(chunk, _encoding, callback) {
					if (!muted) process.stderr.write(chunk);
					callback();
				},
			});
			const readline = createInterface({
				input: process.stdin,
				output,
				terminal: Boolean(process.stdin.isTTY),
			});
			try {
				await gateway.login(provider, {
					url: (url) => process.stderr.write(`Authorize salam in your browser:\n${url}\n`),
					prompt: async (message) => {
						process.stderr.write(`${message}\nInput is hidden: `);
						muted = true;
						try {
							return await readline.question("");
						} finally {
							muted = false;
							process.stderr.write("\n");
						}
					},
				});
				process.stdout.write(`Authorized ${provider}.\n`);
			} finally {
				readline.close();
				output.end();
			}
			return;
		}
		const toolServices = await createTools(config);
		closeTools = () => toolServices.close();
		const integrations = await createIntegrations(config);
		closeIntegrations = () => integrations.close();
		controller = await createRuntime(config, gateway, toolServices, integrations, {
			sessionId: values.resume,
			// Nothing can answer a structured question in --print mode; asks fail instead of hanging.
			interactive,
		});
		if (values.remote) await controller.command(`/remote ${values.remote}`);
		if (!interactive) {
			process.on("SIGTERM", onSigterm);
			process.on("SIGINT", onSigint);
		}
		if (values.print !== undefined) {
			const initialItems = new Set(controller.snapshot().items.map((item) => item.id));
			const seenTools = new Set(initialItems);
			const seenNotices = new Set(initialItems);
			let lastAssistant: string | undefined;
			const emitChange = (snapshot: AppSnapshot) => {
				for (const item of snapshot.items) {
					if (item.kind === "notice" && !seenNotices.has(item.id)) {
						seenNotices.add(item.id);
						process.stdout.write(
							values.json
								? `${JSON.stringify({ type: "notice", text: item.text, state: item.state })}\n`
								: `${item.text}\n`,
						);
					}
					if (item.kind !== "tool" || item.state === "running" || seenTools.has(item.id)) continue;
					seenTools.add(item.id);
					if (values.json)
						process.stdout.write(
							`${JSON.stringify({ type: "tool_result", id: item.id, name: item.name, state: item.state, text: item.text, diff: item.diff })}\n`,
						);
					else process.stderr.write(`${item.state === "error" ? "error" : "done"} ${item.name ?? "tool"}\n`);
				}
			};
			const unsubscribe = controller.subscribe((event) => {
				if (event.type === "delta") {
					if (values.json) process.stdout.write(`${JSON.stringify(event)}\n`);
					else if (event.kind === "text") {
						if (lastAssistant && lastAssistant !== event.id) process.stdout.write("\n");
						lastAssistant = event.id;
						process.stdout.write(event.delta);
					}
				} else if (event.type === "change") emitChange(controller!.snapshot());
			});
			try {
				await controller.submit(values.print);
				const snapshot = controller.snapshot();
				emitChange(snapshot);
				if (values.json)
					process.stdout.write(
						`${JSON.stringify({ type: "done", sessionId: snapshot.sessionId, usage: snapshot.usage, status: snapshot.status })}\n`,
					);
				else process.stdout.write("\n");
				if (
					snapshot.items.some(
						(item) =>
							!initialItems.has(item.id) &&
							item.state === "error" &&
							item.kind !== "tool" &&
							(!values.print!.trimStart().startsWith("/") || item.kind === "notice"),
					)
				)
					process.exitCode = 1;
			} finally {
				unsubscribe();
			}
		} else {
			await startUI(controller, (signal) => {
				exitSignal = signal;
			});
		}
		if (exitSignal) process.exitCode = exitSignal === "SIGINT" ? 130 : exitSignal === "SIGHUP" ? 129 : 143;
	} finally {
		process.off("SIGTERM", onSigterm);
		process.off("SIGINT", onSigint);
		const runtimeClose = await Promise.allSettled([controller?.close()]);
		const results = [
			...runtimeClose,
			...(await Promise.allSettled([closeTools?.(), closeIntegrations?.(), gateway.close()])),
		];
		for (const result of results)
			if (result.status === "rejected") {
				process.stderr.write(
					`salam cleanup: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`,
				);
				process.exitCode = process.exitCode || 1;
			}
		// Printed last, on the restored terminal, for every way an interactive session ends
		// except a hangup, which leaves no terminal to print to. --print output is never touched.
		if (interactive && controller && exitSignal !== "SIGHUP")
			process.stdout.write(
				`To resume, run: ${resumeCommand({
					sessionId: controller.snapshot().sessionId,
					home: config.home,
					defaultHome: resolve(join(homedir(), ".salam")),
					environmentHome: process.env.SALAM_HOME === undefined ? undefined : resolve(process.env.SALAM_HOME),
					configFile: values.config === undefined ? undefined : resolve(values.config),
					cwd: config.cwd,
					launchCwd: resolve(process.cwd()),
				})}\n`,
			);
	}
}

await main().catch((error) => {
	process.stderr.write(`salam: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
