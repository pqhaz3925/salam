/**
 * Renders a representative transcript into the headless test renderer and prints the frame, so
 * transcript styling can be checked without a live session: `bun scripts/ui-preview.tsx [width]`.
 * `--spans` also prints each distinct colour run, which is what the frame text alone cannot show.
 */
import { testRender } from "@opentui/solid";
import type { AppSnapshot, ViewItem } from "../src/contracts.ts";
import { buildActivityText, buildFooterText } from "../src/ui/status.ts";
import { StyledLine } from "../src/ui/styled.tsx";
import { ConversationRows, createTranscript } from "../src/ui/transcript.tsx";

const width = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? 110);
const items: ViewItem[] = [
	{ id: "u1", kind: "user", text: "а в терминал картинки вставлять можно ж?" },
	{
		id: "a1",
		kind: "assistant",
		thinking: "Checking how the composer handles clipboard images.",
		text: "Проверю, как устроена вставка.",
	},
	{
		id: "t1",
		kind: "tool",
		name: "shell",
		state: "done",
		details: JSON.stringify({ command: "grep -rn paste src/ui/App.tsx | head -5" }),
		text: '/repo$ grep -rn paste src/ui/App.tsx | head -5\nsrc/ui/App.tsx:54: "ctrl+v image",\nsrc/ui/App.tsx:567: * Ctrl+V (or Cmd+V when the terminal forwards it\nsrc/ui/App.tsx:572: async function pasteClipboard()\nsrc/ui/App.tsx:582: if ("image" in clip) {\nsrc/ui/App.tsx:583: await attachImage()',
	},
	{
		id: "t2",
		kind: "tool",
		name: "edit",
		state: "done",
		details: JSON.stringify({ path: "src/ui/theme.ts", old_string: "a", new_string: "b" }),
		text: "Edited lines 16-17 of src/ui/theme.ts",
		diff: '--- a/src/ui/theme.ts\n+++ b/src/ui/theme.ts\n@@ -15,4 +15,4 @@\n export const palette = {\n-\taccent: "#5fb3c3",\n-\ttext: "#bfc3c8",\n+\taccent: "#d77757",\n+\ttext: "#e6e6e6",\n \tok: "#6fbf73",\n',
	},
	{
		id: "t3",
		kind: "tool",
		name: "shell",
		state: "error",
		details: JSON.stringify({ command: "bun run test" }),
		text: '/repo$ bun run test\n 250 pass\n 1 fail\nerror: script "test" exited with code 1\n[command exited with 1]',
	},
	{
		id: "t5",
		kind: "tool",
		name: "shell",
		state: "done",
		details: JSON.stringify({ command: "python3 - <<'EOF'\nimport pathlib\nEOF" }),
		text: "/repo$ python3 - <<'EOF'\n(no output)\n[files you had seen changed on disk while this command ran: a.py]\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n",
		diff: "--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n",
	},
	{
		id: "t4",
		kind: "tool",
		name: "web_search",
		state: "running",
		details: JSON.stringify({ query: "opentui bg" }),
		text: "",
	},
	{
		id: "a2",
		kind: "assistant",
		text: "Да, можно: **Ctrl+V** прикрепляет картинку, `view_image` для файлов с диска.",
	},
];
/** `--native`: the full tool set's own tools, whose arguments are not a single command. */
const call = (id: string, name: string, args: unknown, text: string, diff?: string): ViewItem => ({
	id,
	kind: "tool",
	name,
	state: "done",
	details: JSON.stringify(args),
	text,
	...(diff ? { diff } : {}),
});
const nativeItems: ViewItem[] = [
	call(
		"r",
		"read",
		{ path: "src/runtime/index.ts", offset: 170, limit: 40 },
		"src/runtime/index.ts — 3796 lines, 180 KB\n170\tconst x = 1;\n171\tconst y = 2;\n172\tconst z = 3;\n173\tconst w = 4;",
	),
	call(
		"g",
		"grep",
		{ pattern: "freshness", path: "src" },
		"src/tools/files.ts:71: const snapshot\nsrc/tools/files.ts:425: environment.freshness.record",
	),
	call("gl", "glob", { pattern: "**/*.test.ts" }, "test/a.test.ts\ntest/b.test.ts"),
	call(
		"b",
		"batch_edit",
		{
			files: [
				{ path: "src/a.ts", edits: [{ old_text: "a", new_text: "b" }] },
				{ path: "src/b.ts", edits: [{ old_text: "c", new_text: "d" }] },
			],
		},
		"Edited 2 files",
		"--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-c\n+d\n",
	),
	call(
		"w",
		"write",
		{ path: "src/new.ts", content: "export const a = 1;\n" },
		"Created src/new.ts — 1 lines, 20 B",
	),
	call("l", "lsp_hover", { path: "src/a.ts", line: 10, character: 4 }, "const a: number"),
	call("cw", "command_wait", { id: "job-3", timeout: 30 }, "job-3 exited 0"),
	call(
		"ag",
		"agents_spawn",
		{ name: "reviewer", task: "Review the diff for correctness bugs" },
		"Started agent reviewer",
	),
	call(
		"td",
		"todo",
		{ items: [] },
		"1. [completed] Wire the classifier\n2. [in_progress] Restyle native tools\n3. [pending] Run the suite",
	),
	call(
		"m",
		"mcp_call",
		{ server: "atlassian", tool: "getJiraIssue", arguments: { key: "X-1" } },
		"issue X-1",
	),
];
const snapshot = {
	sessionId: "preview",
	items: process.argv.includes("--native") ? nativeItems : items,
	busy: true,
	status: "Thinking",
	goal: undefined,
	loops: 0,
	agents: [],
	cwd: "/path/to/project",
	remote: undefined,
	selection: { provider: "anthropic", model: "claude-opus-5-5" },
	reasoning: "medium",
	contextTokens: 66_000,
	contextLimit: 1_000_000,
	quota: { windows: [{ label: "5h", remaining: 0.97, resetsAt: Date.now() + 4 * 3_600_000 }] },
	usage: { input: 10, output: 0, cacheRead: 990, cacheWrite: 0 },
} as unknown as AppSnapshot;

const transcript = createTranscript();
transcript.sync(snapshot);
if (process.argv.includes("--expanded")) transcript.toggleExpanded();
const setup = await testRender(
	() => (
		<box flexDirection="column" width="100%">
			<ConversationRows transcript={transcript} width={width} />
			<box marginTop={1}>
				<StyledLine
					wrapMode="none"
					width="100%"
					content={buildActivityText(snapshot, {
						width,
						spinnerFrame: "✻",
						elapsedMs: 610_000,
						notice: "",
						keys: ["esc interrupt"],
					})}
				/>
			</box>
			<StyledLine
				wrapMode="none"
				width="100%"
				content={buildFooterText(snapshot, { width, home: "/Users/x", expanded: false })}
			/>
		</box>
	),
	{ width, height: 60 },
);
await setup.renderOnce();
await Bun.sleep(300);
await setup.renderOnce();
process.stdout.write(`${setup.captureCharFrame().replace(/\s+$/, "")}\n`);
if (process.argv.includes("--spans")) {
	const seen = new Set<string>();
	for (const line of setup.captureSpans().lines)
		for (const span of line.spans) {
			const key = `${span.fg.toString()} ${span.bg.toString()} ${span.text.trim().slice(0, 30)}`;
			if (span.text.trim() && !seen.has(key)) {
				seen.add(key);
				process.stdout.write(`${key}\n`);
			}
		}
}
setup.renderer.destroy();
