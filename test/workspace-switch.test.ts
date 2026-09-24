import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type {
	AppController,
	IntegrationServices,
	ProviderEvent,
	ProviderGateway,
	SalamConfig,
} from "../src/contracts.ts";
import { createRuntime } from "../src/runtime/index.ts";
import { createTools } from "../src/tools/index.ts";

test("tools planned before a workspace switch cannot mutate the new target", async () => {
	const root = await mkdtemp(join(tmpdir(), "salam-workspace-switch-"));
	const local = join(root, "local");
	const other = join(root, "other");
	await Promise.all([mkdir(local), mkdir(other)]);
	await Promise.all([
		writeFile(join(local, "guarded.txt"), "local original"),
		writeFile(join(other, "guarded.txt"), "other original"),
	]);
	const config: SalamConfig = {
		home: join(root, "home"),
		cwd: local,
		selection: { provider: "fixture", model: "fixture", contextWindow: 128000 },
		webSearchModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
		providers: {},
		mcpServers: {},
		remotes: {},
		maxTurns: 5,
		maxAgents: 1,
		maxOutputTokens: 1024,
		contextThreshold: 100000,
		reasoning: "off",
	};
	const responses: AssistantMessage["content"][] = [
		[
			{
				type: "toolCall",
				id: "switch",
				name: "workspace_switch",
				arguments: { target: "local", cwd: other },
			},
			{
				type: "toolCall",
				id: "unsafe-write",
				name: "write",
				arguments: { path: "guarded.txt", content: "wrong-site write" },
			},
		],
		[
			{
				type: "toolCall",
				id: "informed-write",
				name: "write",
				arguments: { path: "accepted.txt", content: "next-turn write" },
			},
		],
		[{ type: "text", text: "Finished" }],
	];
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected fixture operation");
	};
	const gateway: ProviderGateway = {
		models: async () => [config.selection],
		webFetch: unexpected,
		webSearch: unexpected,
		async *stream(): AsyncIterable<ProviderEvent> {
			const content = responses.shift();
			if (!content) throw new Error("Unexpected extra provider turn");
			yield {
				type: "done",
				message: {
					role: "assistant",
					content,
					api: "anthropic-messages",
					provider: "fixture",
					model: "fixture",
					stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			};
		},
		compact: unexpected,
		recap: unexpected,
		usage: unexpected,
		login: unexpected,
		capabilities: () => ({
			dynamicSystem: false,
			dynamicTools: false,
			signedCompaction: false,
			notesContext: false,
		}),
		authStatus: async () => [],
		close: async () => {},
	};
	const integrations: IntegrationServices = {
		tools: [],
		instructions: async () => [],
		skills: async () => [],
		loadSkill: unexpected,
		close: async () => {},
	};
	const tools = await createTools(config);
	let controller: AppController | undefined;
	try {
		controller = await createRuntime(config, gateway, tools, integrations);
		await controller.submit("Switch to the other checkout and continue editing.");
		expect(controller.snapshot().status).not.toBe("Error");
		expect(await readFile(join(local, "guarded.txt"), "utf8")).toBe("local original");
		expect(await readFile(join(other, "guarded.txt"), "utf8")).toBe("other original");
		expect(await readFile(join(other, "accepted.txt"), "utf8")).toBe("next-turn write");
		expect(await Bun.file(join(local, "accepted.txt")).exists()).toBe(false);
	} finally {
		await controller?.close();
		await tools.close();
		await rm(root, { recursive: true, force: true });
	}
});
