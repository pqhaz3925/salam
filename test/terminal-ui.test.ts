import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDefaultParsers, infoStringToFiletype, TreeSitterClient } from "@opentui/core";
import type { TodoItem, UserQuestion } from "../src/contracts.ts";
import { describeCopy } from "../src/ui/clipboard.ts";
import { diffFenceHighlights } from "../src/ui/diff.ts";
import { resolveAnswer } from "../src/ui/question.ts";
import { resumeCommand } from "../src/ui/resume.ts";
import { resolveSyntaxAssets } from "../src/ui/syntax.ts";
import { todoProgress } from "../src/ui/todo.ts";

let directory: string | undefined;
let client: TreeSitterClient | undefined;
afterEach(async () => {
	await client?.destroy();
	if (directory) await rm(directory, { recursive: true, force: true });
	client = undefined;
	directory = undefined;
});

const SAMPLES: Record<string, { fence: string; code: string }> = {
	python: { fence: "py", code: "def f(x):\n    return x + 1  # note" },
	bash: { fence: "shell", code: 'echo "$HOME" | grep -c h' },
	json: { fence: "json", code: '{"a": [1, true, null]}' },
	go: { fence: "golang", code: 'package main\nfunc main() { fmt.Println("x") }' },
	rust: { fence: "rs", code: "fn main() { let x: i32 = 5; }" },
	css: { fence: "css", code: "body { color: red; }" },
	html: { fence: "html", code: '<div class="a">hi</div>' },
	c: { fence: "c", code: "#include <stdio.h>\nint main(void) { return 0; }" },
	cpp: { fence: "cpp", code: "class A { public: int f() const; };" },
	java: { fence: "java", code: "class A { public static void main(String[] a) {} }" },
	typescriptreact: { fence: "tsx", code: 'const a = <div className="x">{y}</div>;' },
	yaml: { fence: "yml", code: "a: 1\nb: [x, y]" },
	toml: { fence: "toml", code: '[package]\nname = "x"' },
};

test("every bundled grammar resolves offline and highlights its fence through OpenTUI's parser worker", async () => {
	const assets = resolveSyntaxAssets();
	expect(assets.missing).toEqual([]);
	expect(assets.parsers.map((parser) => parser.filetype).sort()).toEqual(Object.keys(SAMPLES).sort());
	addDefaultParsers(assets.parsers);
	directory = await mkdtemp(join(tmpdir(), "salam-syntax-"));
	client = new TreeSitterClient({ dataPath: directory });
	await client.initialize();
	for (const [filetype, sample] of Object.entries(SAMPLES)) {
		const result = await client.highlightOnce(sample.code, infoStringToFiletype(sample.fence)!);
		expect({ filetype, warning: result.warning, error: result.error }).toEqual({
			filetype,
			warning: undefined,
			error: undefined,
		});
		expect(result.highlights?.length ?? 0).toBeGreaterThan(0);
	}
});

test("diff fences tell a ---/+++ file header from a removed line that starts with dashes", () => {
	const content = "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+select 1;\n keep";
	expect(
		diffFenceHighlights(content).map(([start, end, group]) => [content.slice(start, end), group]),
	).toEqual([
		["--- a/q.sql", "diff.file"],
		["+++ b/q.sql", "diff.file"],
		["@@ -1,2 +1,2 @@", "diff.delta"],
		["--- old comment", "diff.minus"],
		["+select 1;", "diff.plus"],
	]);
});

