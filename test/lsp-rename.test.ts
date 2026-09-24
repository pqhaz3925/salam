import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SalamConfig, ToolContext, ToolOutput } from "../src/contracts.ts";
import { FileCheckpoints } from "../src/runtime/checkpoints.ts";
import { type SessionRecord, Store } from "../src/runtime/store.ts";
import { createLspTools, type LspSuite } from "../src/tools/lsp/tools.ts";
import { ToolEnvironment } from "../src/tools/workspace.ts";

/**
 * Both ways a language server ends up answering about text that no longer
 * exists, against the same session:
 *
 *  - the harness's own rename rewrites a file the server holds open, and
 *  - something outside this process rewrites one.
 *
 * In both cases the open buffer shadows the file underneath it, so the next
 * query is answered from stale text and a rename silently misses the usages it
 * should have rewritten.
 */

const MATH = "export function double(value: number): number {\n  return value * 2;\n}\n";
const VERIFY =
	"import { double } from './math.ts';\n\nexport function check(): number {\n  return double(21);\n}\n";
const EXTERNAL = [
	"import { double } from './math.ts';",
	"",
	"export function check(): number {",
	"  return double(21) + double(0);",
	"}",
	"",
	"export function again(): number {",
	"  return double(7);",
	"}",
	"",
].join("\n");

let directory = "";
let project = "";
let environment: ToolEnvironment;
let suite: LspSuite;
let context: ToolContext;

