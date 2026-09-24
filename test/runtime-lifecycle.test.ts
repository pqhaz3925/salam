import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { loadConfig } from "../src/config.ts";
import type {
	AppController,
	AppSnapshot,
	HarnessTool,
	IntegrationServices,
	ProviderGateway,
	ProviderRequest,
	SalamConfig,
	ToolContext,
	ToolOutput,
} from "../src/contracts.ts";
import { createRuntime } from "../src/runtime/index.ts";
import { Store } from "../src/runtime/store.ts";
import { createTools } from "../src/tools/index.ts";

type Reply = AssistantMessage["content"];
const say = (text: string): Reply => [{ type: "text", text }];
const call = (name: string, args: Record<string, unknown> = {}): Reply => [
	{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args },
];
const results = (request: ProviderRequest, name: string): ToolResultMessage[] =>
	request.entries.flatMap(({ kind, ...entry }) =>
		kind === "message" &&
		"message" in entry &&
		entry.message.role === "toolResult" &&
		entry.message.toolName === name
			? [entry.message]
			: [],
	);
const resultText = (result: ToolResultMessage) =>
	result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
const lastMainSpawns = (requests: ProviderRequest[]) =>
	results(
		requests.filter((request) => !request.firstUserText.startsWith("You are agent ")).at(-1)!,
		"agents_spawn",
	);

function until(controller: AppController, predicate: (snapshot: AppSnapshot) => boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const stop = controller.subscribe(() => {
		if (predicate(controller.snapshot())) {
			stop();
			resolve();
		}
	});
	if (predicate(controller.snapshot())) {
		stop();
		resolve();
	}
	return promise;
}

