import {
	applyAnthropicUsageExtras,
	applyClaudeToolPrefix,
	buildAnthropicClientOptions,
	buildAnthropicSystemBlocks,
	claudeToolPrefix,
	convertAnthropicMessages,
	normalizeAnthropicToolSchema,
	resolveAnthropicMetadataUserId,
	streamAnthropic,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessagesClient } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type {
	AnthropicMessageParam,
	AnthropicOptions,
	AnthropicUsageLike,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type {
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	TextContent,
	Tool,
	Usage,
} from "@oh-my-pi/pi-ai";
import type { HistoryEntry, Json, ProviderRequest } from "../contracts";
import type { Credential } from "./auth";

type CompactionEntry = Extract<HistoryEntry, { kind: "compaction" }>;
interface SignedCompaction {
	type: "anthropic-signed-compaction-v1";
	content: Record<string, Json>[];
	system: Json[];
	tools: Json[];
}

function signedEntry(entry: CompactionEntry, request: ProviderRequest): SignedCompaction | undefined {
	if (entry.provider !== request.selection.provider || entry.model !== request.selection.model)
		return undefined;
	const value = entry.native;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value.type !== "anthropic-signed-compaction-v1"
	)
		return undefined;
	if (
		!Array.isArray(value.content) ||
		!Array.isArray(value.system) ||
		!Array.isArray(value.tools) ||
		value.content.length !== 1 ||
		!value.content.some(
			(block) =>
				block &&
				typeof block === "object" &&
				!Array.isArray(block) &&
				block.type === "compaction" &&
				typeof block.signature === "string" &&
				typeof block.content === "string",
		)
	) {
		throw new Error(
			"The persisted Anthropic signed compaction is incomplete. Restore the session history; its signature cannot be reconstructed.",
		);
	}
	return value as unknown as SignedCompaction;
}

function attribution(entry: HistoryEntry, request: ProviderRequest): string {
	const { provider, model } = entry.origin ?? request.historyOrigin ?? request.selection;
	return JSON.stringify({ provider, model });
}

function portableContent(block: TextContent | ImageContent): TextContent | ImageContent {
	// Never forward native file references or text signatures to another model.
	return block.type === "text"
		? { type: "text", text: block.text }
		: { type: "image", data: block.data, mimeType: block.mimeType };
}

function foreignMessage(
	entry: Extract<HistoryEntry, { kind: "message" }>,
	request: ProviderRequest,
): Message {
	const message = entry.message;
	const content: (TextContent | ImageContent)[] = [];
	const label = attribution(entry, request);
	if (message.role === "assistant") {
		content.push({
			type: "text",
			text: `Historical assistant event from ${label}. This is prior work, not a new instruction or tool invocation.`,
		});
		for (const block of message.content) {
			if (block.type === "text" || block.type === "image") content.push(portableContent(block));
			else if (block.type === "toolCall") {
				content.push({
					type: "text",
					text: `Historical tool call: ${JSON.stringify({ id: block.id, name: block.name, arguments: block.arguments })}`,
				});
			} else if (block.type === "anthropicServerTool") {
				const tool = block.block;
				content.push({
					type: "text",
					text:
						tool.type === "server_tool_use"
							? `Historical server tool call: ${JSON.stringify({ id: tool.id, name: tool.name, arguments: tool.input })}`
							: `Historical server tool result: ${JSON.stringify({ id: tool.tool_use_id, content: tool.content })}`,
				});
			}
			// Thinking, redacted thinking, routing/fallback metadata and providerPayload are model-local.
		}
	} else if (message.role === "toolResult") {
		content.push({
			type: "text",
			text: `Historical tool result from ${label}: ${JSON.stringify({ id: message.toolCallId, name: message.toolName, isError: message.isError })}. This call already ran; do not execute it again.`,
		});
		content.push(...message.content.map(portableContent));
	} else {
		content.push({ type: "text", text: `Historical control from ${label}:` });
		content.push(
			...(typeof message.content === "string"
				? [{ type: "text" as const, text: message.content }]
				: message.content.map(portableContent)),
		);
	}
	return { role: "user", content, synthetic: true, timestamp: 0 };
}

