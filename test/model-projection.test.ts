import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { convertMessages as convertOpenAIMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { AssistantMessage, ImageContent, Message, Model, Usage } from "@oh-my-pi/pi-ai";
import type { HistoryEntry, ModelChoice, ProviderRequest, SalamConfig } from "../src/contracts.ts";
import { anthropicStream, contextFor } from "../src/providers/anthropic.ts";
import { createProviderGateway } from "../src/providers/index.ts";

const opus: ModelChoice = { provider: "claude-account", model: "claude-opus-4-6" };
const gpt: ModelChoice = { provider: "chatgpt-account", model: "gpt-5.4" };
const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(id: string, origin: ModelChoice, content: AssistantMessage["content"]): HistoryEntry {
	return {
		id,
		kind: "message",
		origin,
		message: {
			role: "assistant",
			content,
			// SDK provider names deliberately differ from the configured identity.
			provider: origin.provider === opus.provider ? "anthropic" : "openai-codex",
			api: origin.provider === opus.provider ? "anthropic-messages" : "openai-codex-responses",
			model: origin.model,
			timestamp: 1,
			usage,
			stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		},
	};
}

function user(id: string, text: string): HistoryEntry {
	return { id, kind: "message", message: { role: "user", content: text, timestamp: 0 } };
}

function request(entries: HistoryEntry[], selection = opus): ProviderRequest {
	return {
		selection,
		historyOrigin: opus,
		entries,
		sessionId: "11111111-1111-4111-8111-111111111111",
		cacheKey: "22222222-2222-4222-8222-222222222222",
		system: ["A fixed coding harness."],
		firstUserText: "Original task",
		tools: [
			{
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		],
		signal: AbortSignal.timeout(10_000),
		maxTokens: 128,
		reasoning: "high",
	};
}

interface WireBlock {
	type: string;
	text?: string;
	signature?: string;
	cache_control?: { type: string; ttl?: string };
	[key: string]: unknown;
}
interface WireBody {
	messages: { role: string; content: string | WireBlock[] }[];
	system: WireBlock[];
	tools: Record<string, unknown>[];
	metadata: { user_id: string };
	tool_choice?: { type: string };
}

// Real SDK serialization and HTTP, but never model inference. A deterministic 400
// terminates the stream after the local server has captured the actual wire body.
async function captureAnthropic(requests: ProviderRequest[], summarizing = false): Promise<WireBody[]> {
	const bodies: WireBody[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(incoming) {
			bodies.push((await incoming.json()) as WireBody);
			return Response.json(
				{ type: "error", error: { type: "invalid_request_error", message: "Local wire capture completed" } },
				{ status: 400 },
			);
		},
	});
	const model: Model<"anthropic-messages"> = buildModel({
		id: opus.model,
		provider: "anthropic",
		api: "anthropic-messages",
		name: "Opus fixture",
		baseUrl: server.url.toString(),
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	try {
		for (const input of requests) {
			for await (const event of anthropicStream(
				input,
				model,
				{ apiKey: "fixture-key", source: "fixture" },
				summarizing,
			)) {
				if (event.type === "done") throw new Error("Capture endpoint unexpectedly performed inference");
			}
		}
		expect(bodies).toHaveLength(requests.length);
		return bodies;
	} finally {
		await server.stop(true);
	}
}

test("Codex rewind shares cache routing while retaining separate branch and transport identities", async () => {
	const selection = { ...gpt, model: "gpt-5.6-luna" };
	const home = await mkdtemp(join(tmpdir(), "salam-codex-cache-"));
	const wires: {
		headers: Headers;
		body: { prompt_cache_key: string; client_metadata: Record<string, string> };
	}[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(incoming) {
			if (new URL(incoming.url).pathname.endsWith("/models")) return Response.json({ models: [] });
			const bytes = new Uint8Array(await incoming.arrayBuffer());
			const body = JSON.parse(
				new TextDecoder().decode(
					incoming.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes,
				),
			);
			wires.push({ headers: incoming.headers, body });
			return Response.json(
				{ error: { type: "invalid_request_error", message: "Local wire capture completed" } },
				{ status: 400 },
			);
		},
	});
	const config: SalamConfig = {
		home,
		cwd: home,
		selection,
		webSearchModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
		providers: { [selection.provider]: { kind: "openai-codex", baseUrl: server.url.toString() } },
		mcpServers: {},
		remotes: {},
		maxTurns: 1,
		maxAgents: 1,
		maxOutputTokens: 128,
		contextThreshold: 100000,
		reasoning: "off",
	};
	const claims = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
	).toString("base64url");
	await writeFile(
		join(home, "credentials.json"),
		JSON.stringify({
			version: 1,
			providers: { [selection.provider]: { kind: "openai-codex", apiKey: `e30.${claims}.fixture` } },
		}),
	);
	const gateway = await createProviderGateway(config);
	try {
		const source = request([user("first", "Original task")], selection);
		source.cacheKey = source.sessionId;
		const fork = { ...source, sessionId: "33333333-3333-4333-8333-333333333333" };
		for (const input of [source, fork]) {
			await expect(async () => {
				for await (const _event of gateway.stream(input)) {
					// The local endpoint captures the real SDK wire request without inference.
				}
			}).toThrow("Local wire capture completed");
		}
		expect(wires).toHaveLength(2);
		for (const [index, input] of [source, fork].entries()) {
			const { headers, body } = wires[index]!;
			expect(body.prompt_cache_key).toBe(source.sessionId);
			expect(headers.get("session-id")).toBe(body.prompt_cache_key);
			expect(headers.get("session_id")).toBe(input.sessionId);
			expect(headers.get("conversation_id")).toBe(input.sessionId);
			expect(body.client_metadata.session_id).toBe(input.sessionId);
			expect(JSON.parse(headers.get("x-codex-turn-metadata")!).session_id).toBe(input.sessionId);
			expect(headers.get("thread-id")).toBe(body.client_metadata.thread_id);
		}
		expect(wires[1]!.headers.get("thread-id")).not.toBe(wires[0]!.headers.get("thread-id"));
	} finally {
		await gateway.close();
		await server.stop(true);
		await rm(home, { recursive: true, force: true });
	}
});

test("Opus → GPT → Opus preserves each model's native prefix and excludes foreign opaque reasoning", () => {
	const native = assistant("opus", opus, [
		{ type: "thinking", thinking: "opus-private", thinkingSignature: "opus-signature" },
		{ type: "redactedThinking", data: "opus-redacted" },
		{ type: "text", text: "Opus visible answer", textSignature: "opus-text-signature" },
	]);
	const first = request([user("first", "Original task"), native, user("next", "Continue")]);
	const ownBefore = contextFor(first, false);
	const onGpt = contextFor({ ...first, selection: gpt }, false);
	const encodedGpt = JSON.stringify(onGpt);
	expect(encodedGpt).toContain("Opus visible answer");
	for (const secret of ["opus-private", "opus-signature", "opus-redacted", "opus-text-signature"])
		expect(encodedGpt).not.toContain(secret);
	const reply = assistant("gpt", gpt, [
		{ type: "thinking", thinking: "", thinkingSignature: "gpt-encrypted" },
		{ type: "text", text: "GPT visible answer", textSignature: "gpt-response-item" },
	]);
	if (reply.kind !== "message" || reply.message.role !== "assistant") throw new Error("Invalid fixture");
	reply.message.providerPayload = {
		type: "openaiResponsesHistory",
		items: [{ type: "reasoning", encrypted_content: "private-response-payload" }],
	};
	const mixed = { ...first, entries: [...first.entries, reply, user("again", "Continue again")] };
	const returned = contextFor(mixed, false);
	expect(returned.messages.slice(0, ownBefore.messages.length)).toEqual(ownBefore.messages);
	if (native.kind !== "message") throw new Error("Invalid fixture");
	expect(returned.messages[1]).toBe(native.message);
	expect(JSON.stringify(returned)).not.toContain("gpt-encrypted");
	expect(JSON.stringify(returned)).not.toContain("gpt-response-item");
	expect(JSON.stringify(returned)).not.toContain("private-response-payload");
	expect(contextFor({ ...mixed, selection: gpt }, false).messages[3]).toBe(reply.message);
	expect(contextFor({ ...mixed, selection: gpt }, false).messages.slice(0, onGpt.messages.length)).toEqual(
		onGpt.messages,
	);
});

test("foreign tools preserve arguments, failed results and images without executable tool messages", () => {
	const image: ImageContent = {
		type: "image",
		mimeType: "image/png",
		data: "aW1hZ2U=",
		providerFile: { provider: "anthropic", id: "private-upload" },
	};
	const call = assistant("call", opus, [
		{ type: "thinking", thinking: "hidden", thinkingSignature: "private-signature" },
		{ type: "toolCall", id: "toolu_original", name: "read_file", arguments: { path: "/tmp/result.png" } },
	]);
	const result: HistoryEntry = {
		id: "result",
		kind: "message",
		origin: opus,
		message: {
			role: "toolResult",
			toolCallId: "toolu_original",
			toolName: "read_file",
			isError: true,
			content: [
				{ type: "text", text: "Image decoded, metadata failed", textSignature: "private-text" },
				image,
			],
			timestamp: 2,
		},
	};
	const entries = [call, result];
	const projected = contextFor(request(entries, gpt), false).messages;
	expect(projected.map((message) => message.role)).toEqual(["user", "user"]);
	const encoded = JSON.stringify(projected);
	expect(encoded).toContain("/tmp/result.png");
	expect(encoded).toContain("Image decoded, metadata failed");
	expect(encoded).toContain('\\"isError\\":true');
	for (const secret of ["private-upload", "private-text", "private-signature", "hidden"])
		expect(encoded).not.toContain(secret);
	const resultMessage = projected[1]!;
	if (resultMessage.role !== "user" || typeof resultMessage.content === "string")
		throw new Error("Missing portable result");
	expect(resultMessage.content.at(-1)).toEqual({ type: "image", mimeType: "image/png", data: image.data });
	const spec = {
		id: gpt.model,
		name: "GPT fixture",
		baseUrl: "https://fixture.invalid",
		input: ["text", "image"] as ("text" | "image")[],
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const codex = buildModel({ ...spec, provider: "openai-codex", api: "openai-codex-responses" });
	const custom = buildModel({ ...spec, provider: "salam-custom-fixture", api: "openai-completions" });
	const context = contextFor(request(entries, gpt), false);
	const codexWire = convertCodexResponsesMessages(codex, context);
	const customWire = convertOpenAIMessages(custom, context, custom.compat);
	expect(
		codexWire.some(
			(item) =>
				item.type === "function_call" || item.type === "function_call_output" || item.type === "reasoning",
		),
	).toBe(false);
	expect(customWire.some((item) => item.role === "tool" || "tool_calls" in item)).toBe(false);
	for (const wire of [codexWire, customWire]) {
		expect(JSON.stringify(wire)).toContain(image.data);
		expect(JSON.stringify(wire)).toContain("Image decoded, metadata failed");
		expect(JSON.stringify(wire)).not.toContain("private-signature");
	}
	const own = contextFor(request(entries), false).messages;
	if (call.kind !== "message") throw new Error("Invalid fixture");
	expect(own[0]).toBe(call.message);
	expect(own[1]).toBe(result.message);
});

test("same SDK provider but different configured account or model is foreign; legacy origin stays explicit", () => {
	const message = assistant("original", opus, [
		{ type: "thinking", thinking: "private", thinkingSignature: "model-bound" },
		{ type: "text", text: "Public output" },
	]);
	const legacy = { ...message, origin: undefined };
	for (const selection of [
		{ provider: opus.provider, model: "claude-sonnet-4-6" },
		{ provider: "another-claude-account", model: opus.model },
	]) {
		const projected = contextFor(request([legacy], selection), false).messages;
		expect(projected[0]?.role).toBe("user");
		expect(JSON.stringify(projected)).toContain(opus.provider);
		expect(JSON.stringify(projected)).not.toContain("model-bound");
	}
});

test("foreign dynamic controls append portable instructions without rewriting tool schemas or earlier controls", () => {
	const first: HistoryEntry = {
		id: "control",
		kind: "system",
		origin: opus,
		text: "Inspect only",
		removeTools: ["write_file"],
	};
	const input = request([first], gpt);
	const previous = contextFor(input, false);
	const next = contextFor(
		{
			...input,
			entries: [
				first,
				{ id: "enable", kind: "system", origin: opus, text: "Allow reading", addTools: ["read_file"] },
			],
		},
		false,
	);
	expect(next.messages.slice(0, 1)).toEqual(previous.messages);
	expect(next.tools).toEqual(previous.tools);
	expect(next.messages.map((message) => message.role)).toEqual(["user", "user"]);
	expect(JSON.stringify(next.messages)).toContain("Do not invoke these tools");
	expect(JSON.stringify(next.messages)).toContain("Tools enabled");
	expect(next.messages.some((message) => "providerPayload" in message)).toBe(false);
});

test("Anthropic retains the prior request breakpoint across more than twenty foreign blocks and a rewind", async () => {
	const native = assistant("own-answer", opus, [
		{ type: "thinking", thinking: "native-thought", thinkingSignature: "native-signature" },
		{ type: "text", text: "Native answer" },
	]);
	const initial = request([user("first", "Original task"), native, user("boundary", "Next request")]);
	const foreign = Array.from({ length: 25 }, (_, i) =>
		assistant(`gpt-${i}`, gpt, [{ type: "text", text: `Foreign answer ${i}` }]),
	);
	const returned = { ...initial, cacheBoundary: "boundary", entries: [...initial.entries, ...foreign] };
	const rewind = {
		...returned,
		sessionId: "33333333-3333-4333-8333-333333333333",
		entries: returned.entries.slice(0, 8),
	};
	const [before, after, fork] = await captureAnthropic([initial, returned, rewind]);
	for (const body of [after!, fork!]) {
		expect(body.system.slice(1)).toEqual(before!.system.slice(1));
		// OAuth's SDK attests the whole serialized request in the first billing
		// block. Only that cch hash is request-varying; its fingerprint seed is frozen.
		expect(body.system[0]!.text?.replace(/cch=[0-9a-f]{5}/, "cch=<attestation>")).toEqual(
			before!.system[0]!.text?.replace(/cch=[0-9a-f]{5}/, "cch=<attestation>"),
		);
		expect(body.tools).toEqual(before!.tools);
		expect(body.metadata).toEqual(before!.metadata);
		expect(body.messages.slice(0, before!.messages.length)).toEqual(before!.messages);
		expect(JSON.stringify(body.messages)).toContain("native-signature");
		const blocks = body.messages.flatMap((message) =>
			typeof message.content === "string" ? [] : message.content,
		);
		expect(blocks.filter((block) => block.cache_control)).toHaveLength(2);
		expect(blocks.find((block) => block.text === "Next request")?.cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		expect(blocks.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	}
	expect(after!.messages.length).toBeGreaterThan(fork!.messages.length);
	expect(JSON.stringify(fork!.metadata)).toContain(initial.cacheKey!);
	expect(JSON.stringify(fork!.metadata)).not.toContain(rewind.sessionId);
});

test("Anthropic boundary follows a merged native tool-result block, not a history-entry ordinal", async () => {
	const call = assistant("call", opus, [
		{ type: "thinking", thinking: "native", thinkingSignature: "native-tool-signature" },
		{ type: "toolCall", id: "toolu_one", name: "read_file", arguments: { path: "one" } },
		{ type: "toolCall", id: "toolu_two", name: "read_file", arguments: { path: "two" } },
	]);
	const results: HistoryEntry[] = ["one", "two"].map((name) => ({
		id: name,
		kind: "message",
		origin: opus,
		message: {
			role: "toolResult",
			toolCallId: `toolu_${name}`,
			toolName: "read_file",
			isError: false,
			content: [{ type: "text", text: `Result ${name}` }],
			timestamp: 2,
		},
	}));
	const input = request([user("first", "Original task"), call, ...results]);
	const more = {
		...input,
		cacheBoundary: "two",
		entries: [...input.entries, assistant("foreign", gpt, [{ type: "text", text: "Imported answer" }])],
	};
	const [before, after] = await captureAnthropic([input, more]);
	expect(after!.messages.slice(0, before!.messages.length)).toEqual(before!.messages);
	const merged = after!.messages.find(
		(message) =>
			Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result"),
	);
	if (!merged || typeof merged.content === "string") throw new Error("No merged tool results");
	expect(merged.content.map((block) => block.tool_use_id)).toEqual(["toolu_one", "toolu_two"]);
	expect(merged.content[1]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
});

test("signed compaction head survives foreign events and a missing rewind boundary; recap remains non-acting", async () => {
	const head = [
		{ type: "text", text: "Frozen signed system", cache_control: { type: "ephemeral", ttl: "1h" } },
	];
	const compact: HistoryEntry = {
		id: "compact",
		kind: "compaction",
		origin: opus,
		provider: opus.provider,
		model: opus.model,
		summary: "Signed visible summary",
		native: {
			type: "anthropic-signed-compaction-v1",
			system: head,
			tools: [],
			content: [{ type: "compaction", content: "Signed visible summary", signature: "signed-compaction" }],
		},
	};
	const input = request([
		compact,
		user("continue", "Continue task"),
		assistant("foreign", gpt, [{ type: "text", text: "Foreign work" }]),
	]);
	input.cacheBoundary = "continue";
	const [body, missing] = await captureAnthropic(
		[input, { ...input, cacheBoundary: "removed-on-rewind" }],
		true,
	);
	expect(body!.system).toEqual(head);
	expect(body!.tools).toEqual([]);
	expect(body!.messages[0]).toEqual({
		role: "assistant",
		content: [{ type: "compaction", content: "Signed visible summary", signature: "signed-compaction" }],
	});
	expect(body!.tool_choice).toEqual({ type: "none" });
	const retained = body!.messages[1]!.content;
	if (typeof retained === "string") throw new Error("Signed prefix boundary was not retained");
	expect(retained[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	expect(missing!.system).toEqual(body!.system);
	expect(missing!.messages[0]).toEqual(body!.messages[0]);
	expect(missing!.metadata).toEqual(body!.metadata);
	const missingMarkers = missing!.messages
		.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
		.filter((block) => block.cache_control);
	expect(missingMarkers).toHaveLength(1);
	const onGpt: Message[] = contextFor({ ...input, selection: gpt }, false).messages;
	expect(JSON.stringify(onGpt)).toContain("Signed visible summary");
	expect(JSON.stringify(onGpt)).not.toContain("signed-compaction");
	expect(JSON.stringify(onGpt)).not.toContain("Frozen signed system");
});