test("the resume command survives a real shell and carries only the flags that locate the session", () => {
	expect(
		resumeCommand({
			sessionId: "0193f2c4-aaaa",
			home: "/Users/me/.salam",
			defaultHome: "/Users/me/.salam",
			cwd: "/work",
			launchCwd: "/work",
		}),
	).toBe("salam --resume 0193f2c4-aaaa");
	const overriddenEnvironment = resumeCommand({
		sessionId: "0193f2c4-home",
		home: "/Users/me/.salam",
		defaultHome: "/Users/me/.salam",
		environmentHome: "/tmp/other-state",
		cwd: "/work",
		launchCwd: "/work",
	});
	const overrideShell = Bun.spawnSync([
		"/bin/sh",
		"-c",
		`printf '%s\\n' ${overriddenEnvironment.slice("salam ".length)}`,
	]);
	expect(overrideShell.stdout.toString().trimEnd().split("\n")).toEqual([
		"--resume",
		"0193f2c4-home",
		"--home",
		"/Users/me/.salam",
	]);
	const command = resumeCommand({
		sessionId: "0193f2c4-bbbb",
		home: "/tmp/My State",
		defaultHome: "/Users/me/.salam",
		configFile: "/tmp/it's $HOME `id`.json",
		cwd: "/srv/pro ject",
		launchCwd: "/work",
	});
	const shell = Bun.spawnSync(["/bin/sh", "-c", `printf '%s\\n' ${command.slice("salam ".length)}`]);
	expect(shell.stdout.toString().trimEnd().split("\n")).toEqual([
		"--resume",
		"0193f2c4-bbbb",
		"--home",
		"/tmp/My State",
		"--config",
		"/tmp/it's $HOME `id`.json",
		"--cwd",
		"/srv/pro ject",
	]);
});

test("question answers match the runtime contract for single, free-text and multi-select questions", () => {
	const single: UserQuestion = {
		id: "db",
		question: "Which database?",
		options: [{ label: "Postgres" }, { label: "SQLite" }],
	};
	expect(resolveAnswer(single, { focus: 1, picked: [] }, "")).toEqual({ answer: "SQLite" });
	expect(resolveAnswer(single, { focus: 1, picked: [] }, "  MySQL ")).toEqual({ answer: "MySQL" });
	const multi: UserQuestion = { ...single, multi: true };
	expect(resolveAnswer(multi, { focus: 0, picked: [1, 0] }, "DuckDB")).toEqual({
		answer: ["Postgres", "SQLite", "DuckDB"],
	});
	expect("hint" in resolveAnswer(multi, { focus: 0, picked: [] }, "  ")).toBe(true);
	expect("hint" in resolveAnswer({ id: "why", question: "Why?" }, { focus: 0, picked: [] }, "")).toBe(true);
});

test("todo progress ignores abandoned work and follows in-progress, then pending, then blocked items", () => {
	const item = (content: string, status: TodoItem["status"]): TodoItem => ({ content, status });
	expect(todoProgress(undefined)).toBeUndefined();
	expect(
		todoProgress([item("a", "completed"), { ...item("b", "abandoned"), reason: "obsolete" }]),
	).toBeUndefined();
	expect(
		todoProgress([
			item("a", "completed"),
			item("b", "pending"),
			item("c", "in_progress"),
			{ ...item("d", "blocked"), reason: "needs a key" },
			item("e", "abandoned"),
		]),
	).toMatchObject({ done: 1, total: 4, blocked: 1, current: { content: "c" } });
	expect(todoProgress([item("d", "blocked"), item("b", "pending")])?.current.content).toBe("b");
});

test("copy status only claims a copy that a clipboard backend reported", () => {
	expect(
		describeCopy("abc", {
			host: { status: "written" },
			terminal: { status: "not-attempted", capability: "unknown" },
		}),
	).toStartWith("copied");
	const unconfirmed = describeCopy("a\nb", {
		host: { status: "not-attempted" },
		terminal: { status: "attempted", capability: "unknown" },
	});
	expect(unconfirmed).not.toStartWith("copied");
	expect(unconfirmed).toContain("unconfirmed");
	expect(
		describeCopy("a", {
			host: { status: "failed", error: new Error("no pasteboard") },
			terminal: { status: "not-attempted", capability: "unsupported" },
		}),
	).toStartWith("copy failed: no pasteboard");
});
