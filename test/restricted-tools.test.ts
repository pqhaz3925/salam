import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type {
	HistoryEntry,
	IntegrationServices,
	ModelChoice,
	ProviderEvent,
	ProviderGateway,
	ProviderRequest,
	SalamConfig,
} from "../src/contracts.ts";
import { createRuntime } from "../src/runtime/index.ts";
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

async function fixture(
	tools: string[] | undefined,
	respond: (request: ProviderRequest) => AssistantMessage["content"],
) {
	const root = await mkdtemp(join(tmpdir(), "salam-restricted-"));
	const config: SalamConfig = {
		home: join(root, "home"),
		cwd: root,
		selection: model,
		webSearchModel: model,
		providers: { fixture: { kind: "custom-anthropic" } },
		mcpServers: {},
		remotes: {},
		maxTurns: 10,
		autoTitle: false,
		maxAgents: 1,
		maxOutputTokens: 1024,
		contextThreshold: 100000,
		reasoning: "off",
		...(tools ? { tools } : {}),
	};
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
			yield { type: "done", message: message(respond(request)) };
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
	const services = await createTools(config);
	try {
		const controller = await createRuntime(config, gateway, services, integrations);
		return {
			root,
			controller,
			requests,
			async close() {
				await controller.close();
				await services.close();
				await rm(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await services.close();
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

function toolResults(request: ProviderRequest): string {
	return JSON.stringify(
		request.entries.filter(
			(entry: HistoryEntry) => entry.kind === "message" && entry.message.role === "toolResult",
		),
	);
}

test("a shell-only set offers a bare shell and a system prompt that names no other tool", async () => {
	let call = 0;
	const f = await fixture(["shell"], () => {
		call++;
		if (call === 1)
			return [
				{ type: "toolCall", id: "a", name: "shell", arguments: { command: `cat ${join(f.root, "a.txt")}` } },
			];
		return [{ type: "text", text: "done" }];
	});
	try {
		await writeFile(join(f.root, "a.txt"), "MINIMAL_CONTENT\n");
		await f.controller.submit("show a.txt");
		const first = f.requests[0]!;
		expect(first.tools.map((tool) => tool.name)).toEqual(["shell"]);
		const shell = first.tools[0]!;
		expect(Object.keys((shell.parameters as { properties: object }).properties)).not.toContain("background");
		const prompt = [...first.system, shell.description].join("\n");
		expect(prompt).not.toMatch(/\b[a-z]+(?:_[a-z]+)+\b|`(read|grep|glob|edit)`|memory tool/);
		// cat is refused by the full shell in favour of read; the bare shell runs it.
		expect(toolResults(f.requests[1]!)).toContain("MINIMAL_CONTENT");
	} finally {
		await f.close();
	}
});

test("an unoffered tool cannot be called and an unknown tool name is rejected", async () => {
	let call = 0;
	const f = await fixture(["shell", "edit"], () => {
		call++;
		if (call === 1) return [{ type: "toolCall", id: "a", name: "read", arguments: { path: "a.txt" } }];
		return [{ type: "text", text: "done" }];
	});
	try {
		await f.controller.submit("go");
		expect(f.requests[0]!.tools.map((tool) => tool.name).sort()).toEqual(["edit", "shell"]);
		expect(toolResults(f.requests[1]!)).toContain("Tool unavailable: read");
	} finally {
		await f.close();
	}
	await expect(fixture(["shell", "nope"], () => [])).rejects.toThrow("Unknown tool nope");
});

test("the lean set registers and names no tool outside itself", async () => {
	const lean = [
		"shell",
		"command_output",
		"command_stop",
		"web_search",
		"web_fetch",
		"ask",
		"view_image",
		"todo",
		"goal_complete",
		"goal_pause",
		"agents_spawn",
		"agents_status",
		"agents_wait",
		"agents_send",
		"agents_cancel",
		"history_read",
		"history_search",
	];
	const f = await fixture(lean, () => [{ type: "text", text: "done" }]);
	try {
		await f.controller.submit("hi");
		const request = f.requests[0]!;
		expect(request.tools.map((tool) => tool.name).sort()).toEqual([...lean].sort());
		const prompt = [
			...request.system,
			...request.tools.map((tool) => `${tool.description}\n${JSON.stringify(tool.parameters)}`),
		].join("\n");
		// Every snake_case tool identifier the model is told about must be one it has.
		expect(prompt).toContain("read and write them with the shell");
		expect(prompt).toContain("Why:");
		const named = new Set(prompt.match(/\b[a-z]+(?:_[a-z]+)+\b/g));
		// open_page is the provider-side Codex tool web_fetch runs on; in_progress is a todo status.
		const notTools = ["open_page", "in_progress"];
		expect([...named].filter((name) => !lean.includes(name) && !notTools.includes(name))).toEqual([]);
	} finally {
		await f.close();
	}
});