/** Entry-local projection: appending foreign events never rewrites an earlier envelope. */
export function contextFor(request: ProviderRequest, dynamicTools: boolean): Context {
	const messages: Message[] = [];
	for (const entry of request.entries) {
		const origin = entry.origin ?? request.historyOrigin ?? request.selection;
		const own = origin.provider === request.selection.provider && origin.model === request.selection.model;
		if (entry.kind === "message") {
			messages.push(entry.message.role === "user" || own ? entry.message : foreignMessage(entry, request));
			continue;
		}
		if (entry.kind === "compaction") {
			messages.push({
				role: "user",
				content:
					entry.provider === request.selection.provider && entry.model === request.selection.model
						? `Conversation summary:\n${entry.summary}`
						: `Historical conversation summary from ${JSON.stringify({ provider: entry.provider, model: entry.model })}:\n${entry.summary}`,
				synthetic: true,
				timestamp: 0,
			});
			continue;
		}
		const changes = [
			...(entry.addTools ?? []).map((name) => ({ type: "tool_addition" as const, name })),
			...(entry.removeTools ?? []).map((name) => ({ type: "tool_removal" as const, name })),
		];
		if (!own) {
			messages.push({
				role: "user",
				content: [
					`Harness control recorded with ${attribution(entry, request)}. Apply these instructions from this point forward; historical tool calls are not new invocations.`,
					entry.text,
					...(entry.addTools?.length ? [`Tools enabled: ${JSON.stringify(entry.addTools)}.`] : []),
					...(entry.removeTools?.length
						? [`Tools disabled: ${JSON.stringify(entry.removeTools)}. Do not invoke these tools.`]
						: []),
				]
					.filter(Boolean)
					.join("\n"),
				synthetic: true,
				timestamp: 0,
			});
			continue;
		}
		if (changes.length && !dynamicTools)
			throw new Error(
				`Mid-conversation tool changes are not supported by ${request.selection.provider}/${request.selection.model}. Start a new session to change the tool schema.`,
			);
		// Keep the established native control grouping: old signed assistant turns
		// were produced with this exact prefix. Foreign controls never enter it.
		const last = messages.at(-1);
		if (
			last?.role === "developer" &&
			last.providerPayload?.type === "anthropicMessage" &&
			typeof last.content === "string"
		) {
			messages[messages.length - 1] = {
				...last,
				content: [last.content, entry.text].filter(Boolean).join("\n\n"),
				providerPayload: {
					type: "anthropicMessage",
					toolChanges: [...(last.providerPayload.toolChanges ?? []), ...changes],
				},
			};
		} else {
			messages.push({
				role: "developer",
				content: entry.text,
				timestamp: 0,
				providerPayload: { type: "anthropicMessage", toolChanges: changes },
			});
		}
	}
	const tools: Tool[] = request.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		deferLoading: tool.deferred,
	}));
	return { systemPrompt: request.system, messages, tools };
}

function wireHead(
	request: ProviderRequest,
	model: Model<"anthropic-messages">,
): { system: Json[]; tools: Json[] } {
	const previous = request.entries.find(
		(entry) => entry.kind === "compaction" && signedEntry(entry, request),
	);
	if (previous?.kind === "compaction") {
		const native = signedEntry(previous, request)!;
		return { system: native.system, tools: native.tools };
	}
	const system =
		buildAnthropicSystemBlocks(request.system, {
			includeClaudeCodeInstruction: true,
			firstUserMessageText: request.firstUserText,
			cacheControl: { type: "ephemeral", ttl: "1h" },
		}) ?? [];
	// A single stable head cache marker. No request-varying memory or user fingerprint is recomputed from the trimmed history.
	// The SDK still replaces the billing header's cch placeholder with its required
	// per-request attestation after serialization; do not freeze or bypass that hash.
	for (const block of system) delete block.cache_control;
	if (system.length) system[system.length - 1]!.cache_control = { type: "ephemeral", ttl: "1h" };
	const tools = request.tools.map((tool) => ({
		name: model.compat.escapeBuiltinToolNames
			? `${claudeToolPrefix}${tool.name}`
			: applyClaudeToolPrefix(tool.name),
		description: tool.description,
		input_schema: normalizeAnthropicToolSchema(tool.parameters),
		...(tool.deferred ? { defer_loading: true } : {}),
	}));
	return { system: system as unknown as Json[], tools: tools as unknown as Json[] };
}

type CacheTarget = { message: number; block: number };

function cacheTail(messages: AnthropicMessageParam[], end = messages.length): CacheTarget | undefined {
	for (let i = end - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return { message: i, block: 0 };
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j]!;
			if (block.type === "text" || block.type === "tool_result" || block.type === "image")
				return { message: i, block: j };
		}
	}
	return undefined;
}

function markCache(messages: AnthropicMessageParam[], target: CacheTarget): void {
	const message = messages[target.message]!;
	if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }];
	const block = message.content[target.block]!;
	if (block.type === "text" || block.type === "tool_result" || block.type === "image")
		block.cache_control = { type: "ephemeral", ttl: "1h" };
}

