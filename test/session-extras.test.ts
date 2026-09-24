import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { loadConfig, rememberModel } from "../src/config.ts";
import type {
	HarnessTool,
	IntegrationServices,
	ModelChoice,
	ProviderEvent,
	ProviderGateway,
	ProviderRequest,
	SalamConfig,
} from "../src/contracts.ts";
import { createIntegrations } from "../src/integrations/index.ts";
import { createRuntime } from "../src/runtime/index.ts";
import { Store } from "../src/runtime/store.ts";
import { createTools } from "../src/tools/index.ts";

const model: ModelChoice = { provider: "fixture", model: "default", contextWindow: 128000 };
const usage = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: model.provider,
		model: model.model,
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
		usage,
	};
}

async function fixture(options: {
	title?: (request: ProviderRequest) => Promise<string> | string;
	respond?: (request: ProviderRequest) => AssistantMessage["content"];
	tools?: HarnessTool[];
	ready?: Promise<void>;
	instructions?: () => string[];
}) {
	const root = await mkdtemp(join(tmpdir(), "salam-extras-"));
	const config: SalamConfig = {
		home: join(root, "home"),
		cwd: root,
		selection: model,
		webSearchModel: model,
		providers: { fixture: { kind: "custom-anthropic" } },
		mcpServers: {},
		remotes: {},
		maxTurns: 10,
		maxAgents: 1,
		maxOutputTokens: 1024,
		contextThreshold: 100000,
		reasoning: "off",
	};
	const titleRequests: ProviderRequest[] = [];
	const requests: ProviderRequest[] = [];
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected fixture operation");
	};
	const gateway: ProviderGateway = {
		models: async () => [model],
		webFetch: unexpected,
		webSearch: unexpected,
		async *stream(request): AsyncIterable<ProviderEvent> {
			requests.push(request);
			yield { type: "done", message: message(options.respond?.(request) ?? [{ type: "text", text: "ok" }]) };
		},
		compact: unexpected,
		async recap(request) {
			titleRequests.push(request);
			if (!options.title) throw new Error("no titles in this fixture");
			return message([{ type: "text", text: await options.title(request) }]);
		},
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
		tools: options.tools ?? [],
		...(options.ready ? { ready: () => options.ready! } : {}),
		instructions: async () => options.instructions?.() ?? [],
		skills: async () => [],
		loadSkill: unexpected,
		close: async () => {},
	};
	const tools = await createTools(config);
	const controller = await createRuntime(config, gateway, tools, integrations);
	return {
		root,
		config,
		controller,
		requests,
		titleRequests,
		stored(id: string) {
			const store = new Store(config.home, true);
			try {
				return store.list().find((session) => session.id === id);
			} finally {
				store.close();
			}
		},
		async close() {
			await controller.close();
			await tools.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(10);
	expect(condition()).toBe(true);
}

test("the first message is titled by the model in an isolated tool-less request", async () => {
	const f = await fixture({ title: () => "“Fix the flaky login test.”" });
	try {
		await f.controller.submit("the login test fails every other run, please investigate");
		await until(() => f.controller.snapshot().title === "Fix the flaky login test");
		const request = f.titleRequests[0]!;
		expect(request.tools).toEqual([]);
		expect(request.reasoning).toBe("off");
		expect(request.sessionId).not.toBe(f.controller.snapshot().sessionId);
		expect(request.entries).toHaveLength(1);
		expect(JSON.stringify(request.entries)).toContain("login test fails");
		// Only the conversation's own request reached the stream; the title was a separate recap call.
		expect(f.requests).toHaveLength(1);
		const id = f.controller.snapshot().sessionId;
		await f.controller.close();
		expect(f.stored(id)?.title).toBe("Fix the flaky login test");
	} finally {
		await f.close();
	}
});

test("/title wins over a generation still in flight and /title auto regenerates", async () => {
	let release!: (title: string) => void;
	let calls = 0;
	const f = await fixture({
		title: () => {
			calls++;
			if (calls === 1) return new Promise<string>((resolve) => (release = resolve));
			return "Regenerated title";
		},
	});
	try {
		await f.controller.submit("rename the config loader");
		expect(f.controller.snapshot().title).toBe("rename the config loader");
		await f.controller.command("/title My own name");
		release("Late generated title");
		await Bun.sleep(30);
		expect(f.controller.snapshot().title).toBe("My own name");
		await f.controller.command("/title auto");
		expect(f.controller.snapshot().title).toBe("Regenerated title");
		await f.controller.command("/title   spaced    out   ");
		expect(f.controller.snapshot().title).toBe("spaced out");
	} finally {
		await f.close();
	}
});

test("a failed title generation keeps the first message as the title", async () => {
	const f = await fixture({});
	try {
		await f.controller.submit("   explain   the store schema  ");
		await Bun.sleep(30);
		expect(f.controller.snapshot().title).toBe("explain the store schema");
		expect(f.controller.snapshot().items.some((item) => item.state === "error")).toBe(false);
	} finally {
		await f.close();
	}
});

test("/model choices are remembered per directory, then globally, below explicit selections", async () => {
	const root = await mkdtemp(join(tmpdir(), "salam-model-memory-"));
	const home = join(root, "home");
	const saved = process.env.SALAM_MODEL;
	delete process.env.SALAM_MODEL;
	try {
		const first = join(root, "first");
		const second = join(root, "second");
		expect((await loadConfig({ home, cwd: first })).selection.model).toBe("claude-fable-5-1");
		await rememberModel(home, first, { provider: "openai-codex", model: "gpt-5.6-luna" });
		await rememberModel(home, second, { provider: "anthropic", model: "claude-sonnet-4-5" });
		expect((await loadConfig({ home, cwd: first })).selection).toEqual({
			provider: "openai-codex",
			model: "gpt-5.6-luna",
		});
		// A directory without its own choice follows the most recent one anywhere.
		expect((await loadConfig({ home, cwd: join(root, "third") })).selection.model).toBe("claude-sonnet-4-5");
		expect((await loadConfig({ home, cwd: first, model: "devin/some-model" })).selection.provider).toBe(
			"devin",
		);
		process.env.SALAM_MODEL = "anthropic/claude-fable-5-1";
		expect((await loadConfig({ home, cwd: first })).selection.model).toBe("claude-fable-5-1");
		delete process.env.SALAM_MODEL;
		// A remembered provider that is no longer configured is ignored, never fatal.
		await rememberModel(home, first, { provider: "gone", model: "x" });
		expect((await loadConfig({ home, cwd: first })).selection.model).toBe("claude-fable-5-1");
	} finally {
		if (saved === undefined) delete process.env.SALAM_MODEL;
		else process.env.SALAM_MODEL = saved;
		await rm(root, { recursive: true, force: true });
	}
});

test("out-of-range numeric arguments are clamped with a visible note; other violations still fail", async () => {
	const received: unknown[] = [];
	let call = 0;
	let results: unknown[] = [];
	const f = await fixture({
		tools: [
			{
				name: "probe",
				description: "probe",
				parameters: {
					type: "object",
					properties: { n: { type: "integer", minimum: 1, maximum: 5 }, s: { type: "string" } },
					additionalProperties: false,
				},
				execute: async (args) => {
					received.push(args);
					return { text: "probed" };
				},
			},
		],
		respond: (request) => {
			call++;
			if (call === 1)
				return [
					{ type: "toolCall", id: "a", name: "probe", arguments: { n: 30 } },
					{ type: "toolCall", id: "b", name: "probe", arguments: { n: 3, s: 4 } },
				];
			results = request.entries.filter(
				(entry) => entry.kind === "message" && entry.message.role === "toolResult",
			);
			return [{ type: "text", text: "done" }];
		},
	});
	try {
		await f.controller.submit("go");
		expect(received).toEqual([{ n: 5 }]);
		expect(call).toBe(2);
		expect(JSON.stringify(results[0])).toContain("n 30 → 5 (maximum)");
		expect(JSON.stringify(results[1])).toContain("Invalid tool arguments");
	} finally {
		await f.close();
	}
});

test("MCP servers connect in the background and a session built early gets their instructions before its first request", async () => {
	let settle!: () => void;
	const ready = new Promise<void>((resolve) => (settle = resolve));
	let connected = false;
	const f = await fixture({
		ready,
		instructions: () => (connected ? ['<instructions source="mcp:slow">use it</instructions>'] : []),
	});
	try {
		// createRuntime already returned although the integration has not settled.
		const submitted = f.controller.submit("hello");
		await Bun.sleep(20);
		expect(f.requests).toHaveLength(0);
		expect(f.controller.snapshot().status).toBe("Connecting MCP servers");
		connected = true;
		settle();
		await submitted;
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0]!.system).toContain('<instructions source="mcp:slow">use it</instructions>');
	} finally {
		await f.close();
	}
});

