import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type {
	HarnessTool,
	HistoryEntry,
	IntegrationServices,
	ProviderEvent,
	ProviderGateway,
	ProviderRequest,
	SalamConfig,
} from "../src/contracts.ts";
import { createRuntime } from "../src/runtime/index.ts";
import { createTools } from "../src/tools/index.ts";

type Reply = AssistantMessage["content"];

const selection = { provider: "fixture", model: "fixture", contextWindow: 128000 };
/** A gate that never opens: only cancellation ends responses held on it. */
const never = Promise.withResolvers<void>().promise;

/** A request's history in a compact, order-preserving form. */
function summarize(entry: HistoryEntry): string {
	if (entry.kind !== "message") return entry.kind;
	const message = entry.message;
	if (message.role === "toolResult") return `result ${message.toolCallId}${message.isError ? " error" : ""}`;
	if (message.role === "assistant")
		return `assistant ${message.content
			.map((block) =>
				block.type === "toolCall" ? `call ${block.id}` : block.type === "text" ? block.text : block.type,
			)
			.join(" ")}`;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	return `${message.role === "user" && message.synthetic ? "synthetic" : message.role} ${text}`;
}

/** A response that arrives when `gate` opens, and fails as a real transport does when its request is aborted. */
function held(request: ProviderRequest, gate: Promise<void>, content: Reply): Promise<Reply> {
	const reply = Promise.withResolvers<Reply>();
	request.signal.addEventListener("abort", () => reply.reject(request.signal.reason), { once: true });
	void gate.then(() => reply.resolve(content));
	return reply.promise;
}

/** A mutating tool that runs until released or cancelled. */
function holdTool() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const tool: HarnessTool = {
		name: "hold",
		description: "Hold a real tool boundary",
		parameters: { type: "object", properties: {} },
		async execute(_args, context) {
			entered.resolve();
			const done = Promise.withResolvers<void>();
			context.signal.addEventListener("abort", () => done.reject(context.signal.reason), { once: true });
			void release.promise.then(() => done.resolve());
			await done.promise;
			return { text: "held tool completed" };
		},
	};
	return { tool, entered: entered.promise, release: () => release.resolve() };
}