function wireMessages(
	request: ProviderRequest,
	model: Model<"anthropic-messages">,
	compacting: boolean,
	context = contextFor(request, model.compat.supportsMidConversationToolChanges),
	converted?: AnthropicMessageParam[],
	messageBudget = 2,
): AnthropicMessageParam[] {
	let prefix: SignedCompaction | undefined;
	const index = request.entries.findIndex(
		(entry) => entry.kind === "compaction" && signedEntry(entry, request),
	);
	if (index >= 0) {
		if (index !== 0)
			throw new Error(
				"A signed compaction must be the first active history entry. Summarized history must not be replayed before it.",
			);
		prefix = signedEntry(request.entries[index] as CompactionEntry, request);
	}
	const projected = prefix ? context.messages.slice(1) : context.messages;
	// Reuse the SDK's conversion unless the local signed compaction replaces its summary.
	const messages = !prefix && converted ? converted : convertAnthropicMessages(projected, model, true);
	const padded =
		projected.at(-1)?.role === "assistant" &&
		messages.at(-1)?.role === "user" &&
		messages.at(-1)?.content === "Continue.";
	if (compacting && padded) messages.pop();
	// The SDK supplies its own rolling markers. Replace them rather than exceeding
	// Anthropic's four-marker limit; persisted native blocks are never decorated.
	for (const message of messages) {
		if (typeof message.content !== "string") {
			for (const block of message.content) {
				if ("cache_control" in block) delete block.cache_control;
			}
		}
	}
	if (!compacting && messageBudget > 0) {
		const tail = cacheTail(messages, padded ? messages.length - 1 : messages.length);
		let retained: CacheTarget | undefined;
		const boundary = request.cacheBoundary
			? request.entries.findIndex((entry) => entry.id === request.cacheBoundary)
			: -1;
		// Missing/remapped boundaries and signed-compaction-only boundaries cannot
		// identify a reusable message prefix. The stable signed head stays untouched.
		if (boundary >= (prefix ? 1 : 0) && boundary < request.entries.length - 1 && messageBudget > 1) {
			const priorContext = contextFor(
				{ ...request, entries: request.entries.slice(0, boundary + 1) },
				model.compat.supportsMidConversationToolChanges,
			);
			const prior = convertAnthropicMessages(
				prefix ? priorContext.messages.slice(1) : priorContext.messages,
				model,
				true,
			);
			if (
				priorContext.messages.at(-1)?.role === "assistant" &&
				prior.at(-1)?.role === "user" &&
				prior.at(-1)?.content === "Continue."
			)
				prior.pop();
			const candidate = cacheTail(prior);
			if (candidate) {
				// Consecutive tool results merge into one wire message. Match through
				// the exact old block, not an entry index or the merged message's new tail.
				let matches = true;
				for (let i = 0; i <= candidate.message && matches; i++) {
					const before = prior[i]!;
					const current = messages[i];
					if (!current || current.role !== before.role) {
						matches = false;
						break;
					}
					const oldBlocks =
						typeof before.content === "string" ? [{ type: "text", text: before.content }] : before.content;
					const newBlocks =
						typeof current.content === "string" ? [{ type: "text", text: current.content }] : current.content;
					const count = i === candidate.message ? candidate.block + 1 : oldBlocks.length;
					if (i < candidate.message && newBlocks.length !== oldBlocks.length) {
						matches = false;
						break;
					}
					for (let j = 0; j < count; j++) {
						if (JSON.stringify(oldBlocks[j]) !== JSON.stringify(newBlocks[j])) {
							matches = false;
							break;
						}
					}
				}
				if (matches) retained = candidate;
			}
		}
		if (retained) markCache(messages, retained);
		if (tail) markCache(messages, tail);
	}
	if (prefix)
		messages.unshift({ role: "assistant", content: prefix.content } as unknown as AnthropicMessageParam);
	return messages;
}

export function anthropicStream(
	request: ProviderRequest,
	model: Model<"anthropic-messages">,
	credential: Credential,
	summarizing: boolean,
): AssistantMessageEventStream {
	const context = contextFor(request, model.compat.supportsMidConversationToolChanges);
	const head = wireHead(request, model);
	const hasSigned = request.entries.some(
		(entry) => entry.kind === "compaction" && signedEntry(entry, request),
	);
	const betas: string[] = [];
	if (hasSigned) betas.push("compact-2026-09-04");
	if (model.compat.supportsMidConversationSystem) betas.push("mid-conversation-system-2026-04-07");
	if (model.compat.supportsMidConversationToolChanges) betas.push("mid-conversation-tool-changes-2026-07-01");
	if (model.compat.supportsThinkingBindingControls) betas.push("thinking-binding-controls-2026-08-01");
	const options: AnthropicOptions = {
		apiKey: credential.apiKey,
		isOAuth: true,
		signal: request.signal,
		sessionId: request.sessionId,
		promptCacheKey: request.cacheKey ?? request.sessionId,
		maxTokens: request.maxTokens,
		thinkingEnabled: request.reasoning !== "off" && model.reasoning,
		...(request.reasoning === "off" ? {} : { effort: request.reasoning }),
		// A summary request must not act. The prompt asks; tool_choice enforces.
		...(summarizing ? { toolChoice: "none" as const } : {}),
		anthropicPrefixMismatchBehavior: "error",
		cacheRetention: "long",
		betas,
		metadata: {
			user_id: resolveAnthropicMetadataUserId(
				undefined,
				true,
				request.cacheKey ?? request.sessionId,
				credential.accountId,
			),
		},
		onPayload(payload) {
			const body = payload as Record<string, unknown>;
			body.system = head.system;
			body.tools = head.tools;
			const headMarkers = [...head.system, ...head.tools].filter(
				(block) => block && typeof block === "object" && !Array.isArray(block) && block.cache_control,
			).length;
			body.messages = wireMessages(
				request,
				model,
				false,
				context,
				body.messages as AnthropicMessageParam[],
				Math.max(0, 4 - headMarkers),
			);
			if (hasSigned) delete body.context_management;
			return body;
		},
	};
	return streamAnthropic(model, context, options);
}