beforeAll(async () => {
	// Real path: tsserver canonicalises, and on macOS the temp directory is a
	// symlink, so uncanonicalised fixtures would exercise a different file.
	directory = await realpath(await mkdtemp(join(tmpdir(), "salam-lsp-rename-")));
	project = join(directory, "project");
	const home = join(directory, "home");
	await mkdir(project);
	await mkdir(home);
	await writeFile(
		join(project, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ESNext",
					module: "ESNext",
					moduleResolution: "Bundler",
					strict: true,
					noEmit: true,
					allowImportingTsExtensions: true,
				},
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(join(project, "math.ts"), MATH);
	await writeFile(join(project, "verify.ts"), VERIFY);

	const config: SalamConfig = {
		home,
		cwd: project,
		selection: { provider: "test", model: "test" },
		webSearchModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
		providers: {},
		mcpServers: {},
		remotes: {},
		maxTurns: 1,
		maxAgents: 1,
		maxOutputTokens: 1024,
		contextThreshold: 0.8,
		reasoning: "off",
	};
	environment = new ToolEnvironment(config);
	suite = createLspTools(environment);
	context = {
		cwd: project,
		sessionId: "lsp-rename-test",
		agentId: "main",
		signal: new AbortController().signal,
		emit: () => undefined,
	};
});

afterAll(async () => {
	await suite?.close();
	await environment?.close();
	if (directory) await rm(directory, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
	const tool = suite.tools.find((entry) => entry.name === name);
	if (!tool) throw new Error(`No ${name} tool in the suite.`);
	return tool.execute(args, context);
}

/** One expression, six call sites: the fixture directory has to stay in lockstep. */
const read = (file: string): Promise<string> => Bun.file(join(project, file)).text();

function actionId(output: ToolOutput, title: RegExp): string {
	expect(output.isError ? output.text : "ok").toBe("ok");
	const row = output.text
		.split("\n")
		.find((line) => /^[a-z0-9]{12} /.test(line) && title.test(line.slice(13)));
	if (!row) throw new Error(`Missing action ${title}:\n${output.text}`);
	return row.slice(0, 12);
}

test("a repeated rename keeps rewriting cross-file usages", async () => {
	// Opening verify.ts is what used to poison the session: the server owns a
	// buffer for every document a tool opened and ignores the disk for it.
	await call("lsp_definition", { path: "verify.ts", line: 4, character: 10 });

	const first = await call("lsp_rename", { path: "math.ts", line: 1, character: 17, new_name: "twice" });
	// Comparing against 'ok' surfaces the server's own message instead of `true !== false`.
	expect(first.isError ? first.text : "ok").toBe("ok");
	expect(await read("math.ts")).toContain("export function twice(");
	expect(await read("verify.ts")).toContain("twice(21)");
	expect(await read("verify.ts")).toContain("import { twice }");

	const second = await call("lsp_rename", { path: "math.ts", line: 1, character: 17, new_name: "double" });
	expect(second.isError ? second.text : "ok").toBe("ok");
	expect(await read("math.ts")).toContain("export function double(");
	expect(await read("verify.ts")).toBe(VERIFY);
}, 180_000);

test("an external rewrite of an open document is seen by the next query", async () => {
	// The previous test left math.ts/verify.ts at their original contents and
	// verify.ts open in the server.
	await call("lsp_definition", { path: "verify.ts", line: 4, character: 10 });

	// A write from outside this process entirely: another tool, a build, an
	// editor. Nothing notifies the server, and the file gains two call sites.
	await writeFile(join(project, "verify.ts"), EXTERNAL);

	const references = await call("lsp_references", { path: "math.ts", line: 1, character: 17 });
	expect(references.isError ? references.text : "ok").toBe("ok");
	// Quoted from the reference the server reported on the new line 8, which only
	// exists in the external text.
	expect(references.text).toContain("return double(7);");

	const renamed = await call("lsp_rename", { path: "math.ts", line: 1, character: 17, new_name: "tripled" });
	expect(renamed.isError ? renamed.text : "ok").toBe("ok");
	expect(await read("math.ts")).toContain("export function tripled(");
	expect(await read("verify.ts")).toBe(EXTERNAL.replaceAll("double", "tripled"));
}, 180_000);

test("TypeScript extract commands survive cursor hints, captured paging and checkpoint rewind", async () => {
	const path = "extract.ts",
		original = "export function calculate(value: number) {\n  return value * 2 + 1;\n}\n";
	await writeFile(join(project, path), original);
	const args = {
		path,
		line: 2,
		character: 10,
		end_line: 2,
		end_character: 19,
		kind: "refactor.extract",
		limit: 2000,
	};
	// Spawn/list outside the checkpoint: the stdout listener must not determine
	// which rewind point owns subsequent server-driven workspace/applyEdit.
	const listed = await call("lsp_code_actions", args);
	const id = actionId(listed, /Extract to constant in enclosing scope/i);
	const page = await call("lsp_code_actions", { ...args, skip: 1 });
	expect(page.isError ? page.text : "ok").toBe("ok");
	for (const row of page.text.split("\n").filter((line) => /^[a-z0-9]{12} /.test(line)))
		expect(listed.text).toContain(row);
	const store = new Store(join(directory, "checkpoint-home"));
	const selection = { provider: "test", model: "test" };
	const session: SessionRecord = {
		id: context.sessionId,
		title: "LSP rewind",
		cwd: project,
		selection,
		system: [],
		tools: [],
		activeTools: [],
		firstUserText: "",
		notebook: "",
		contexts: [
			{ selection, sessionId: context.sessionId, cacheKey: context.sessionId, contextStart: 0, tokens: 0 },
		],
		instructions: [],
		updatedAt: Date.now(),
	};
	const checkpoints = new FileCheckpoints(store, (ctx) => environment.workspace(ctx));
	try {
		store.save(session);
		store.captureCheckpoint(session, 0, "extract-point", "extract", "user");
		const applied = await checkpoints.run("extract-point", context, () =>
			call("lsp_apply_action", { action: id }),
		);
		expect(applied.isError ? applied.text : "ok").toBe("ok");
		const changed = await read(path);
		expect(changed).toMatch(/const \w+ = value \* 2/);
		expect(changed).not.toBe(original);
		const restored = await checkpoints.restore(context.sessionId, "extract-point", context.signal);
		expect(restored.paths).toContain(join(project, path));
		expect(await read(path)).toBe(original);
	} finally {
		store.close();
	}
}, 180_000);

test("TypeScript quick fixes handle encoded route-group paths and exclude unrelated diagnostics", async () => {
	const path = "app/(auth)/page !'()*%#é.ts";
	await mkdir(join(project, "app/(auth)"), { recursive: true });
	const original =
		"export const clean = 1;\n\nexport function load() {\n  return await Promise.resolve(1);\n}\n";
	await writeFile(join(project, path), original);
	const diagnostics = await call("lsp_diagnostics", { path });
	expect(diagnostics.text).toContain("await");
	const clean = await call("lsp_code_actions", { path, line: 1, character: 14, kind: "quickfix" });
	expect(clean.isError ? clean.text : "ok").toBe("ok");
	expect(
		clean.details && typeof clean.details === "object" && !Array.isArray(clean.details)
			? clean.details.matched
			: undefined,
	).toBe(0);
	const fixes = await call("lsp_code_actions", { path, line: 4, character: 10, kind: "quickfix" });
	const id = actionId(fixes, /async.*function/i);
	const applied = await call("lsp_apply_action", { action: id });
	expect(applied.isError ? applied.text : "ok").toBe("ok");
	expect(await read(path)).toContain("export async function load()");
	expect(await read(path)).toContain("export const clean = 1;");
	const after = await call("lsp_diagnostics", { path });
	expect(after.isError ? after.text : "ok").toBe("ok");
}, 180_000);

test("a first quick-fix request obtains diagnostics without a priming query", async () => {
	const path = "first-quick-fix.ts";
	const original = "export function firstFix() { return await Promise.resolve(1); }\n";
	await writeFile(join(project, path), original);
	const fixes = await call("lsp_code_actions", {
		path,
		line: 1,
		character: original.indexOf("await") + 1,
		kind: "quickfix",
	});
	const applied = await call("lsp_apply_action", { action: actionId(fixes, /async.*function/i) });
	expect(applied.isError ? applied.text : "ok").toBe("ok");
	expect(await read(path)).toContain("export async function firstFix()");
}, 180_000);

test("a later TypeScript action listing makes an earlier resolvable fix-all fail rather than silently succeed", async () => {
	const path = "stale-actions.ts";
	const original =
		"export function first() { return await Promise.resolve(1); }\nexport function second() { return await Promise.resolve(2); }\n";
	await writeFile(join(project, path), original);
	await call("lsp_diagnostics", { path });
	const args = { path, line: 1, character: original.indexOf("await") + 1, kind: "quickfix" };
	const first = await call("lsp_code_actions", args);
	const stale = actionId(first, /\ball\b/i);
	const second = await call("lsp_code_actions", args);
	const current = actionId(second, /\ball\b/i);
	const refused = await call("lsp_apply_action", { action: stale });
	expect(refused.isError).toBe(true);
	expect(refused.text).toMatch(/stale/);
	expect(await read(path)).toBe(original);
	const stalePage = await call("lsp_code_actions", { ...args, line: 2, skip: 1 });
	expect(stalePage.isError).toBe(true);
	const applied = await call("lsp_apply_action", { action: current });
	expect(applied.isError ? applied.text : "ok").toBe("ok");
	expect(await read(path)).toContain("export async function first()");
	expect(await read(path)).toContain("export async function second()");
}, 180_000);