async function fixture(
	respond: (request: ProviderRequest, index: number) => Reply | Promise<Reply>,
	tools: HarnessTool[] = [],
	maxTurns = 10,
	overrides: Partial<ProviderGateway> = {},
) {
	const root = await mkdtemp(join(tmpdir(), "salam-steering-"));
	const config: SalamConfig = {
		home: join(root, "home"),
		cwd: root,
		selection,
		webSearchModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
		providers: {},
		mcpServers: {},
		remotes: {},
		maxTurns,
		maxAgents: 1,
		maxOutputTokens: 1024,
		contextThreshold: 100000,
		reasoning: "off",
	};
	const requests: string[][] = [];
	let live = 0;
	let overlapped = false;
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected fixture operation");
	};
	const gateway: ProviderGateway = {
		models: async () => [selection],
		webFetch: unexpected,
		webSearch: unexpected,
		async *stream(request): AsyncIterable<ProviderEvent> {
			const index = requests.length;
			requests.push(request.entries.map(summarize));
			if (live++) overlapped = true;
			try {
				yield { type: "text", delta: "…" };
				const content = await respond(request, index);
				yield {
					type: "done",
					message: {
						role: "assistant",
						content,
						api: "anthropic-messages",
						provider: selection.provider,
						model: selection.model,
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
			} finally {
				live--;
			}
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
		...overrides,
	};
	const integrations: IntegrationServices = {
		tools,
		instructions: async () => [],
		skills: async () => [],
		loadSkill: unexpected,
		close: async () => {},
	};
	const services = await createTools(config);
	let controller = await createRuntime(config, gateway, services, integrations);
	return {
		requests,
		get overlapped() {
			return overlapped;
		},
		get controller() {
			return controller;
		},
		async reopen(id: string) {
			await controller.close();
			controller = await createRuntime(config, gateway, services, integrations, { sessionId: id });
		},
		async close() {
			await controller.close();
			await services.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("messages sent during a response and its tools join the very next request, in order, as user turns", async () => {
	const hold = holdTool();
	const streaming = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<void>();
	const f = await fixture(
		(request, index) => {
			if (index > 0) return [{ type: "text", text: "answered" }];
			streaming.resolve();
			return held(request, answer.promise, [{ type: "toolCall", id: "call-1", name: "hold", arguments: {} }]);
		},
		[hold.tool],
	);
	try {
		const first = f.controller.submit("start the task");
		await streaming.promise;
		await f.controller.submit("first steer");
		await f.controller.submit("second steer");
		expect(f.controller.snapshot().steering).toEqual(["first steer", "second steer"]);
		answer.resolve();
		await hold.entered;
		await f.controller.submit("third steer");
		expect(f.controller.snapshot().steering).toEqual(["first steer", "second steer", "third steer"]);
		expect(f.requests).toHaveLength(1);
		hold.release();
		await first;
		expect(f.requests).toEqual([
			["user start the task"],
			[
				"user start the task",
				"assistant call call-1",
				"result call-1",
				"user first steer",
				"user second steer",
				"user third steer",
			],
		]);
		expect(f.overlapped).toBe(false);
		const snapshot = f.controller.snapshot();
		expect(snapshot.steering).toEqual([]);
		expect(snapshot.busy).toBe(false);
		const said = ["start the task", "first steer", "second steer", "third steer"];
		expect(snapshot.items.filter((item) => item.kind === "user").map((item) => item.text)).toEqual(said);
		expect(
			f.controller
				.checkpoints()
				.filter((point) => point.kind === "user")
				.map((point) => point.prompt),
		).toEqual(said);
	} finally {
		answer.resolve();
		hold.release();
		await f.close();
	}
});

test("interrupting a stream sends queued and new messages at once, in one request that never overlaps", async () => {
	const streaming = Promise.withResolvers<void>();
	const f = await fixture((request, index) => {
		if (index > 0) return [{ type: "text", text: "handled" }];
		streaming.resolve();
		return held(request, never, [{ type: "text", text: "never finishes" }]);
	});
	try {
		const first = f.controller.submit("long task");
		await streaming.promise;
		await f.controller.submit("queued note");
		const interrupt = f.controller.submit("change of plan", "interrupt");
		const again = f.controller.submit("and also this", "interrupt");
		await Promise.all([first, interrupt, again]);
		expect(f.requests).toEqual([
			["user long task"],
			["user long task", "user queued note", "user change of plan", "user and also this"],
		]);
		expect(f.overlapped).toBe(false);
		expect(f.controller.snapshot().steering).toEqual([]);
		expect(f.controller.snapshot().busy).toBe(false);
	} finally {
		await f.close();
	}
});

test("escape with queued messages interrupts the stream and sends them at once", async () => {
	const streaming = Promise.withResolvers<void>();
	const f = await fixture((request, index) => {
		if (index > 0) return [{ type: "text", text: "handled" }];
		streaming.resolve();
		return held(request, never, [{ type: "text", text: "never finishes" }]);
	});
	try {
		const first = f.controller.submit("long task");
		await streaming.promise;
		await f.controller.submit("queued one");
		await f.controller.submit("queued two");
		await Promise.all([first, f.controller.sendQueued()]);
		expect(f.requests).toEqual([
			["user long task"],
			["user long task", "user queued one", "user queued two"],
		]);
		expect(f.overlapped).toBe(false);
		expect(f.controller.snapshot().steering).toEqual([]);
		expect(f.controller.snapshot().busy).toBe(false);
	} finally {
		await f.close();
	}
});

test("escape with nothing queued is a plain cancel", async () => {
	const streaming = Promise.withResolvers<void>();
	const f = await fixture((request) => {
		streaming.resolve();
		return held(request, never, [{ type: "text", text: "never finishes" }]);
	});
	try {
		const first = f.controller.submit("long task");
		await streaming.promise;
		await Promise.all([first, f.controller.sendQueued()]);
		expect(f.requests).toEqual([["user long task"]]);
		expect(f.controller.snapshot().busy).toBe(false);
		expect(f.controller.snapshot().status).toBe("Interrupted");
	} finally {
		await f.close();
	}
});

test("a command_watch match wakes the idle agent with the matching line; a long foreground sleep is refused", async () => {
	const woke = Promise.withResolvers<string>();
	const resultText = (request: ProviderRequest, id: string) => {
		for (const entry of request.entries)
			if (entry.kind === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id)
				return entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		throw new Error(`no result for ${id}`);
	};
	let job = "";
	const f = await fixture((request, index) => {
		if (index === 0)
			return [
				{ type: "toolCall", id: "nap", name: "shell", arguments: { command: "sleep 300" } },
				{
					type: "toolCall",
					id: "bg",
					name: "shell",
					arguments: { command: "sleep 0.5; echo 'listening on :4000'; sleep 30", background: true },
				},
			];
		if (index === 1) {
			expect(resultText(request, "nap")).toContain("Refused: this command sleeps 300s");
			job = /as (\S+?)[,\]]/.exec(resultText(request, "bg"))![1]!;
			return [
				{ type: "toolCall", id: "watch", name: "command_watch", arguments: { id: job, log: "listening" } },
			];
		}
		if (index === 2) {
			expect(resultText(request, "watch")).toContain(`Watching ${job}`);
			return [{ type: "text", text: "waiting for the server" }];
		}
		if (index > 3) return [{ type: "text", text: "the server is up" }];
		woke.resolve(summarize(request.entries.at(-1)!));
		return [{ type: "toolCall", id: "stop", name: "command_stop", arguments: { id: job } }];
	});
	try {
		await f.controller.submit("start the server and tell me when it listens");
		expect(f.requests).toHaveLength(3);
		const mail = await woke.promise;
		expect(mail.startsWith("synthetic [command_watch]")).toBe(true);
		expect(mail).not.toContain("Agent message");
		expect(mail).toContain("listening on :4000");
	} finally {
		await f.close();
	}
	// A real agent loop, shell and watch poll: slow under a loaded parallel run.
}, 15_000);

test("the footer quota is fetched in the background and not refetched by an immediate turn", async () => {
	let calls = 0;
	const fetched = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const f = await fixture(() => [{ type: "text", text: "done" }], [], 10, {
		async usage(choice) {
			const used = calls === 0 ? 0.25 : 0.5;
			const index = calls++;
			queueMicrotask(() => fetched[index]?.resolve());
			return {
				provider: choice.provider,
				fetchedAt: Date.now(),
				report: {
					provider: "anthropic",
					fetchedAt: Date.now(),
					limits: [
						{
							id: "x:5h",
							label: "5 Hour",
							scope: { provider: "anthropic", windowId: "5h", shared: true },
							window: { id: "5h", label: "5 Hour", durationMs: 5 * 3_600_000 },
							amount: { usedFraction: used, unit: "percent" },
						},
					],
				},
			};
		},
	});
	try {
		await fetched[0]!.promise;
		await Bun.sleep(0);
		expect(f.controller.snapshot().quota?.windows).toEqual([{ label: "5h", remaining: 0.75 }]);
		// A turn right after startup is inside the refresh gap: no second fetch yet.
		await f.controller.submit("hi");
		expect(calls).toBe(1);
	} finally {
		await f.close();
	}
});

test("pasted images travel with the queued message into the user turn", async () => {
	let seen: unknown;
	const f = await fixture((request) => {
		const last = request.entries.at(-1)!;
		if (last.kind === "message") seen = last.message.content;
		return [{ type: "text", text: "a red dot" }];
	});
	try {
		const image = { data: "iVBORw0KGgo=", mimeType: "image/png" };
		await f.controller.submit("what is this [Image #1]", "steer", [image]);
		expect(seen).toEqual([
			{ type: "text", text: "what is this [Image #1]" },
			{ type: "image", data: image.data, mimeType: image.mimeType },
		]);
		const item = f.controller.snapshot().items.find((entry) => entry.kind === "user");
		expect(item?.text).toBe("what is this [Image #1]");
	} finally {
		await f.close();
	}
});

test("interrupting a running tool answers its call with an error before the new request", async () => {
	const hold = holdTool();
	const f = await fixture(
		(_request, index) =>
			index === 0
				? [{ type: "toolCall", id: "call-1", name: "hold", arguments: {} }]
				: [{ type: "text", text: "doing that instead" }],
		[hold.tool],
	);
	try {
		const first = f.controller.submit("run the tool");
		await hold.entered;
		await f.controller.submit("stop and do this instead", "interrupt");
		await first;
		expect(f.requests).toEqual([
			["user run the tool"],
			["user run the tool", "assistant call call-1", "result call-1 error", "user stop and do this instead"],
		]);
		expect(f.overlapped).toBe(false);
	} finally {
		hold.release();
		await f.close();
	}
});

test("cancel keeps queued messages pending across restarts until the next send, even one made during cleanup", async () => {
	const streaming = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const f = await fixture((request, index) => {
		if (index > 1) return [{ type: "text", text: "continuing" }];
		streaming[index]!.resolve();
		return held(request, never, [{ type: "text", text: "never finishes" }]);
	});
	try {
		const first = f.controller.submit("task A");
		await streaming[0]!.promise;
		await f.controller.submit("keep this");
		f.controller.cancel();
		await first;
		expect(f.controller.snapshot().busy).toBe(false);
		expect(f.controller.snapshot().steering).toEqual(["keep this"]);
		expect(f.requests).toHaveLength(1);

		await f.reopen(f.controller.snapshot().sessionId);
		expect(f.controller.snapshot().steering).toEqual(["keep this"]);

		const second = f.controller.submit("task B");
		await streaming[1]!.promise;
		f.controller.cancel();
		const continued = f.controller.submit("after cancel");
		await Promise.all([second, continued]);
		expect(f.requests).toEqual([
			["user task A"],
			["user task A", "user keep this", "user task B"],
			["user task A", "user keep this", "user task B", "user after cancel"],
		]);
		expect(f.overlapped).toBe(false);
		expect(f.controller.snapshot().steering).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a message the turn limit cannot answer stays queued instead of being silently consumed", async () => {
	const streaming = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<void>();
	const f = await fixture(
		(request, index) => {
			if (index > 0) return [{ type: "text", text: "picked up" }];
			streaming.resolve();
			return held(request, answer.promise, [{ type: "text", text: "first answer" }]);
		},
		[],
		1,
	);
	try {
		const first = f.controller.submit("task");
		await streaming.promise;
		await f.controller.submit("late note");
		answer.resolve();
		await first;
		expect(f.requests).toHaveLength(1);
		expect(f.controller.snapshot().steering).toEqual(["late note"]);
		await f.controller.submit("continue");
		expect(f.requests.at(-1)).toEqual([
			"user task",
			"assistant first answer",
			"user late note",
			"user continue",
		]);
	} finally {
		answer.resolve();
		await f.close();
	}
});

test("a message racing a session change stays queued in the session it was sent to", async () => {
	const streaming = Promise.withResolvers<void>();
	const f = await fixture((request, index) => {
		if (index > 0) return [{ type: "text", text: "fresh" }];
		streaming.resolve();
		return held(request, never, [{ type: "text", text: "never finishes" }]);
	});
	try {
		const first = f.controller.submit("old task");
		await streaming.promise;
		const original = f.controller.snapshot().sessionId;
		const interrupt = f.controller.submit("meant for the old session", "interrupt");
		const fresh = f.controller.command("/new");
		await expect(interrupt).rejects.toThrow("stays queued in its own session");
		await Promise.all([first, fresh]);
		expect(f.controller.snapshot().sessionId).not.toBe(original);
		expect(f.controller.snapshot().steering).toEqual([]);
		await f.controller.submit("new session task");
		expect(f.requests).toEqual([["user old task"], ["user new session task"]]);
		await f.controller.command(`/resume ${original}`);
		expect(f.controller.snapshot().sessionId).toBe(original);
		expect(f.controller.snapshot().steering).toEqual(["meant for the old session"]);
		expect(f.requests).toHaveLength(2);
	} finally {
		await f.close();
	}
});
