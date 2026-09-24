import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { createProviderGateway } from "../src/providers/index.ts";
import { createWebTool } from "../src/tools/web.ts";

test("native fetch preserves sentences split by citations without repeating source passages", async () => {
	const root = await mkdtemp(join(tmpdir(), "salam-web-fetch-"));
	const url = "https://example.com/article";
	const citation = {
		type: "char_location",
		document_index: 0,
		document_title: "Fixture page",
		start_char_index: 0,
		end_char_index: 18,
		cited_text: "Evidence sentence.",
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			Response.json({
				id: "msg_fixture",
				type: "message",
				role: "assistant",
				model: "claude-fable-5-1",
				content: [
					{ type: "server_tool_use", id: "fetch_fixture", name: "web_fetch", input: { url } },
					{
						type: "web_fetch_tool_result",
						tool_use_id: "fetch_fixture",
						content: {
							type: "web_fetch_result",
							url,
							content: {
								type: "document",
								title: "Fixture page",
								source: { type: "text", media_type: "text/plain", data: citation.cited_text },
							},
						},
					},
					{ type: "text", text: "First clause,", citations: [citation] },
					{ type: "text", text: " second clause.", citations: [citation] },
				],
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 80, output_tokens: 20 },
			}),
	});
	const config = await loadConfig({ cwd: root, home: root });
	config.providers.anthropic = { kind: "anthropic", baseUrl: server.url.toString() };
	await writeFile(
		join(root, "credentials.json"),
		JSON.stringify({
			version: 1,
			providers: { anthropic: { kind: "anthropic", apiKey: "sk-ant-oat01-fixture" } },
		}),
	);
	const gateway = await createProviderGateway(config);
	try {
		const tool = createWebTool(
			gateway,
			() => config.selection,
			() => {},
		);
		const result = await tool.execute(
			{ url },
			{
				cwd: root,
				sessionId: "fixture",
				agentId: "main",
				signal: AbortSignal.timeout(10000),
				emit: () => {},
			},
		);
		expect(result.isError).not.toBe(true);
		expect(result.text).toContain("First clause, second clause.");
		expect(result.text).toContain(url);
		expect(result.text).not.toContain(citation.cited_text);
	} finally {
		await gateway.close();
		await server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});
