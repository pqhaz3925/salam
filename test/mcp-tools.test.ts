import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Arguments, Json, McpServerConfig, ToolContext, ToolOutput } from "../src/contracts.ts";
import { absolutizePlaywrightLinks } from "../src/integrations/content.ts";
import { McpHub } from "../src/integrations/mcp.ts";
import { createMcpTools } from "../src/integrations/mcp-tools.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6EJAAAAAASUVORK5CYII=";
const DESCRIPTION = `Inspect a value. ${"Extended guidance. ".repeat(30)}\n\nUse negative values to request the error result.`;
const INPUT_SCHEMA = {
	type: "object",
	properties: { value: { type: "number", description: "The value to double." } },
	required: ["value"],
	additionalProperties: false,
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

// Real newline-delimited JSON-RPC over stdio, without mocking McpHub's dispatch/lifecycle.
const SERVER = String.raw`
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
const png = process.env.PNG;
const catalog = JSON.parse(await readFile(process.env.CATALOG, "utf8"));
const outputDir = process.env.PLAYWRIGHT_MCP_OUTPUT_DIR;
const answer = async (request) => {
  const params = request.params ?? {};
  switch (request.method) {
    case "initialize": return {
      protocolVersion: params.protocolVersion,
      serverInfo: { name: process.env.IMPLEMENTATION, version: "1.0" },
      capabilities: { tools: {}, resources: {}, prompts: {} }
    };
    case "tools/list": return { tools: catalog };
    case "resources/list": return { resources: [{ uri: "test://report", name: "report", description: "Current report", mimeType: "text/plain" }] };
    case "resources/templates/list": return { resourceTemplates: [{ uriTemplate: "test://reports/{name}", name: "reports" }] };
    case "resources/read": return { contents: [
      { uri: params.uri, text: "Report ready", mimeType: "text/plain" },
      { uri: "test://report/image", blob: png, mimeType: "image/png" }
    ] };
    case "prompts/list": return { prompts: [{ name: "review", description: "Review a topic", arguments: [{ name: "topic", description: "Subject to review", required: true }] }] };
    case "prompts/get": return {
      description: "Review instructions",
      messages: [
        { role: "user", content: { type: "text", text: "Review: " + params.arguments.topic } },
        { role: "assistant", content: { type: "image", data: png, mimeType: "image/png" } }
      ]
    };
    case "tools/call": {
      if (params.name === "inspect") {
        const value = params.arguments.value;
        return {
          content: [{ type: "text", text: value < 0 ? "Negative input rejected" : "Value inspected" }, { type: "image", data: png, mimeType: "image/png" }],
          isError: value < 0,
          structuredContent: { doubled: value * 2, nested: { accepted: value >= 0 } }
        };
      }
      if (params.name === "new_tool") {
        await writeFile("new-tool.txt", "Available after reconnect\n");
        return { content: [{ type: "text", text: "Created new-tool.txt" }] };
      }
      if (params.name === "browser_snapshot") {
        const base = resolve(params.arguments?._meta?.cwd ?? process.cwd());
        const file = params.arguments?.filename ? resolve(base, params.arguments.filename) : resolve(outputDir, "page-2026-09-24.yml");
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, '- heading "Fixture" [level=1]\n');
        const path = relative(base, file);
        return { content: [{ type: "text", text: "### Page\n- Page URL: https://example.test/relative\n### Snapshot\n- [Snapshot](" + path + ")" }] };
      }
      return { content: [{ type: "text", text: "Fixture tool" }] };
    }
    default: throw new Error("Unsupported method " + request.method);
  }
};
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (!("id" in request)) continue;
  try {
    const result = await answer(request);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: String(error) } }) + "\n");
  }
}
`;

function details(output: ToolOutput): Record<string, Json> {
	if (!output.details || typeof output.details !== "object" || Array.isArray(output.details))
		throw new Error(`Missing details: ${output.text}`);
	return output.details;
}

async function fixture(options: { duplicate?: boolean; implementation?: string; http?: boolean } = {}) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "salam-mcp-lazy-")));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const cwd = join(directory, "server-cwd");
	const output = join(directory, "artifacts");
	await mkdir(cwd);
	const config = await loadConfig({ cwd, home: join(directory, "home") });
	const catalog = [
		{
			name: "inspect",
			description: DESCRIPTION,
			inputSchema: INPUT_SCHEMA,
			annotations: { readOnlyHint: true },
		},
		{
			name: "browser_snapshot",
			description: "Snapshot the page",
			inputSchema: { type: "object", properties: {} },
		},
		...Array.from({ length: 25 }, (_, index) => ({
			name: `extra_${String(index).padStart(2, "0")}`,
			description: `Extra capability ${index}`,
			inputSchema: { type: "object", properties: {} },
		})),
	];
	const catalogPath = join(directory, "catalog.json");
	const script = join(directory, "server.mjs");
	await writeFile(script, SERVER);
	await writeFile(catalogPath, JSON.stringify(catalog));
	const stdio: McpServerConfig = {
		command: process.execPath,
		args: [script],
		env: {
			IMPLEMENTATION: options.implementation ?? "Playwright",
			CATALOG: catalogPath,
			PNG,
			PLAYWRIGHT_MCP_OUTPUT_DIR: output,
			API_TOKEN: "private-fixture-token",
		},
	};
	// The configured key deliberately does not identify the implementation.
	config.mcpServers = { browser: stdio };
	if (options.duplicate) config.mcpServers.second = stdio;
	if (options.http) {
		const http = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method !== "POST") return new Response(null, { status: 405 });
				const rpc = (await request.json()) as {
					id?: number;
					method: string;
					params?: { protocolVersion?: string };
				};
				if (rpc.id === undefined) return new Response(null, { status: 202 });
				let result: unknown;
				if (rpc.method === "initialize")
					result = {
						protocolVersion: rpc.params?.protocolVersion,
						serverInfo: { name: "Playwright", version: "1.0" },
						capabilities: { tools: {} },
					};
				else if (rpc.method === "tools/list") result = { tools: [catalog[1]] };
				else
					result = {
						content: [{ type: "text", text: "### Snapshot\n- [Snapshot](../artifacts/page-2026-09-24.yml)" }],
					};
				return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
			},
		});
		cleanup.push(async () => {
			await http.stop(true);
		});
		config.mcpServers.remote = { url: `http://127.0.0.1:${http.port}/mcp` };
	}
	const hub = await McpHub.create(config);
	cleanup.push(() => hub.close());
	const tools = createMcpTools(hub);
	const context: ToolContext = {
		cwd: join(directory, "switched", "workspace"),
		sessionId: "mcp",
		agentId: "main",
		signal: new AbortController().signal,
		emit: () => {},
	};
	const execute = async (name: string, args: Arguments) => {
		const tool = tools.find((entry) => entry.name === name);
		if (!tool) throw new Error(`Missing tool ${name}`);
		return tool.execute(args, context);
	};
	return { directory, cwd, output, hub, tools, context, execute, catalog, catalogPath };
}