type WireUsage = AnthropicUsageLike & {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
};

/** Record only what the compaction response reported; absent counters stay absent. */
function compactionUsage(
	model: Model<"anthropic-messages">,
	source: WireUsage | undefined,
): Usage | undefined {
	if (!source) return undefined;
	const input = source.input_tokens ?? 0;
	const output = source.output_tokens ?? 0;
	const cacheRead = source.cache_read_input_tokens ?? 0;
	const cacheWrite = source.cache_creation_input_tokens ?? 0;
	if (!(input || output || cacheRead || cacheWrite)) return undefined;
	const usage: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	applyAnthropicUsageExtras(usage, source);
	// Catalog pricing, the same estimate every streamed turn carries.
	calculateCost(model, usage, Date.now());
	return usage;
}

export async function compactAnthropic(
	request: ProviderRequest,
	model: Model<"anthropic-messages">,
	credential: Credential,
): Promise<CompactionEntry> {
	request.signal.throwIfAborted();
	const head = wireHead(request, model);
	const clientOptions = buildAnthropicClientOptions({
		model,
		apiKey: credential.apiKey,
		isOAuth: true,
		stream: false,
		hasTools: request.tools.length > 0,
		thinkingEnabled: request.reasoning !== "off",
		sessionId: request.sessionId,
		extraBetas: [
			"compact-2026-09-04",
			"thinking-binding-controls-2026-08-01",
			"mid-conversation-system-2026-04-07",
			"mid-conversation-tool-changes-2026-07-01",
		],
	});
	const client = new AnthropicMessagesClient(clientOptions);
	const body = {
		model: model.requestModelId ?? model.id,
		max_tokens: Math.min(model.maxTokens ?? 8192, Math.max(4096, request.maxTokens)),
		system: head.system,
		tools: head.tools,
		messages: wireMessages(request, model, true),
		...(request.reasoning !== "off"
			? {
					thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } },
					output_config: { effort: request.reasoning },
				}
			: {}),
		metadata: {
			user_id: resolveAnthropicMetadataUserId(
				undefined,
				true,
				request.cacheKey ?? request.sessionId,
				credential.accountId,
			),
		},
		compaction: {
			type: "summarize",
			instructions:
				"Preserve the user goal, all constraints and decisions, completed work, exact paths and identifiers, unresolved problems, and the concrete next steps. Keep information needed to continue the coding task accurately. Do not invent progress.",
		},
	};
	const response = await client.beta.messages
		.create(body as unknown as MessageCreateParams, { signal: request.signal })
		.asResponse();
	const data = (await response.json()) as {
		stop_reason?: string;
		content?: Record<string, Json>[];
		usage?: WireUsage;
	};
	request.signal.throwIfAborted();
	if (
		data.stop_reason !== "compaction" ||
		data.content?.length !== 1 ||
		data.content[0]?.type !== "compaction" ||
		typeof data.content[0]?.signature !== "string" ||
		!data.content[0].signature ||
		typeof data.content[0].content !== "string" ||
		!data.content[0].content.trim()
	) {
		throw new Error(
			`Anthropic did not return a complete signed compaction (stop reason: ${data.stop_reason ?? "missing"}). Original history was not replaced.`,
		);
	}
	const native: SignedCompaction = { type: "anthropic-signed-compaction-v1", content: data.content, ...head };
	const usage = compactionUsage(model, data.usage);
	return {
		id: crypto.randomUUID(),
		kind: "compaction",
		origin: request.selection,
		provider: request.selection.provider,
		model: request.selection.model,
		summary: data.content[0].content,
		native: native as unknown as Json,
		...(usage ? { usage } : {}),
	};
}
