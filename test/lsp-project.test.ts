import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SalamConfig, ToolContext, ToolOutput } from "../src/contracts.ts";
import { createLspTools, type LspSuite } from "../src/tools/lsp/tools.ts";
import { ToolEnvironment } from "../src/tools/workspace.ts";

/**
 * Project-wide diagnostics and call hierarchy against the real TypeScript
 * language server. Errors live in several files so a scan that stops at the
 * first document, or wanders into dependencies/build output, is caught.
 */

const CALLS = [
	"export function leaf(): number {",
	"  return 1;",
	"}",
	"export function middle(): number {",
	"  return leaf() + 1;",
	"}",
	"export function top(): number {",
	"  return middle() * 2;",
	"}",
	"",
].join("\n");

const FILES: Record<string, string> = {
	"src/a-broken.ts": 'export const a: number = "text";\n',
	"src/calls.ts": CALLS,
	"src/clean.ts": "export const c = 1;\n",
	"src/nested/deep/b-broken.ts": 'import { leaf } from "../../calls.ts";\nexport const b: string = leaf();\n',
	"node_modules/dep/index.ts": 'export const dependency: number = "not scanned";\n',
	"dist/out.ts": 'export const built: number = "not scanned";\n',
};

let directory = "";
let project = "";
let environment: ToolEnvironment;
let suite: LspSuite;
let context: ToolContext;

beforeAll(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "salam-lsp-project-")));
	project = join(directory, "project");
	const home = join(directory, "home");
	await mkdir(home, { recursive: true });
	await mkdir(project, { recursive: true });
	await writeFile(
		join(project, "tsconfig.json"),
		`${JSON.stringify({
			compilerOptions: {
				target: "ESNext",
				module: "ESNext",
				moduleResolution: "Bundler",
				strict: true,
				noEmit: true,
				allowImportingTsExtensions: true,
			},
			include: ["src"],
		})}\n`,
	);
	for (const [path, text] of Object.entries(FILES)) {
		await mkdir(dirname(join(project, path)), { recursive: true });
		await writeFile(join(project, path), text);
	}
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
		sessionId: "lsp-project-test",
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

function details(output: ToolOutput): Record<string, unknown> {
	return output.details as Record<string, unknown>;
}

test("project diagnostics default to cwd and report errors beyond the first file, skipping dependencies and build output", async () => {
	const output = await call("lsp_diagnostics", { timeout: 120 });
	const info = details(output);
	expect({ total: info.total, checked: info.checked, complete: info.complete }).toEqual({
		total: 4,
		checked: 4,
		complete: true,
	});
	expect(output.text).toContain("src/a-broken.ts:1:14 error [2322]");
	expect(output.text).toContain("src/nested/deep/b-broken.ts:2:14 error [2322]");
	expect(output.text).not.toContain("not scanned");
	expect(info.errors).toBe(2);
	expect(info.filesWithDiagnostics).toBe(2);
	expect(output.isError).toBe(false);
}, 180_000);

test("a nested directory scans only its own sources", async () => {
	const output = await call("lsp_diagnostics", { path: "src/nested", timeout: 120 });
	expect({ total: details(output).total, errors: details(output).errors }).toEqual({ total: 1, errors: 1 });
	expect(output.text).toContain("deep/b-broken.ts:2:14 error");
	expect(output.isError).toBe(false);
}, 180_000);

test("a bounded scan is explicitly incomplete and continues by file offset", async () => {
	const first = await call("lsp_diagnostics", { path: "src", max_files: 1, timeout: 120 });
	expect({
		scanned: details(first).scanned,
		complete: details(first).complete,
		next: details(first).nextFileOffset,
	}).toEqual({ scanned: 1, complete: false, next: 1 });
	expect(first.isError).toBe(true);

	const last = await call("lsp_diagnostics", { path: "src", max_files: 1, file_offset: 3, timeout: 120 });
	expect(details(last).complete).toBe(false);
	expect(last.isError).toBe(true);
	expect(details(last).nextFileOffset).toBeUndefined();
	expect(last.text).toContain("nested/deep/b-broken.ts:2:14 error");
}, 180_000);

test("single-file diagnostics keep their per-document report", async () => {
	const output = await call("lsp_diagnostics", { path: "src/a-broken.ts" });
	expect(details(output).count).toBe(1);
	expect(output.isError).toBe(false);
	expect(details(output).ready).toBe(true);
	const clean = await call("lsp_diagnostics", { path: "src/clean.ts" });
	expect(details(clean).count).toBe(0);
	expect(clean.isError).toBe(false);
}, 180_000);

test("an empty source directory completes successfully while a missing target fails", async () => {
	await mkdir(join(project, "empty"));
	const empty = await call("lsp_diagnostics", { path: "empty" });
	expect(empty.isError).toBe(false);
	expect(details(empty)).toMatchObject({ complete: true, total: 0, checked: 0, errors: 0 });
	const missing = await call("lsp_diagnostics", { path: "missing.ts" });
	expect(missing.isError).toBe(true);
});

test("incoming calls name the calling function and its call site", async () => {
	const output = await call("lsp_call_hierarchy", { path: "src/calls.ts", line: 4, character: 17 });
	expect(output.isError ? output.text : "ok").toBe("ok");
	expect(output.text).toContain("Incoming calls to function middle");
	expect(output.text).toMatch(/caller function top\b.* at src\/calls\.ts:7:17/);
	expect(output.text).toContain("call at src/calls.ts:8:10  return middle() * 2;");
	expect(output.text).not.toContain("caller function leaf");
	expect(details(output).calls).toBe(1);
}, 180_000);

test("outgoing calls name the callee and the call site inside the caller", async () => {
	const output = await call("lsp_call_hierarchy", {
		path: "src/calls.ts",
		line: 4,
		character: 17,
		direction: "outgoing",
	});
	expect(output.isError ? output.text : "ok").toBe("ok");
	expect(output.text).toContain("Outgoing calls from function middle");
	expect(output.text).toMatch(/callee function leaf\b.* at src\/calls\.ts:1:17/);
	expect(output.text).toContain("call at src/calls.ts:5:10  return leaf() + 1;");
	expect(output.text).not.toContain("callee function top");

	const cross = await call("lsp_call_hierarchy", { path: "src/calls.ts", line: 1, character: 17 });
	expect(cross.text).toMatch(/caller function middle\b/);
}, 180_000);