test("MCP baseline stays small while paged discovery provides the exact schema on demand", async () => {
	const { tools, execute } = await fixture();
	expect(tools.map((tool) => tool.name)).toEqual(["mcp_list", "mcp_call"]);
	expect(
		JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))),
	).not.toContain(DESCRIPTION);
	const first = await execute("mcp_list", { query: "EXTRA", limit: 2 });
	expect(details(first).total).toBe(25);
	expect(details(first).nextOffset).toBe(2);
	expect(first.text).toContain("extra_00");
	expect(first.text).not.toContain("extra_02");
	const second = await execute("mcp_list", { query: "extra", offset: details(first).nextOffset, limit: 2 });
	expect(second.text).toContain("extra_02");
	expect(second.text).not.toContain("extra_00");
	const summary = await execute("mcp_list", { query: "inspect" });
	expect(summary.text).not.toContain(DESCRIPTION);
	expect(JSON.stringify(summary.details)).not.toContain("inputSchema");
	const selected = await execute("mcp_list", { server: "browser", tool: "inspect" });
	expect(JSON.parse(selected.text)).toMatchObject({
		server: "browser",
		tool: "inspect",
		description: DESCRIPTION,
		inputSchema: INPUT_SCHEMA,
		readOnly: true,
	});
	expect((await execute("mcp_list", { server: "unknown" })).isError).toBe(true);
	expect((await execute("mcp_list", { offset: -1 })).isError).toBe(true);
});

