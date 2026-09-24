import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { expect, test } from "bun:test";
import type {
	AppController,
	HarnessTool,
	IntegrationServices,
	ModelChoice,
	ProviderEvent,
	ProviderGateway,
	ProviderRequest,
	SalamConfig,
} from "../src/contracts.ts";
import { contextFor } from "../src/providers/anthropic.ts";
import { createRuntime } from "../src/runtime/index.ts";
import { Store } from "../src/runtime/store.ts";
import { createTools } from "../src/tools/index.ts";

const opus: ModelChoice = { provider: "anthropic", model: "same-name", contextWindow: 128000 };
const gpt: ModelChoice = { provider: "codex", model: "same-name", contextWindow: 128000 };
type RequestSnapshot = Omit<ProviderRequest, "signal">;

async function fixture(
	respond: (request: ProviderRequest) => Promise<AssistantMessage["content"]> | AssistantMessage["content"],
	integrationTools: HarnessTool[] = [],
	notes = false,
) {
	const root = await mkdtemp(join(tmpdir(), "salam-model-switch-"));
	const config: SalamConfig = {
		home: join(root, "home"),
		cwd: root,
		selection: opus,
		webSearchModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
		providers: {},
		mcpServers: {},
		remotes: {},
		maxTurns: 10,
		maxAgents: 1,
		maxOutputTokens: 1024,
		contextThreshold: 100000,
		reasoning: "off",
	};
	const requests: RequestSnapshot[] = [];
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected fixture operation");
	};
	const gateway: ProviderGateway = {
		models: async () => [opus, gpt],
		webFetch: unexpected,
		webSearch: unexpected,
		async *stream(request): AsyncIterable<ProviderEvent> {
			const { signal: _signal, ...snapshot } = request;
			requests.push(structuredClone(snapshot));
			const content = await respond(request);
			yield {
				type: "done",
				message: {
					role: "assistant",
					content,
					api: request.selection.provider === opus.provider ? "anthropic-messages" : "openai-codex-responses",
					provider: request.selection.provider,
					model: request.selection.model,
					stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
					timestamp: Date.now(),
					usage: {
						input: 100,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 110,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			};
		},
		compact: unexpected,
		recap: unexpected,
		usage: unexpected,
		login: unexpected,
		capabilities: (selection) => ({
			dynamicSystem: false,
			dynamicTools: false,
			signedCompaction: false,
			notesContext: notes && selection.provider === opus.provider,
		}),
		authStatus: async () => [],
		close: async () => {},
	};
	const integrations: IntegrationServices = {
		tools: integrationTools,
		instructions: async () => [],
		skills: async () => [],
		loadSkill: unexpected,
		close: async () => {},
	};
	const tools = await createTools(config);
	let controller = await createRuntime(config, gateway, tools, integrations);
	return {
		root,
		config,
		requests,
		get controller() {
			return controller;
		},
		async reopen(id: string) {
			await controller.close();
			controller = await createRuntime(config, gateway, tools, integrations, { sessionId: id });
		},
		async close() {
			await controller.close();
			await tools.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("model turns fork independently without replaying tools or replacing either model's cached prefix", async () => {
	const f = await fixture((request) => {
		const last = request.entries.at(-1)!;
		if (last.kind === "message" && last.message.role === "toolResult")
			return [{ type: "text", text: `${request.selection.provider} wrote its file` }];
		const text =
			last.kind === "message" && typeof last.message.content === "string" ? last.message.content : "";
		if (text === "alpha" || text === "beta")
			return [
				{
					type: "toolCall",
					id: "same-call-id",
					name: "write",
					arguments: { path: `${text}.txt`, content: text },
				},
			];
		return [{ type: "text", text: `Continued ${request.selection.provider}: ${text}` }];
	});
	try {
		const original = f.controller.snapshot().sessionId;
		await f.controller.submit("alpha");
		const opusRequest = f.requests.at(-1)!;
		await f.controller.command("/loop 10m report progress");
		await f.controller.command(`/model ${gpt.provider}/${gpt.model}`);
		expect(f.controller.snapshot().sessionId).toBe(original);
		expect(f.controller.snapshot().loops).toBe(1);
		await f.controller.submit("beta");
		const gptRequest = f.requests.at(-1)!;
		expect(await Bun.file(join(f.root, "alpha.txt")).text()).toBe("alpha");
		expect(await Bun.file(join(f.root, "beta.txt")).text()).toBe("beta");
		const renderedTools = f.controller.snapshot().items.filter((item) => item.kind === "tool");
		expect(new Set(renderedTools.map((item) => item.id)).size).toBe(2);
		expect(renderedTools.map((item) => item.state)).toEqual(["done", "done"]);
		const points = f.controller.checkpoints().filter((point) => point.kind === "assistant");
		expect(points.map((point) => point.selection?.provider)).toEqual([
			"anthropic",
			"anthropic",
			"codex",
			"codex",
		]);
		await f.controller.command(`/model ${opus.provider}/${opus.model}`);
		await f.controller.submit("return to alpha");
		const returned = f.requests.at(-1)!;
		expect(returned.cacheKey).toBe(opusRequest.cacheKey);
		expect(returned.sessionId).toBe(opusRequest.sessionId);
		expect(returned.entries.slice(0, opusRequest.entries.length)).toEqual(opusRequest.entries);
		expect(returned.system).toEqual(opusRequest.system);
		expect(returned.tools).toEqual(opusRequest.tools);
		expect(returned.cacheBoundary).toBe(opusRequest.entries.at(-1)!.id);
		const store = new Store(f.config.home, true);
		const sourceHistory = store.history(original);
		store.close();
		await f.controller.command(`/rewind ${points[2]!.id} both`);
		const branch = f.controller.snapshot().sessionId;
		expect(branch).not.toBe(original);
		expect(f.controller.snapshot().selection.provider).toBe(gpt.provider);
		expect(await Bun.file(join(f.root, "alpha.txt")).text()).toBe("alpha");
		expect(await Bun.file(join(f.root, "beta.txt")).exists()).toBe(false);
		await f.controller.submit("branch before beta");
		const forked = f.requests.at(-1)!;
		expect(forked.cacheKey).toBe(gptRequest.cacheKey);
		expect(forked.sessionId).not.toBe(gptRequest.sessionId);
		expect(
			forked.entries.some(
				(entry) =>
					entry.kind === "message" &&
					entry.message.role === "assistant" &&
					entry.origin?.provider === gpt.provider,
			),
		).toBe(false);
		const preserved = new Store(f.config.home, true);
		expect(preserved.history(original)).toEqual(sourceHistory);
		preserved.close();
		await f.reopen(branch);
		await f.controller.command(`/model ${opus.provider}/${opus.model}`);
		await f.controller.submit("after reload");
		const resumed = f.requests.at(-1)!;
		expect(resumed.cacheKey).toBe(opusRequest.cacheKey);
		expect(
			resumed.entries
				.slice(0, opusRequest.entries.length)
				.map((entry) => (entry.kind === "message" ? entry.message : entry)),
		).toEqual(opusRequest.entries.map((entry) => (entry.kind === "message" ? entry.message : entry)));
		expect(
			resumed.entries.some(
				(entry) =>
					entry.kind === "message" &&
					entry.message.role === "toolResult" &&
					entry.origin?.provider === gpt.provider,
			),
		).toBe(false);
	} finally {
		await f.close();
	}
});

test("a queued model switch waits for paired tool results and preserves an active goal", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let controller: AppController;
	const hold: HarnessTool = {
		name: "hold",
		description: "Hold a real tool boundary",
		parameters: { type: "object", properties: {} },
		async execute() {
			entered.resolve();
			await release.promise;
			return { text: "held tool completed" };
		},
	};
	const f = await fixture(
		(request) => {
			if (request.selection.provider === opus.provider)
				return [{ type: "toolCall", id: "held", name: "hold", arguments: {} }];
			const context = contextFor(request, false);
			expect(JSON.stringify(context.messages)).toContain("held tool completed");
			if (controller.snapshot().goal?.status === "active")
				return [
					{
						type: "toolCall",
						id: "finish",
						name: "goal_complete",
						arguments: { goalId: controller.snapshot().goal!.id, summary: "Verified held tool completed" },
					},
				];
			return [{ type: "text", text: "Goal finished on GPT" }];
		},
		[hold],
	);
	controller = f.controller;
	try {
		const task = controller.command("/goal Finish the held operation");
		await entered.promise;
		await controller.command(`/model ${gpt.provider}/${gpt.model}`);
		expect(controller.snapshot().selection.provider).toBe(opus.provider);
		expect(controller.snapshot().goal?.status).toBe("active");
		release.resolve();
		await task;
		expect(controller.snapshot().goal?.status).toBe("completed");
		expect(f.requests.map((request) => request.selection.provider)).toEqual(["anthropic", "codex", "codex"]);
		expect(
			controller
				.snapshot()
				.items.some((item) => item.kind === "assistant" && item.text === "Goal finished on GPT"),
		).toBe(true);
		await controller.submit("The first real user prompt after a goal-first dialog");
		expect(f.requests.at(-1)!.firstUserText).toBe(f.requests[0]!.firstUserText);
	} finally {
		release.resolve();
		await f.close();
	}
});

test("returning to a notes-backed model preserves its notebook and retained-user prefix after other-model updates", async () => {
	const f = await fixture(
		(request) => {
			const last = request.entries.at(-1)!;
			if (
				last.kind === "message" &&
				typeof last.message.content === "string" &&
				last.message.content.startsWith("save ")
			)
				return [
					{
						type: "toolCall",
						id: `notes-${request.selection.provider}`,
						name: "context_notes",
						arguments: { text: last.message.content.slice(5) },
					},
				];
			return [{ type: "text", text: "Noted" }];
		},
		[],
		true,
	);
	try {
		await f.controller.submit("save notebook version one");
		await f.controller.submit("an additional turn");
		await f.controller.command("/compact");
		await f.controller.submit("after rolling");
		const before = f.requests.at(-1)!;
		await f.controller.command(`/model ${gpt.provider}/${gpt.model}`);
		await f.controller.submit("save notebook version two");
		await f.controller.command(`/model ${opus.provider}/${opus.model}`);
		await f.controller.submit("back with a new user prompt");
		const after = f.requests.at(-1)!;
		expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
		expect(JSON.stringify(after.entries[0])).toContain("notebook version one");
		expect(
			after.entries.some(
				(entry) =>
					entry.kind === "message" &&
					entry.message.role === "toolResult" &&
					entry.origin?.provider === gpt.provider,
			),
		).toBe(true);
		expect(after.cacheKey).toBe(before.cacheKey);
	} finally {
		await f.close();
	}
});