async function fixture(
	respond: (request: ProviderRequest, main: boolean, turn: number) => Reply | Promise<Reply>,
	options: {
		tools?: HarnessTool[];
		interactive?: boolean;
		maxAgents?: number;
		contextWindow?: number;
		usage?: Usage;
		bridge?: (
			invoke: (name: string, args: Record<string, unknown>, context: ToolContext) => Promise<ToolOutput>,
		) => void;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "salam-lifecycle-"));
	const config: SalamConfig = {
		home: join(root, "home"),
		cwd: join(root, "workspace"),
		selection: { provider: "fixture", model: "default", contextWindow: options.contextWindow ?? 128000 },
		webSearchModel: { provider: "fixture", model: "default" },
		providers: {
			fixture: {
				kind: "custom-openai",
				baseUrl: "http://localhost:1",
				models: [{ id: "default" }, { id: "explicit-child" }],
			},
		},
		mcpServers: {},
		remotes: {},
		maxTurns: 20,
		maxAgents: options.maxAgents ?? 2,
		maxOutputTokens: 1024,
		contextThreshold: 100000,
		reasoning: "off",
	};
	await mkdir(config.cwd);
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected provider operation");
	};
	const requests: ProviderRequest[] = [];
	const turns = new Map<string, number>();
	const gateway: ProviderGateway = {
		models: async () => [
			config.selection,
			{ provider: "fixture", model: "explicit-child", contextWindow: 128000 },
		],
		webFetch: unexpected,
		webSearch: unexpected,
		async *stream(request) {
			requests.push(request);
			const main = !request.firstUserText.startsWith("You are agent ");
			const identity = main ? "main" : request.firstUserText;
			const turn = (turns.get(identity) ?? 0) + 1;
			turns.set(identity, turn);
			const content = await respond(request, main, turn);
			yield {
				type: "done",
				message: {
					role: "assistant",
					content,
					api: "anthropic-messages",
					provider: request.selection.provider,
					model: request.selection.model,
					stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
					timestamp: Date.now(),
					usage: options.usage ?? {
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
		tools: options.tools ?? [],
		instructions: async () => [],
		skills: async () => [],
		loadSkill: unexpected,
		close: async () => {},
	};
	const tools = await createTools(config);
	if (options.bridge) {
		const setInvoker = tools.setToolInvoker?.bind(tools);
		tools.setToolInvoker = (invoke) => {
			setInvoker?.(invoke);
			options.bridge!(invoke);
		};
	}
	let controller = await createRuntime(config, gateway, tools, integrations, {
		interactive: options.interactive,
	});
	return {
		root,
		config,
		requests,
		gateway,
		get controller() {
			return controller;
		},
		async reopen() {
			const sessionId = controller.snapshot().sessionId;
			await controller.close();
			controller = await createRuntime(config, gateway, tools, integrations, {
				sessionId,
				interactive: options.interactive,
			});
		},
		async close() {
			await controller.close();
			await tools.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("a resumed million-token model continues past 120k without truncating cached history", async () => {
	const f = await fixture(
		(_request, _main, turn) => say(turn === 1 ? "Keep the original decision" : "Continued"),
		{
			contextWindow: 1_000_000,
			usage: {
				input: 2480,
				output: 1,
				cacheRead: 121520,
				cacheWrite: 0,
				totalTokens: 124001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	);
	try {
		f.config.contextThreshold = (
			await loadConfig({ cwd: f.config.cwd, home: f.config.home })
		).contextThreshold;
		await f.controller.submit("Retain this requirement");
		const sessionId = f.controller.snapshot().sessionId;
		await f.reopen();
		expect(f.controller.snapshot().contextTokens).toBe(124001);
		expect(f.controller.snapshot().contextLimit).toBe(1_000_000);
		await f.controller.submit("Continue the same task");
		expect(f.controller.snapshot().sessionId).toBe(sessionId);
		expect(f.controller.snapshot().status).not.toBe("Error");
		expect(f.requests).toHaveLength(2);
		const history = f.requests[1]!.entries;
		expect(
			history.some(
				(entry) =>
					entry.kind === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "Retain this requirement",
			),
		).toBe(true);
		expect(
			history.some(
				(entry) =>
					entry.kind === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some(
						(block) => block.type === "text" && block.text === "Keep the original decision",
					),
			),
		).toBe(true);
		expect(history.some((entry) => entry.kind === "compaction")).toBe(false);
	} finally {
		await f.close();
	}
});

test("an explicit context cap still stops a model with a larger window", async () => {
	const f = await fixture(() => say("Current response"), {
		contextWindow: 1_000_000,
		usage: {
			input: 123999,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 124000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	try {
		await writeFile(join(f.config.home, "config.json"), JSON.stringify({ contextThreshold: 120000 }));
		f.config.contextThreshold = (
			await loadConfig({ cwd: f.config.cwd, home: f.config.home })
		).contextThreshold;
		await f.controller.submit("First request");
		await f.controller.submit("Do not exceed the configured cap");
		expect(f.requests).toHaveLength(1);
		expect(f.controller.snapshot().status).toBe("Error");
	} finally {
		await f.close();
	}
});

test("an oversized configured cap cannot consume the model's response reserve", async () => {
	const f = await fixture(() => say("Current response"), {
		contextWindow: 32000,
		usage: {
			input: 30999,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 31000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	try {
		await writeFile(join(f.config.home, "config.json"), JSON.stringify({ contextThreshold: 1_000_000 }));
		f.config.contextThreshold = (
			await loadConfig({ cwd: f.config.cwd, home: f.config.home })
		).contextThreshold;
		await f.controller.submit("First request");
		await f.controller.submit("Leave room for the requested response");
		expect(f.requests).toHaveLength(1);
		expect(f.controller.snapshot().status).toBe("Error");
	} finally {
		await f.close();
	}
});

test("modern MCP schemas validate tuple arguments before any tool side effect", async () => {
	const f = await fixture(
		(_request, _main, turn) => {
			if (turn === 1) return call("modern_schema", { values: [7, 8] });
			if (turn === 2) return call("modern_schema", { values: ["wrong"] });
			if (turn === 3) return call("modern_schema", { values: [7] });
			return say("Validated modern arguments");
		},
		{
			tools: [
				{
					name: "modern_schema",
					description: "Apply one validated numeric value",
					parameters: {
						$schema: "https://json-schema.org/draft/2020-12/schema",
						type: "object",
						properties: {
							values: { type: "array", prefixItems: [{ type: "integer" }], items: false, minItems: 1 },
						},
						required: ["values"],
						additionalProperties: false,
					},
					async execute(args, context) {
						await writeFile(join(context.cwd, "modern-effects"), `${JSON.stringify(args.values)}\n`, {
							flag: "a",
						});
						return { text: "Value applied" };
					},
				},
			],
		},
	);
	try {
		await f.controller.submit("Apply only arguments that satisfy the advertised schema");
		const outputs = results(f.requests.at(-1)!, "modern_schema");
		expect(outputs.map((output) => output.isError === true)).toEqual([true, true, false]);
		expect(await Bun.file(join(f.config.cwd, "modern-effects")).text()).toBe("[7]\n");
	} finally {
		await f.close();
	}
});

test("unfinished phased todos survive resume, reject goal completion, and nudge a premature text stop", async () => {
	let controller: AppController;
	const f = await fixture((_request, _main, turn) => {
		const goalId = controller.snapshot().goal!.id;
		switch (turn) {
			case 1:
				return call("todo", {
					items: [{ content: "Verify result", phase: "Verification", status: "pending" }],
				});
			case 2:
				return say("Progress, not completion");
			case 3:
				return call("goal_complete", { goalId, summary: "Premature claim" });
			case 4:
				return call("goal_pause", { goalId, reason: "User must supply a test credential" });
			case 5:
				return say("Blocked on the missing credential");
			case 6:
				return call("todo", {
					items: [{ content: "Verify result", phase: "Verification", status: "completed" }],
				});
			case 7:
				return call("goal_complete", { goalId, summary: "Verification finished" });
			default:
				return say("Finished");
		}
	});
	controller = f.controller;
	f.config.maxTurns = 1;
	try {
		await controller.command("/goal Complete the work");
		expect(controller.snapshot().goal?.status).toBe("paused");
		expect(results(f.requests[3]!, "goal_complete")[0]?.isError).toBe(true);
		expect(
			f.requests[2]!.entries.some(
				(entry) =>
					entry.kind === "message" &&
					entry.message.role === "user" &&
					typeof entry.message.content === "string" &&
					entry.message.content.includes("Verify result"),
			),
		).toBe(true);
		await f.reopen();
		controller = f.controller;
		expect(controller.snapshot().todos).toEqual([
			{ content: "Verify result", phase: "Verification", status: "pending" },
		]);
		await controller.command("/goal resume");
		expect(controller.snapshot().goal?.status).toBe("completed");
		expect(controller.snapshot().todos?.[0]?.status).toBe("completed");
	} finally {
		await f.close();
	}
});

test("main and child questions queue, accept free text/multiple answers, and cancel without inventing answers", async () => {
	const f = await fixture((_request, main, turn) => {
		if (main && turn === 1)
			return call("agents_spawn", { name: "questioner", task: "Ask the user", isolated: false });
		if ((!main && turn === 1) || (main && turn === 2))
			return call("ask", {
				questions: [
					{
						id: "choice",
						question: main ? "Main question" : "Child question",
						multi: !main,
						options: [{ label: "A" }, { label: "B" }],
					},
				],
			});
		return say(main ? "Main finished" : "Child finished");
	});
	try {
		const task = f.controller.submit("Ask from both agents");
		const owners = new Set<string>();
		for (let index = 0; index < 2; index++) {
			await until(f.controller, (snapshot) => Boolean(snapshot.question));
			const question = f.controller.snapshot().question!;
			owners.add(question.agentId);
			await f.controller.answerQuestion(
				question.id,
				question.agentId === "main" ? {} : { choice: ["A", "custom answer"] },
			);
		}
		await task;
		await until(
			f.controller,
			(snapshot) => !snapshot.busy && snapshot.agents.every((agent) => agent.status === "done"),
		);
		expect(owners.size).toBe(2);
		const answers = f.requests.flatMap((request) => results(request, "ask"));
		expect(answers.some((result) => result.isError)).toBe(true);
		expect(answers.some((result) => !result.isError && resultText(result).includes("custom answer"))).toBe(
			true,
		);
		expect(f.controller.snapshot().question).toBeUndefined();
	} finally {
		await f.close();
	}
});

test("invisible questions return an honest error and explicit cancellation removes a visible question", async () => {
	const respond = (_request: ProviderRequest, _main: boolean, turn: number) =>
		turn === 1
			? call("ask", { questions: [{ id: "input", question: "Required input?" }] })
			: say("Cannot proceed");
	const printed = await fixture(respond, { interactive: false });
	try {
		await printed.controller.submit("Ask");
		expect(results(printed.requests[1]!, "ask")[0]?.isError).toBe(true);
		expect(printed.controller.snapshot().question).toBeUndefined();
	} finally {
		await printed.close();
	}
	const interactive = await fixture(respond);
	try {
		const task = interactive.controller.submit("Ask");
		await until(interactive.controller, (snapshot) => Boolean(snapshot.question));
		interactive.controller.cancel();
		await task;
		expect(interactive.controller.snapshot().question).toBeUndefined();
		expect(interactive.requests.length).toBe(1);
	} finally {
		await interactive.close();
	}
});

test("wait consumes a completion once and completed retained agents release active slots", async () => {
	const child = Promise.withResolvers<void>();
	const f = await fixture(
		async (_request, main, turn) => {
			if (!main) {
				await child.promise;
				return say("UNIQUE_CHILD_RESULT");
			}
			if (turn === 1) return call("agents_spawn", { name: "first", task: "Finish", isolated: false });
			if (turn === 2) {
				child.resolve();
				return call("agents_wait", { id: "first", timeout: 1 });
			}
			if (turn === 3) return call("agents_wait", { id: "first", timeout: 1 });
			if (turn === 4) return call("agents_spawn", { name: "second", task: "Finish", isolated: false });
			return say("Parent finished");
		},
		{ maxAgents: 1 },
	);
	try {
		await f.controller.submit("Wait then reuse a slot");
		await until(
			f.controller,
			(snapshot) =>
				!snapshot.busy &&
				snapshot.agents.length === 2 &&
				snapshot.agents.every((agent) => agent.status === "done"),
		);
		const waits = f.controller.snapshot().items.filter((item) => item.name === "agents_wait");
		expect(waits[0]?.text).toContain("UNIQUE_CHILD_RESULT");
		expect(waits[1]?.text).not.toContain("UNIQUE_CHILD_RESULT");
		expect(JSON.parse(waits[1]!.text).delivered).toBe(true);
		const firstId = f.controller.snapshot().agents[0]!.id;
		const firstCompletion = f.controller
			.snapshot()
			.items.filter(
				(item) =>
					item.kind === "user" &&
					item.text.includes("UNIQUE_CHILD_RESULT") &&
					item.text.includes('"agent":"first"'),
			);
		expect(firstCompletion).toEqual([]);
		expect(JSON.parse(waits[0]!.text).id).toBe(firstId);
		expect(
			f.controller
				.snapshot()
				.items.filter((item) => item.name === "agents_spawn")
				.every((item) => item.state === "done"),
		).toBe(true);
	} finally {
		child.resolve();
		await f.close();
	}
});

test("a child completion wakes an idle owner and explicit model, effort and invalid JSON schema result are observable", async () => {
	const child = Promise.withResolvers<void>();
	const resumed = Promise.withResolvers<void>();
	const f = await fixture(async (_request, main, turn) => {
		if (!main) {
			await child.promise;
			return say('{"value":"wrong type"}');
		}
		if (turn === 1)
			return call("agents_spawn", {
				name: "typed",
				task: "Return the count",
				isolated: false,
				model: "fixture/explicit-child",
				reasoning: "high",
				resultSchema: {
					type: "object",
					required: ["value"],
					properties: { value: { type: "integer" } },
					additionalProperties: false,
				},
			});
		if (turn === 3) resumed.resolve();
		return say("Owner yielded");
	});
	try {
		await f.controller.submit("Start a delayed child");
		expect(f.controller.snapshot().busy).toBe(false);
		child.resolve();
		await resumed.promise;
		await until(f.controller, (snapshot) => !snapshot.busy);
		const childRequest = f.requests.find((request) => request.selection.model === "explicit-child")!;
		expect(childRequest.reasoning).toBe("high");
		expect(f.controller.snapshot().agents[0]?.status).toBe("error");
		expect(f.controller.snapshot().agents[0]?.error).toContain("resultSchema");
		expect(f.controller.snapshot().agents[0]?.result).toBeUndefined();
		const notices = f.controller
			.snapshot()
			.items.filter((item) => item.kind === "user" && item.text.includes('"agent":"typed"'));
		expect(notices.length).toBe(1);
	} finally {
		child.resolve();
		await f.close();
	}
});

test("eval bridge writes validate and track checkpoints without adding orphan provider results", async () => {
	let invoke!: (name: string, args: Record<string, unknown>, context: ToolContext) => Promise<ToolOutput>;
	const f = await fixture(
		(_request, _main, turn) =>
			turn === 1
				? call("eval", {
						language: "js",
						code: 'await tool.write({path:"nested.txt",content:"before\\n"}); await tool.read({path:"nested.txt"}); display(await tool.edit({path:"nested.txt",old_string:"before",new_string:"after"}));',
					})
				: say("Finished"),
		{
			bridge: (callback) => {
				invoke = callback;
			},
		},
	);
	try {
		await f.controller.submit("Run a nested tracked edit");
		expect(await Bun.file(join(f.config.cwd, "nested.txt")).text()).toBe("after\n");
		const resultsInHistory = f.requests
			.at(-1)!
			.entries.filter((entry) => entry.kind === "message" && entry.message.role === "toolResult");
		expect(resultsInHistory.length).toBe(1);
		expect(f.controller.checkpoints().some((point) => point.files > 0)).toBe(true);
		const invalid = await invoke(
			"write",
			{ path: "other.txt", content: 7 },
			{
				cwd: f.config.cwd,
				sessionId: f.controller.snapshot().sessionId,
				agentId: "main",
				signal: new AbortController().signal,
				emit: () => {},
			},
		);
		expect(invalid.isError).toBe(true);
	} finally {
		await f.close();
	}
});

test("diffs reach the model but remain separate from transcript display text", async () => {
	const f = await fixture((_request, _main, turn) => {
		if (turn === 1) return call("read", { path: "diff.txt" });
		if (turn === 2) return call("edit", { path: "diff.txt", old_string: "before", new_string: "after" });
		return say("Changed");
	});
	try {
		await writeFile(join(f.config.cwd, "diff.txt"), "before\n");
		await f.controller.submit("Edit");
		const result = results(f.requests[2]!, "edit")[0]!;
		expect(resultText(result)).toContain("-before");
		expect(resultText(result)).toContain("+after");
		const item = f.controller.snapshot().items.find((entry) => entry.name === "edit")!;
		expect(item.diff).toContain("+after");
		expect(item.text).not.toContain("+after");
	} finally {
		await f.close();
	}
});

test("history search finds visible prose without hidden thinking or opaque signatures", async () => {
	const f = await fixture((_request, _main, turn) => {
		if (turn === 1)
			return [
				{ type: "thinking", thinking: "PRIVATE_NEEDLE", thinkingSignature: "OPAQUE_SIGNATURE" },
				...say("VISIBLE_NEEDLE is the public decision"),
				...call("history_search", { query: "PRIVATE_NEEDLE" }),
			];
		if (turn === 2) return call("history_search", { query: "VISIBLE_NEEDLE" });
		return say("Finished");
	});
	try {
		await f.controller.submit("Search prior visible decisions");
		const searches = results(f.requests[2]!, "history_search");
		expect(JSON.parse(resultText(searches[0]!))).toEqual([]);
		const visible = JSON.parse(resultText(searches[1]!));
		expect(visible).toEqual([
			expect.objectContaining({ role: "assistant", snippet: expect.stringContaining("VISIBLE_NEEDLE") }),
		]);
		expect(resultText(searches[1]!)).not.toContain("OPAQUE_SIGNATURE");
		expect(resultText(searches[1]!)).not.toContain("totalTokens");
	} finally {
		await f.close();
	}
});

test("history_read cursor advances past rows with no displayable content", async () => {
	const pages: string[] = [];
	const f = await fixture((request, _main, turn) => {
		if (turn === 1)
			return [{ type: "thinking", thinking: "PRIVATE_NEEDLE", thinkingSignature: "OPAQUE_SIGNATURE" }];
		const last = results(request, "history_read").at(-1);
		const text = last ? resultText(last) : "";
		if (last) pages.push(text);
		const next = /after=(\d+)\.$/.exec(text)?.[1];
		if (turn > 2 && (!next || text.includes("] Read history"))) return say("Done");
		return call("history_read", { after: next === undefined ? 0 : Number(next), limit: 1 });
	});
	try {
		await f.controller.submit("Start");
		await f.controller.submit("Read history");
		const cursors = pages.map((page) => Number(/after=(\d+)\.$/.exec(page)?.[1]));
		expect(pages.at(-1)).toContain("] Read history");
		// A page holding only the thinking-only assistant row still yields a forward cursor.
		expect(pages.some((page) => !/^\[\d+ /m.test(page))).toBe(true);
		for (let index = 1; index < cursors.length; index++)
			expect(cursors[index]!).toBeGreaterThan(cursors[index - 1]!);
		for (const page of pages) {
			expect(page).not.toContain("PRIVATE_NEEDLE");
			expect(page).not.toContain("OPAQUE_SIGNATURE");
		}
	} finally {
		await f.close();
	}
});

test("models filters case-insensitively and pages exact selectable refs without dropping rows", async () => {
	const f = await fixture((_request, _main, turn) => {
		if (turn === 1) return call("models", { provider: "FIXTURE", query: "CHILD" });
		if (turn === 2) return call("models", { limit: 1 });
		if (turn === 3) return call("models", { limit: 1, offset: 1 });
		return say("Done");
	});
	try {
		await f.controller.submit("List models");
		const [filtered, first, second] = results(f.requests.at(-1)!, "models").map(resultText);
		expect(filtered).toContain("fixture/explicit-child");
		expect(filtered).not.toContain("fixture/default");
		expect(first).toContain("fixture/default");
		expect(first).not.toContain("fixture/explicit-child");
		expect(first).toContain("offset=1");
		expect(second).toContain("fixture/explicit-child");
		expect(second).not.toContain("fixture/default");
		expect(second).not.toContain("offset=");
	} finally {
		await f.close();
	}
});

test("an isolated worktree shell does not gate the owner's next provider request or read", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const readFinished = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch() {
			started.resolve();
			await release.promise;
			return new Response("done");
		},
	});
	const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`await fetch('${server.url}').then(r=>r.text())`)}`;
	const f = await fixture(async (_request, main, turn) => {
		if (!main) return turn === 1 ? call("shell", { command, timeout: 30 }) : say("Child finished");
		if (turn === 1) return call("agents_spawn", { name: "isolated", task: "Run the command" });
		if (turn === 2) {
			await started.promise;
			return call("read", { path: "seed.txt" });
		}
		readFinished.resolve();
		return say("Parent read finished independently");
	});
	try {
		await writeFile(join(f.config.cwd, "seed.txt"), "seed\n");
		for (const args of [
			["init", "--quiet"],
			["add", "seed.txt"],
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			],
		]) {
			const process = Bun.spawn(["git", ...args], { cwd: f.config.cwd, stdout: "pipe", stderr: "pipe" });
			expect(await process.exited).toBe(0);
		}
		const task = f.controller.submit("Read independently");
		await readFinished.promise;
		expect(f.controller.snapshot().agents[0]?.cwd).not.toBe(f.config.cwd);
		expect(JSON.parse(resultText(lastMainSpawns(f.requests)[0]!)).isolation).toBe("worktree");
		expect(f.controller.snapshot().items.find((item) => item.name === "read")?.text).toContain("seed");
		release.resolve();
		await task;
		await until(
			f.controller,
			(snapshot) => !snapshot.busy && snapshot.agents.every((agent) => agent.status === "done"),
		);
	} finally {
		release.resolve();
		await f.close();
		await server.stop(true);
	}
}, 15_000);

test("default spawn shares a non-git checkout while explicit isolation explains how to opt out", async () => {
	const f = await fixture((_request, main, turn) => {
		if (!main) return say("Child finished");
		if (turn === 1) return call("agents_spawn", { name: "shared", task: "Finish" });
		if (turn === 2) return call("agents_spawn", { name: "strict", task: "Finish", isolated: true });
		return say("Parent finished");
	});
	// Keep discovery inside the fixture even if the temp directory lives in a repository.
	const ceiling = process.env.GIT_CEILING_DIRECTORIES;
	process.env.GIT_CEILING_DIRECTORIES = f.root;
	try {
		await f.controller.submit("Spawn");
		await until(
			f.controller,
			(snapshot) => !snapshot.busy && snapshot.agents.every((agent) => agent.status === "done"),
		);
		const [shared, strict] = lastMainSpawns(f.requests);
		expect(shared?.isError).toBe(false);
		expect(JSON.parse(resultText(shared!))).toMatchObject({ isolation: "shared", cwd: f.config.cwd });
		expect(strict?.isError).toBe(true);
		expect(resultText(strict!)).toContain("isolated=false");
		expect(resultText(strict!)).not.toContain("fatal:");
		expect(f.controller.snapshot().agents.map((agent) => agent.cwd)).toEqual([f.config.cwd]);
	} finally {
		if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
		else process.env.GIT_CEILING_DIRECTORIES = ceiling;
		await f.close();
	}
});

test("a broken repository fails default isolation instead of silently sharing, and isolated=false skips git", async () => {
	const f = await fixture((_request, main, turn) => {
		if (!main) return say("Child finished");
		if (turn === 1) return call("agents_spawn", { name: "default", task: "Finish" });
		if (turn === 2) return call("agents_spawn", { name: "opted-out", task: "Finish", isolated: false });
		return say("Parent finished");
	});
	try {
		await writeFile(join(f.config.cwd, ".git"), `gitdir: ${join(f.root, "missing-gitdir")}\n`);
		await f.controller.submit("Spawn");
		await until(
			f.controller,
			(snapshot) => !snapshot.busy && snapshot.agents.every((agent) => agent.status === "done"),
		);
		const [broken, optedOut] = lastMainSpawns(f.requests);
		expect(broken?.isError).toBe(true);
		expect(resultText(broken!)).toContain("missing-gitdir");
		expect(optedOut?.isError).toBe(false);
		expect(JSON.parse(resultText(optedOut!))).toMatchObject({ isolation: "shared", cwd: f.config.cwd });
		expect(f.controller.snapshot().agents.map((agent) => agent.name)).toEqual(["opted-out"]);
	} finally {
		await f.close();
	}
});

test("resume upgrades frozen schemas in a fresh context while retaining original signed history", async () => {
	const f = await fixture(() => [
		{ type: "thinking", thinking: "original private reasoning", thinkingSignature: "ORIGINAL_SIGNATURE" },
		...say("Original public decision"),
	]);
	f.gateway.capabilities = () => ({
		dynamicSystem: true,
		dynamicTools: true,
		signedCompaction: false,
		notesContext: true,
	});
	try {
		await f.controller.submit("Remember the decision");
		await f.controller.command("/tools disable shell");
		const id = f.controller.snapshot().sessionId;
		const originalRequest = f.requests[0]!;
		await f.controller.close();
		const store = new Store(f.config.home);
		const session = store.get(id)!;
		session.tools = session.tools.filter((tool) => tool.name !== "todo" && tool.name !== "eval");
		session.activeTools = session.activeTools.filter((name) => name !== "todo" && name !== "eval");
		session.todos = [{ content: "Previously finished work", phase: "Implementation", status: "completed" }];
		session.notebook = "Durable verification notes";
		store.append(session, {
			id: crypto.randomUUID(),
			kind: "message",
			message: { role: "user", content: "LATEST_REAL_TASK_OUTSIDE_TAIL", timestamp: Date.now() },
		});
		for (let index = 0; index < 45; index++)
			store.append(session, {
				id: crypto.randomUUID(),
				kind: "message",
				message: {
					role: "user",
					synthetic: true,
					content: `Historical progress ${index}`,
					timestamp: Date.now(),
				},
			});
		const originalHistory = store.history(id).map((row) => row.entry);
		store.save(session);
		store.close();
		await f.reopen();
		await f.controller.submit("Continue with the upgraded tools");
		const resumedRequest = f.requests.at(-1)!;
		expect(resumedRequest.tools.some((tool) => tool.name === "todo")).toBe(true);
		expect(resumedRequest.tools.some((tool) => tool.name === "eval")).toBe(true);
		expect(resumedRequest.cacheKey).not.toBe(originalRequest.cacheKey);
		expect(resumedRequest.sessionId).not.toBe(originalRequest.sessionId);
		expect(JSON.stringify(resumedRequest.entries)).not.toContain("ORIGINAL_SIGNATURE");
		expect(JSON.stringify(resumedRequest.entries)).toContain("LATEST_REAL_TASK_OUTSIDE_TAIL");
		expect(
			resumedRequest.entries.some((entry) => entry.kind === "system" && entry.removeTools?.includes("shell")),
		).toBe(true);
		const notebook = resumedRequest.entries.find(
			(entry) =>
				entry.kind === "message" &&
				entry.message.role === "user" &&
				typeof entry.message.content === "string" &&
				entry.message.content.startsWith("Persistent context notebook"),
		);
		expect(JSON.stringify(notebook)).toContain("Durable verification notes");
		expect(f.controller.snapshot().todos?.[0]?.status).toBe("completed");
		const restored = new Store(f.config.home);
		expect(
			restored
				.history(id)
				.slice(0, originalHistory.length)
				.map((row) => row.entry),
		).toEqual(originalHistory);
		restored.close();
	} finally {
		await f.close();
	}
});

test("Esc holds cancelled main work but does not poison a finished child's next assignment", async () => {
	const child = Promise.withResolvers<void>();
	let childTurns = 0;
	const f = await fixture(async (_request, main, turn) => {
		if (!main) {
			childTurns++;
			await child.promise;
			return say(`CHILD_RUN_${childTurns}`);
		}
		if (turn === 1) return call("agents_spawn", { name: "reusable", task: "Finish", isolated: false });
		if (turn === 2) {
			child.resolve();
			return call("agents_wait", { id: "reusable" });
		}
		if (turn === 4) return call("agents_send", { id: "reusable", message: "Do the next task" });
		if (turn === 5) return call("agents_wait", { id: "reusable" });
		return say("Main finished");
	});
	try {
		await f.controller.submit("Finish first assignment");
		f.controller.cancel();
		await f.controller.submit("Give the finished agent new work");
		await until(f.controller, (snapshot) => !snapshot.busy && snapshot.agents[0]?.status === "done");
		expect(childTurns).toBe(2);
		expect(f.controller.snapshot().items.some((item) => item.text.includes("CHILD_RUN_2"))).toBe(true);
	} finally {
		child.resolve();
		await f.close();
	}
});

test("a completion arriving during model discovery wakes the idle owner after the transition", async () => {
	const child = Promise.withResolvers<void>();
	const discovery = Promise.withResolvers<void>();
	const discovering = Promise.withResolvers<void>();
	const resumed = Promise.withResolvers<void>();
	const f = await fixture(async (_request, main, turn) => {
		if (!main) {
			await child.promise;
			return say("MODEL_TRANSITION_RESULT");
		}
		if (turn === 1) return call("agents_spawn", { name: "delayed", task: "Finish later", isolated: false });
		if (turn >= 3) resumed.resolve();
		return say("Owner yielded");
	});
	try {
		await f.controller.submit("Start delayed work");
		const models = f.gateway.models;
		f.gateway.models = async () => {
			discovering.resolve();
			await discovery.promise;
			return models();
		};
		const switching = f.controller.command("/model fixture/explicit-child");
		await discovering.promise;
		child.resolve();
		await until(f.controller, (snapshot) => snapshot.agents[0]?.status === "done");
		discovery.resolve();
		await switching;
		await resumed.promise;
		await until(f.controller, (snapshot) => !snapshot.busy);
		expect(JSON.stringify(f.requests.at(-1)!.entries)).toContain("MODEL_TRANSITION_RESULT");
		expect(f.requests.at(-1)!.selection.model).toBe("explicit-child");
	} finally {
		child.resolve();
		discovery.resolve();
		await f.close();
	}
});

test("new user work under an old paused goal receives idle child completions", async () => {
	const child = Promise.withResolvers<void>();
	const resumed = Promise.withResolvers<void>();
	let controller: AppController;
	const f = await fixture(async (_request, main, turn) => {
		if (!main) {
			await child.promise;
			return say("NEW_TASK_RESULT");
		}
		if (turn === 1)
			return call("goal_pause", { goalId: controller.snapshot().goal!.id, reason: "Missing prerequisite" });
		if (turn === 3)
			return call("agents_spawn", { name: "new-task", task: "Independent new work", isolated: false });
		if (turn === 5) resumed.resolve();
		return say("Owner yielded");
	});
	controller = f.controller;
	try {
		await controller.command("/goal Old blocked task");
		await controller.submit("Do an independent new task");
		child.resolve();
		await resumed.promise;
		await until(controller, (snapshot) => !snapshot.busy);
		expect(controller.snapshot().goal?.status).toBe("paused");
		expect(JSON.stringify(f.requests.at(-1)!.entries)).toContain("NEW_TASK_RESULT");
	} finally {
		child.resolve();
		await f.close();
	}
});

test("goal completion rejects a finished child whose authoritative error raced the request boundary", async () => {
	const child = Promise.withResolvers<void>();
	let controller: AppController;
	const f = await fixture(async (_request, main, turn) => {
		if (!main) {
			await child.promise;
			return say('{"count":"invalid"}');
		}
		const goalId = controller.snapshot().goal!.id;
		if (turn === 1)
			return call("agents_spawn", {
				name: "typed-race",
				task: "Return a count",
				isolated: false,
				resultSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
			});
		if (turn === 2) {
			child.resolve();
			await until(controller, (snapshot) => snapshot.agents[0]?.status === "error");
			return call("goal_complete", { goalId, summary: "Premature success" });
		}
		if (turn === 3) {
			expect(controller.snapshot().goal?.status).toBe("active");
			return call("goal_pause", { goalId, reason: "The child's result failed validation" });
		}
		return say("Blocked on invalid child result");
	});
	controller = f.controller;
	try {
		await controller.command("/goal Verify the child result");
		const request = f.requests.find((request) => results(request, "goal_complete").length)!;
		expect(results(request, "goal_complete")[0]?.isError).toBe(true);
		expect(JSON.stringify(request.entries)).toContain("resultSchema");
		expect(controller.snapshot().goal?.status).toBe("paused");
	} finally {
		child.resolve();
		await f.close();
	}
});

test.each(["success", "failure", "timeout", "crash", "cancel"] as const)(
	"nested eval wait preserves authoritative completion across %s",
	async (outcome) => {
		const child = Promise.withResolvers<void>();
		const claimed = Promise.withResolvers<void>();
		const barrier: HarnessTool = {
			name: "claim_barrier",
			description: "Observe a nested wait before cell termination",
			parameters: { type: "object", properties: {} },
			execute: async (_args, context) => {
				claimed.resolve();
				if (outcome === "cancel") {
					const stopped = Promise.withResolvers<void>();
					if (context.signal.aborted) stopped.resolve();
					else context.signal.addEventListener("abort", () => stopped.resolve(), { once: true });
					await stopped.promise;
				}
				return { text: "Barrier passed" };
			},
		};
		const f = await fixture(
			async (_request, main, turn) => {
				if (!main) {
					await child.promise;
					return say("DURABLE_NESTED_RESULT");
				}
				if (turn === 1) return call("agents_spawn", { name: "nested", task: "Finish", isolated: false });
				if (turn === 2) {
					child.resolve();
					const ending =
						outcome === "failure"
							? 'throw new Error("after wait");'
							: outcome === "crash"
								? "process.exit(9);"
								: outcome === "timeout"
									? "await Promise.withResolvers().promise;"
									: "";
					return call("eval", {
						language: "js",
						timeout: outcome === "timeout" ? 1 : 60,
						code: `const nested = await tool.agents_wait({id:"nested"}); await tool.claim_barrier({}); ${ending}`,
					});
				}
				return say("Owner finished");
			},
			{ tools: [barrier] },
		);
		try {
			const task = f.controller.submit("Wait inside eval");
			await claimed.promise;
			if (outcome === "cancel") {
				f.controller.cancel();
				await task;
				const store = new Store(f.config.home);
				expect(store.pendingCompletion(f.controller.snapshot().sessionId)).toBe(true);
				store.close();
				expect(f.requests.filter((request) => request.sessionId === f.requests[0]!.sessionId).length).toBe(2);
				await f.controller.submit("Continue explicitly");
			} else await task;
			const last = f.requests.at(-1)!;
			const evalResult = results(last, "eval")[0]!;
			const mail = last.entries.filter(
				(entry) =>
					entry.kind === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry).includes("DURABLE_NESTED_RESULT"),
			);
			if (outcome === "success") {
				expect(evalResult.isError).toBe(false);
				expect(resultText(evalResult)).toContain("DURABLE_NESTED_RESULT");
				expect(mail).toHaveLength(0);
			} else {
				expect(evalResult.isError).toBe(true);
				expect(mail).toHaveLength(1);
			}
		} finally {
			child.resolve();
			await f.close();
		}
	},
);

test("a long-lived schema child's authoritative task and owner survive a catalogue upgrade", async () => {
	const child = Promise.withResolvers<void>();
	const schema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"] };
	const f = await fixture(async (_request, main, turn) => {
		if (!main) {
			await child.promise;
			return say('{"value":7}');
		}
		if (turn === 1)
			return call("agents_spawn", {
				name: "typed-upgrade",
				task: "ORIGINAL_AUTHORITATIVE_CHILD_TASK",
				isolated: false,
				resultSchema: schema,
			});
		if (turn === 2) {
			child.resolve();
			return call("agents_wait", { id: "typed-upgrade" });
		}
		if (turn === 4)
			return call("agents_send", { id: "typed-upgrade", message: "Continue the original assignment" });
		if (turn === 5) return call("agents_wait", { id: "typed-upgrade" });
		return say("Main finished");
	});
	try {
		await f.controller.submit("Use a typed child");
		const mainId = f.controller.snapshot().sessionId;
		const childId = f.controller.snapshot().agents[0]!.id;
		await f.controller.close();
		const store = new Store(f.config.home);
		const session = store.get(childId)!;
		session.tools = session.tools.filter((tool) => tool.name !== "eval");
		session.activeTools = session.activeTools.filter((name) => name !== "eval");
		for (let index = 0; index < 45; index++)
			store.append(session, {
				id: crypto.randomUUID(),
				kind: "message",
				message: { role: "user", synthetic: true, content: `Old progress ${index}`, timestamp: Date.now() },
			});
		store.save(session);
		store.close();
		await f.reopen();
		await f.controller.submit("Continue child work after upgrade");
		await until(f.controller, (snapshot) => !snapshot.busy && snapshot.agents[0]?.status === "done");
		const request = f.requests.findLast(
			(request) => request.sessionId !== mainId && request.sessionId !== childId,
		)!;
		const marker = request.entries.find(
			(entry) =>
				entry.kind === "message" &&
				entry.message.role === "user" &&
				typeof entry.message.content === "string" &&
				entry.message.content.includes("Authoritative current assignment:"),
		);
		const text = marker?.kind === "message" ? marker.message.content : "";
		expect(text).toContain("ORIGINAL_AUTHORITATIVE_CHILD_TASK");
		expect(text).toContain(mainId);
		expect(text).toContain("JSON only");
		expect(text).toContain(JSON.stringify(schema));
		expect(f.controller.snapshot().agents[0]?.result).toEqual({ value: 7 });
	} finally {
		child.resolve();
		await f.close();
	}
});

test("ordinary tool turns still stop at maxTurns without a goal", async () => {
	const f = await fixture(() => call("todo"));
	f.config.maxTurns = 1;
	try {
		await f.controller.submit("Inspect tasks once");
		expect(f.requests).toHaveLength(1);
		expect(f.controller.snapshot().status).toBe("Error");
		expect(
			f.controller
				.snapshot()
				.items.some((item) => item.kind === "notice" && item.text.includes("Turn limit")),
		).toBe(true);
	} finally {
		await f.close();
	}
});

test("model checkpoint restores the latest changed batch without git or conversation rewind", async () => {
	const f = await fixture((_request, _main, turn) => {
		if (turn === 1) return [...call("read", { path: "a.txt" }), ...call("read", { path: "b.txt" })];
		if (turn === 2)
			return call("batch_edit", {
				files: [
					{ path: "a.txt", edits: [{ old_text: "before-a", new_text: "after-a" }] },
					{ path: "b.txt", edits: [{ old_text: "before-b", new_text: "after-b" }] },
				],
			});
		if (turn === 3) return call("session_diff");
		if (turn === 4) return call("checkpoint");
		if (turn === 5) return call("checkpoint", { action: "restore" });
		if (turn === 6) return [...call("checkpoint"), ...call("session_diff")];
		return say("Restored the batch and retained the conversation.");
	});
	try {
		await writeFile(join(f.config.cwd, "a.txt"), "before-a\n");
		await writeFile(join(f.config.cwd, "b.txt"), "before-b\n");
		await f.controller.submit("Edit both files, inspect changes, then undo them.");
		const request = f.requests.at(-1)!;
		const checkpoints = results(request, "checkpoint");
		expect(checkpoints.map((result) => !!result.isError)).toEqual([false, false, false]);
		expect(checkpoints[0]!.details).toMatchObject({ total: 1, checkpoints: [{ changedPaths: 2 }] });
		expect(checkpoints[1]!.details).toMatchObject({ conversationChanged: false });
		expect(checkpoints[2]!.details).toMatchObject({ total: 0 });
		const diffs = results(request, "session_diff");
		expect(diffs.map((result) => !!result.isError)).toEqual([false, false]);
		expect(resultText(diffs[0]!)).toContain("+after-a");
		expect(resultText(diffs[0]!)).toContain("-before-b");
		expect(await Bun.file(join(f.config.cwd, "a.txt")).text()).toBe("before-a\n");
		expect(await Bun.file(join(f.config.cwd, "b.txt")).text()).toBe("before-b\n");
		expect(results(request, "batch_edit")).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("fresh conversations load the memory index but read topic files only on demand", async () => {
	const note = "REVIEW_PREFERENCE: cite concrete file locations, avoid generic praise.";
	const f = await fixture((request) => {
		const memory = results(request, "memory");
		if (request.firstUserText === "Save my review preference.") {
			if (!memory.length) return call("memory", { op: "write", path: "review.md", content: note });
			if (memory.length === 1)
				return call("memory", {
					op: "write",
					path: "MEMORY.md",
					content: "Review preferences: [review.md](review.md)\n",
				});
			if (!results(request, "checkpoint").length) return call("checkpoint");
			return say("Saved project memory.");
		}
		if (!memory.length) return call("memory", { op: "read", path: "review.md" });
		return say("Read the saved review preference.");
	});
	try {
		await f.controller.submit("Save my review preference.");
		expect(results(f.requests.at(-1)!, "memory").map((result) => !!result.isError)).toEqual([false, false]);
		expect(results(f.requests.at(-1)!, "checkpoint")[0]!.details).toMatchObject({ total: 0 });
		await f.controller.command("/new");
		await f.controller.submit("Apply my saved review preference.");
		const first = f.requests.find(
			(request) => request.firstUserText === "Apply my saved review preference.",
		)!;
		expect(first.system.join("\n")).toContain("[review.md](review.md)");
		expect(first.system.join("\n")).not.toContain(note);
		expect(resultText(results(f.requests.at(-1)!, "memory")[0]!)).toContain(note);
	} finally {
		await f.close();
	}
});

test("memory toggles preserve an in-flight tool pair and the provider's frozen system prefix", async () => {
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const f = await fixture((_request, _main, turn) => (turn === 1 ? call("held") : say("Continued safely.")), {
		tools: [
			{
				name: "held",
				description: "Wait at a tool boundary",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					entered.resolve();
					await release.promise;
					return { text: "Held tool finished." };
				},
			},
		],
	});
	try {
		const running = f.controller.submit("Run the held operation.");
		await entered.promise;
		await f.controller.command("/memory off");
		release.resolve();
		await running;
		const next = f.requests.at(-1)!;
		expect(next.system).toEqual(f.requests[0]!.system);
		const toolResult = next.entries.findIndex(
			(entry) =>
				entry.kind === "message" && entry.message.role === "toolResult" && entry.message.toolName === "held",
		);
		const memoryUpdate = next.entries.findIndex(
			(entry) => entry.kind === "message" && entry.message.role === "user" && !!entry.message.synthetic,
		);
		expect(toolResult).toBeGreaterThan(-1);
		expect(memoryUpdate).toBeGreaterThan(toolResult);
		expect(JSON.parse(await Bun.file(join(f.config.home, "config.json")).text()).autoMemoryEnabled).toBe(
			false,
		);
	} finally {
		release.resolve();
		await f.close();
	}
});