test("the generic call preserves native images, error flags and structured data together", async () => {
	const { execute } = await fixture();
	const result = await execute("mcp_call", { tool: "inspect", arguments: { value: -3 } });
	expect(result.isError).toBe(true);
	expect(details(result).structuredContent).toEqual({ doubled: -6, nested: { accepted: false } });
	expect(result.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" });
	const visible = result.content
		?.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	expect(visible).toContain("Negative input rejected");
	expect(visible).toContain('"doubled": -6');
	const success = await execute("mcp_call", { tool: "inspect", arguments: { value: 21 } });
	expect(success.isError).toBe(false);
	expect(details(success).structuredContent).toEqual({ doubled: 42, nested: { accepted: true } });
});

test("resource templates, resource images, prompt arguments and prompt images remain reachable", async () => {
	const { execute } = await fixture();
	const resources = await execute("mcp_list", { kind: "resources" });
	expect(resources.text).toContain("test://report");
	expect(resources.text).toContain("test://reports/{name}");
	const resource = await execute("mcp_call", { action: "resource", uri: "test://reports/today" });
	expect(resource.text).toContain("Report ready");
	expect(resource.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" });
	const prompts = await execute("mcp_list", { kind: "prompts" });
	expect(details(prompts).entries).toEqual([
		{
			server: "browser",
			name: "review",
			summary: "Review a topic",
			arguments: [{ name: "topic", required: true, description: "Subject to review" }],
		},
	]);
	const prompt = await execute("mcp_call", {
		action: "prompt",
		name: "review",
		arguments: { topic: "Concurrency" },
	});
	expect(prompt.text).toContain("Review: Concurrency");
	expect(prompt.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" });
	expect(prompt.content?.[0]).toEqual({ type: "text", text: prompt.text });
	expect(details(prompt).roles).toBe("user, assistant");
	expect(
		(await execute("mcp_call", { action: "prompt", name: "review", arguments: { topic: 7 } })).isError,
	).toBe(true);
});

test("ambiguous capabilities require a server instead of dispatching to the first match", async () => {
	const { execute } = await fixture({ duplicate: true });
	for (const args of [
		{ tool: "inspect" },
		{ action: "resource", uri: "test://report" },
		{ action: "prompt", name: "review" },
	]) {
		const result = await execute("mcp_call", args);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("disambiguate");
	}
	expect((await execute("mcp_list", { tool: "inspect" })).isError).toBe(true);
	const selected = await execute("mcp_call", { server: "second", tool: "inspect", arguments: { value: 4 } });
	expect(details(selected).structuredContent).toEqual({ doubled: 8, nested: { accepted: true } });
});

test("reconnect refreshes discovery and execution without rebuilding baseline definitions", async () => {
	const { execute, catalog, catalogPath, cwd } = await fixture();
	expect((await execute("mcp_list", { tool: "new_tool" })).isError).toBe(true);
	await writeFile(
		catalogPath,
		JSON.stringify([
			...catalog,
			{ name: "new_tool", description: "Create a file", inputSchema: { type: "object", properties: {} } },
		]),
	);
	const reconnected = await execute("mcp_call", { action: "reconnect", server: "browser" });
	expect(reconnected.isError).toBe(false);
	expect(details(await execute("mcp_list", { tool: "new_tool" })).tool).toBe("new_tool");
	const called = await execute("mcp_call", { tool: "new_tool" });
	expect(called.isError).toBe(false);
	expect(await readFile(join(cwd, "new-tool.txt"), "utf8")).toBe("Available after reconnect\n");
	const status = await execute("mcp_list", { kind: "servers", server: "browser" });
	expect(status.text).toContain(cwd);
	expect(status.text).toContain("API_TOKEN");
	expect(status.text + JSON.stringify(status.details)).not.toContain("private-fixture-token");
});

test("local Playwright snapshot links use the actual server cwd and HTTP output stays relative", async () => {
	const { execute, directory, output, context } = await fixture({ http: true });
	context.cwd = "ssh://unrelated/workspace";
	const snapshot = join(output, "page-2026-09-24.yml");
	const local = await execute("mcp_call", { server: "browser", tool: "browser_snapshot" });
	expect(local.text).toContain(`- [Snapshot](${snapshot})`);
	expect(local.text).toContain("- Page URL: https://example.test/relative");
	expect(await readFile(snapshot, "utf8")).toBe('- heading "Fixture" [level=1]\n');
	const remote = await execute("mcp_call", { server: "remote", tool: "browser_snapshot" });
	expect(remote.text).toBe("### Snapshot\n- [Snapshot](../artifacts/page-2026-09-24.yml)");
	const override = join(directory, "per-call");
	const custom = await execute("mcp_call", {
		server: "browser",
		tool: "browser_snapshot",
		arguments: { filename: "custom (copy).yml", _meta: { cwd: override } },
	});
	expect(custom.text).toContain(`- [Snapshot](${join(override, "custom (copy).yml")})`);
});

test("an unrelated stdio server's Playwright-looking text is never rewritten", async () => {
	const { execute } = await fixture({ implementation: "Unrelated server" });
	const result = await execute("mcp_call", { tool: "browser_snapshot" });
	expect(result.text).toBe(
		"### Page\n- Page URL: https://example.test/relative\n### Snapshot\n- [Snapshot](../artifacts/page-2026-09-24.yml)",
	);
});

test("artifact conversion leaves code, page links, URLs, missing paths and unrelated local files intact", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "salam-mcp-links-")));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const artifacts = join(directory, ".playwright-mcp");
	await mkdir(artifacts);
	await writeFile(join(artifacts, "page.yml"), "snapshot");
	await writeFile(join(directory, "old.yml"), "not an artifact");
	await utimes(join(directory, "old.yml"), new Date(0), new Date(0));
	const untouched = [
		"### Page",
		"- [Snapshot](.playwright-mcp/page.yml)",
		"### Result",
		"- [Arbitrary page link](.playwright-mcp/page.yml)",
		"- [constructor](.playwright-mcp/page.yml)",
		"- [__proto__](.playwright-mcp/page.yml)",
		"### Ran Playwright code",
		"````js",
		"```",
		"### Snapshot",
		"- [Snapshot](.playwright-mcp/page.yml)",
		"````",
		"~~~yaml",
		"### Snapshot",
		"- [Snapshot](.playwright-mcp/page.yml)",
		"~~~",
		"### Snapshot",
		"- [Snapshot](https://example.test/page.yml)",
		"- [Snapshot](//example.test/page.yml)",
		"- [Snapshot](/server-relative/page.yml)",
		"- [Snapshot](file:///tmp/page.yml)",
		"- [Snapshot](.playwright-mcp/page.yml?download=1)",
		"- [Snapshot](.playwright-mcp/page.yml#fragment)",
		"- [Snapshot](missing.yml)",
		"- [Snapshot](old.yml)",
	].join("\n");
	const result = absolutizePlaywrightLinks(
		[
			{ type: "text", text: `${untouched}\n- [Snapshot](.playwright-mcp/page.yml)` },
			{ type: "image", data: PNG, mimeType: "image/png" },
		],
		{ base: directory, artifactRoots: [artifacts], since: Date.now() },
	);
	expect(result.rewritten).toBe(1);
	expect(result.blocks[0]?.text).toBe(`${untouched}\n- [Snapshot](${resolve(artifacts, "page.yml")})`);
	expect(result.blocks[1]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
});
