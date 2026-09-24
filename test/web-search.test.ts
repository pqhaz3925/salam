import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { loadConfig } from "../src/config.ts";
import { createProviderGateway } from "../src/providers/index.ts";
import { createWebSearchTool } from "../src/tools/web.ts";

// Real SDK decoding, against a local native-protocol endpoint; no external inference.
test("search requires native search and citations, and charges incomplete or unverified answers", async () => {
	const root = await mkdtemp(join(tmpdir(), "salam-web-search-"));
	let scenario: "page-only" | "uncited" | "complete" | "incomplete" = "page-only";
	const source = "https://example.com/official-reference";
	const uncitedSource = "https://uncited.example/irrelevant-result";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ models: [] });
			const search = {
				id: "ws_fixture",
				type: "web_search_call",
				status: "completed",
				action:
					scenario === "page-only"
						? { type: "open_page", url: source }
						: {
								type: "search",
								query: "official reference",
								sources: [
									{ type: "url", url: source },
									{ type: "url", url: uncitedSource },
								],
							},
			};
			const message = {
				id: "msg_fixture",
				type: "message",
				role: "assistant",
				status: "completed",
				content: [
					{
						type: "output_text",
						text: "The official reference documents the behavior.",
						annotations:
							scenario === "uncited"
								? []
								: [
										{
											type: "url_citation",
											url: source,
											title: "Official reference",
											start_index: 0,
											end_index: 44,
										},
									],
					},
				],
			};
			const incomplete = scenario === "incomplete";
			const events = [
				{ type: "response.output_item.done", output_index: 0, item: search },
				{ type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
				{ type: "response.output_item.done", output_index: 1, item: message },
				{
					type: incomplete ? "response.incomplete" : "response.completed",
					response: {
						id: "resp_fixture",
						status: incomplete ? "incomplete" : "completed",
						output: [search, message],
						...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
						usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
					},
				},
			];
			return new Response(
				events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
	});
	const config = await loadConfig({ cwd: root, home: root });
	config.providers["openai-codex"] = { kind: "openai-codex", baseUrl: server.url.toString() };
	const claims = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
	).toString("base64url");
	await writeFile(
		join(root, "credentials.json"),
		JSON.stringify({
			version: 1,
			providers: { "openai-codex": { kind: "openai-codex", apiKey: `e30.${claims}.fixture` } },
		}),
	);
	const gateway = await createProviderGateway(config);
	const charges: Usage[] = [];
	const tool = createWebSearchTool(gateway, (_context, _selection, usage) => charges.push(usage));
	const context = {
		cwd: root,
		sessionId: "fixture",
		agentId: "main",
		signal: AbortSignal.timeout(10000),
		emit: () => {},
	};
	try {
		const page = await tool.execute({ query: "official reference" }, context);
		expect(page.isError).toBe(true);
		scenario = "uncited";
		const uncited = await tool.execute({ query: "official reference" }, context);
		expect(uncited.isError).toBe(true);
		scenario = "complete";
		const complete = await tool.execute({ query: "official reference" }, context);
		expect(complete.isError).not.toBe(true);
		expect(complete.text).toContain(source);
		expect(complete.text).not.toContain(uncitedSource);
		scenario = "incomplete";
		const partial = await tool.execute({ query: "official reference" }, context);
		expect(partial.isError).toBe(true);
		// Failed verification and partial completion still consumed provider tokens.
		expect(charges.reduce((total, usage) => total + usage.totalTokens, 0)).toBe(400);
	} finally {
		await gateway.close();
		await server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});