test("a slow MCP server neither delays integration startup nor survives shutdown", async () => {
	const root = await mkdtemp(join(tmpdir(), "salam-mcp-bg-"));
	try {
		const config = await loadConfig({ home: join(root, "home"), cwd: root });
		const marker = `salam-mcp-probe-${process.pid}`;
		config.mcpServers = { slow: { command: "sh", args: ["-c", `exec sleep 30 # ${marker}`] } };
		const started = performance.now();
		const integrations = await createIntegrations(config);
		expect(performance.now() - started).toBeLessThan(1000);
		const list = integrations.tools.find((tool) => tool.name === "mcp_list")!;
		const status = await list.execute(
			{ kind: "servers" },
			{ cwd: root, sessionId: "s", agentId: "main", signal: new AbortController().signal, emit: () => {} },
		);
		expect(status.text).toContain("connecting");
		const closing = performance.now();
		await integrations.close();
		expect(performance.now() - closing).toBeLessThan(3000);
		await Bun.sleep(100);
		expect(Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim()).toBe("");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("eval says when a cell runs on a fresh kernel instead of claiming preserved bindings", async () => {
	const root = await mkdtemp(join(tmpdir(), "salam-eval-fresh-"));
	try {
		const config = await loadConfig({ home: join(root, "home"), cwd: root });
		const services = await createTools(config);
		try {
			const evaluate = services.tools.find((tool) => tool.name === "eval")!;
			const context = {
				cwd: root,
				sessionId: "s",
				agentId: "main",
				signal: new AbortController().signal,
				emit: () => {},
			};
			const first = await evaluate.execute({ language: "py", code: "x = 1" }, context);
			expect(first.text).toContain("Started a fresh py kernel");
			expect(first.text).toContain("Fresh kernel: bindings from this cell persist");
			expect(first.text).not.toContain("Kernel bindings preserved");
			const second = await evaluate.execute({ language: "py", code: "print(x)" }, context);
			expect(second.text).toContain("Kernel bindings preserved.");
			expect(second.text).not.toContain("resh kernel");
		} finally {
			await services.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
