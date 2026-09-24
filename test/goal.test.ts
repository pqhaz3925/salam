import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { expect, test } from "bun:test";
import type {
	AppController,
	IntegrationServices,
	ProviderEvent,
	ProviderGateway,
	SalamConfig,
} from "../src/contracts.ts";
import { createRuntime } from "../src/runtime/index.ts";
import { createTools } from "../src/tools/index.ts";

test("a progress answer continues the goal, but a stale completion cannot finish its replacement", async () => {
	const root = await mkdtemp(join(tmpdir(), "salam-goal-"));
	const config: SalamConfig = {
		home: join(root, "home"),
		cwd: root,
		selection: { provider: "fixture", model: "fixture", contextWindow: 128000 },
		webSearchModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
		providers: {},
		mcpServers: {},
		remotes: {},
		maxTurns: 1,
		maxAgents: 1,
		maxOutputTokens: 1024,
		contextThreshold: 100000,
		reasoning: "off",
	};
	const secondTurn = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let controller: AppController | undefined;
	let turn = 0;
	let originalId = "";
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected fixture operation");
	};
	const gateway: ProviderGateway = {
		models: async () => [config.selection],
		webFetch: unexpected,
		webSearch: unexpected,
		async *stream(): AsyncIterable<ProviderEvent> {
			let content: AssistantMessage["content"];
			switch (++turn) {
				case 1:
					originalId = controller!.snapshot().goal!.id;
					content = [{ type: "text", text: "Work is still in progress." }];
					break;
				case 2:
					secondTurn.resolve();
					await release.promise;
					content = [
						{
							type: "toolCall",
							id: "stale",
							name: "goal_complete",
							arguments: { goalId: originalId, summary: "Original goal finished" },
						},
					];
					break;
				case 3:
					expect(controller!.snapshot().goal?.status).toBe("active");
					content = [
						{
							type: "toolCall",
							id: "write-replacement",
							name: "write",
							arguments: { path: "replacement.txt", content: "replacement work" },
						},
					];
					break;
				case 4:
					content = [
						{
							type: "toolCall",
							id: "complete-current",
							name: "goal_complete",
							arguments: { goalId: controller!.snapshot().goal!.id, summary: "Replacement file created" },
						},
					];
					break;
				case 5:
					content = [{ type: "text", text: "Replacement work finished." }];
					break;
				default:
					throw new Error("Completed goal kept running");
			}
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
	try {
		controller = await createRuntime(config, gateway, tools, integrations);
		const original = controller.command("/goal Original task");
		await Promise.race([
			secondTurn.promise,
			original.then(() => {
				throw new Error("Goal stopped at an intermediate progress answer");
			}),
		]);
		await controller.command("/goal Create the replacement file instead");
		release.resolve();
		await original;
		expect(controller.snapshot().goal?.status).toBe("completed");
		expect(await Bun.file(join(root, "replacement.txt")).text()).toBe("replacement work");
		expect(turn).toBe(5);
		expect(
			controller
				.snapshot()
				.items.some((item) => item.kind === "assistant" && item.text === "Replacement work finished."),
		).toBe(true);
	} finally {
		release.resolve();
		await controller?.close();
		await tools.close();
		await rm(root, { recursive: true, force: true });
	}
});
