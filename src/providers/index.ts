import { streamSimple } from "@oh-my-pi/pi-ai";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	ProviderSessionState,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { normalizeOpenAIPromptCacheKey } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type {
	HistoryEntry,
	ModelChoice,
	ProviderEvent,
	ProviderGateway,
	ProviderRequest,
	ProviderUsage,
	SalamConfig,
} from "../contracts";
import { type Credential, Credentials } from "./auth";
import { anthropicStream, compactAnthropic, contextFor } from "./anthropic";
import { dynamicAnthropic, Models, profileFor } from "./models";
import { fetchProviderUsage, usageFetchers, usageUnavailable } from "./usage";
import { nativeWebFetch, nativeWebSearch } from "./web";

export async function createProviderGateway(config: SalamConfig): Promise<ProviderGateway> {
	const credentials = new Credentials(config);
	const catalog = new Models(config);
	const shutdown = new AbortController();
	const sessions = new Map<string, Map<string, ProviderSessionState>>();
	let closed: Promise<void> | undefined;

	function capabilities(selection: ModelChoice) {
		const profile = profileFor(config, selection.provider);
		const dynamic = dynamicAnthropic(profile, selection.model);
		return {
			dynamicSystem: dynamic,
			dynamicTools: dynamic,
			signedCompaction: dynamic,
			notesContext: profile.kind === "openai-codex",
		};
	}

	async function* streamRequest(
		original: ProviderRequest,
		mode: { summarizing?: boolean; isolated?: boolean } = {},
	): AsyncGenerator<ProviderEvent> {
		shutdown.signal.throwIfAborted();
		const lifetime = new AbortController();
		const signal = AbortSignal.any([original.signal, shutdown.signal, lifetime.signal]);
		const request = { ...original, signal };
		signal.throwIfAborted();
		const profile = profileFor(config, request.selection.provider);
		const credential = await credentials.resolve(request.selection.provider, profile, signal);
		const model = await catalog.resolve(request.selection, credential, signal);
		// An isolated request keeps its provider session state out of the working session and
		// closes it with the request, so no temporary state map outlives the call.
		const scratch = mode.isolated ? new Map<string, ProviderSessionState>() : undefined;
		let stream: AssistantMessageEventStream;
		try {
			if (profile.kind === "anthropic") {
				stream = anthropicStream(
					request,
					model as Model<"anthropic-messages">,
					credential,
					mode.summarizing === true,
				);
			} else {
				let state = scratch;
				if (!state) {
					state = sessions.get(request.sessionId);
					if (!state) {
						state = new Map();
						sessions.set(request.sessionId, state);
					}
				}
				const options: SimpleStreamOptions = {
					apiKey: credential.apiKey,
					signal,
					// Isolated summaries keep their own transport identity while sharing the
					// working session's prompt-cache identity.
					sessionId: scratch ? `${request.sessionId}:${crypto.randomUUID()}` : request.sessionId,
					promptCacheKey: request.cacheKey ?? request.sessionId,
					preferWebsockets: false,
					statefulResponses: false,
					providerSessionState: state,
					maxTokens: request.maxTokens,
					reasoning:
						request.reasoning === "off" || !model.thinking ? undefined : (request.reasoning as Effort),
					disableReasoning: request.reasoning === "off",
					cacheRetention: "long",
					...(mode.summarizing && profile.kind !== "devin" ? { toolChoice: "none" as const } : {}),
					// No temperature override: Cascade rejects zero, and several Claude models reject sampling parameters.
				};
				if (profile.kind === "openai-codex" && options.promptCacheKey !== options.sessionId) {
					const affinity = normalizeOpenAIPromptCacheKey(options.promptCacheKey);
					const fetch = globalThis.fetch;
					// Codex routes cache affinity by `session-id`, not `session_id`. The SDK
					// currently derives both from transport identity, overriding custom headers.
					// Keep logical session/thread metadata separate, as codex-rs does for forks.
					options.fetch = (input, init) => {
						const headers = new Headers(
							init?.headers ?? (input instanceof Request ? input.headers : undefined),
						);
						if (affinity) headers.set("session-id", affinity);
						return fetch(input, { ...init, headers });
					};
				}
				stream = streamSimple(model, contextFor(request, false), options);
			}
			let finished = false;
			for await (const event of stream) {
				signal.throwIfAborted();
				if (event.type === "text_delta") yield { type: "text", delta: event.delta };
				else if (event.type === "thinking_delta") yield { type: "thinking", delta: event.delta };
				else if (event.type === "error") {
					if (event.reason === "aborted") throw new DOMException("Provider request aborted.", "AbortError");
					let message = event.error.errorMessage ?? `${request.selection.provider} inference failed.`;
					for (const value of [credential.apiKey, ...Object.values(model.headers ?? {})]) {
						if (value) message = message.replaceAll(value, "[credential redacted]");
					}
					const error = new Error(message);
					Object.assign(error, { status: event.error.errorStatus, provider: request.selection.provider });
					throw error;
				} else if (event.type === "done") {
					if (event.message.stopReason === "error" || event.message.stopReason === "aborted")
						throw new Error(event.message.errorMessage ?? "Provider failed to complete.");
					if (
						event.message.inputTransformations?.some((change) => /thinking/i.test(JSON.stringify(change)))
					) {
						throw new Error(
							"The provider dropped or rewrote preserved thinking. Salam refused to commit the altered conversation; restore the original prefix or start a new session.",
						);
					}
					finished = true;
					// Return the entire native message, including opaque reasoning/signatures and response history payloads.
					yield { type: "done", message: event.message };
				}
			}
			if (!finished)
				throw new Error(`${request.selection.provider} stream ended without a final assistant message.`);
		} finally {
			// A caller that breaks iteration must cancel the underlying provider request too.
			lifetime.abort();
			if (scratch) {
				for (const value of scratch.values()) value.close();
				scratch.clear();
			}
		}
	}

	return {
		capabilities,
		stream: (request) => streamRequest(request),
		async webFetch(original) {
			const signal = AbortSignal.any([original.signal, shutdown.signal]);
			signal.throwIfAborted();
			const profile = profileFor(config, original.selection.provider);
			const credential = await credentials.resolve(original.selection.provider, profile, signal);
			const model = await catalog.resolve(original.selection, credential, signal);
			return nativeWebFetch({ ...original, signal, maxTokens: config.maxOutputTokens }, model, credential);
		},
		async webSearch(original) {
			const signal = AbortSignal.any([original.signal, shutdown.signal]);
			signal.throwIfAborted();
			const selection = config.webSearchModel;
			const profile = profileFor(config, selection.provider);
			const credential = await credentials.resolve(selection.provider, profile, signal);
			const model = await catalog.resolve(selection, credential, signal);
			const message = await nativeWebSearch(
				{ ...original, selection, signal, maxTokens: Math.min(config.maxOutputTokens, 4096) },
				model,
				credential,
			);
			return { selection, message };
		},
		async models() {
			shutdown.signal.throwIfAborted();
			const groups = await Promise.all(
				Object.entries(config.providers).map(async ([provider, profile]) => {
					if (profile.kind === "devin" || profile.kind === "openai-codex") {
						try {
							const credential = await credentials.resolve(provider, profile, shutdown.signal);
							if (profile.kind === "devin")
								await catalog.discoverDevin(provider, credential, shutdown.signal);
							else await catalog.discoverCodex(provider, credential, shutdown.signal);
						} catch {
							shutdown.signal.throwIfAborted(); /* Bundled catalog remains browsable without login/network. */
						}
					}
					return catalog.bundled(provider).map((model) => ({
						provider,
						model: model.id,
						label: model.name,
						contextWindow: model.contextWindow ?? undefined,
					}));
				}),
			);
			return groups.flat();
		},
		async compact(original) {
			const signal = AbortSignal.any([original.signal, shutdown.signal]);
			signal.throwIfAborted();
			const request = { ...original, signal };
			if (!request.entries.length) throw new Error("There is no conversation history to compact.");
			if (capabilities(request.selection).signedCompaction) {
				const profile = profileFor(config, request.selection.provider);
				const credential = await credentials.resolve(request.selection.provider, profile, signal);
				const model = await catalog.resolve(request.selection, credential, signal);
				return compactAnthropic(request, model as Model<"anthropic-messages">, credential);
			}
			const instruction: HistoryEntry = {
				id: crypto.randomUUID(),
				kind: "message",
				origin: request.selection,
				message: {
					role: "user",
					timestamp: Date.now(),
					synthetic: true,
					content:
						"Summarize this conversation so another invocation can continue the coding task. Preserve the goal, user constraints, decisions, exact file paths and identifiers, work actually completed, unresolved errors, and concrete next steps. Do not call tools. Return only the factual continuation summary; do not invent progress.",
				},
			};
			let answer: AssistantMessage | undefined;
			for await (const event of streamRequest(
				{
					...request,
					entries: [...request.entries, instruction],
					maxTokens: Math.min(request.maxTokens, 8192),
				},
				{ summarizing: true },
			)) {
				if (event.type === "done") answer = event.message;
			}
			if (
				!answer ||
				answer.stopReason === "length" ||
				answer.content.some((block) => block.type === "toolCall")
			)
				throw new Error(
					"Compaction did not produce a complete summary. The original history was not replaced.",
				);
			const summary = answer.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (!summary)
				throw new Error("Compaction returned an empty summary. The original history was not replaced.");
			const usage = answer.usage;
			return {
				id: crypto.randomUUID(),
				kind: "compaction",
				origin: request.selection,
				summary,
				provider: request.selection.provider,
				model: request.selection.model,
				// Only a provider-reported count is recorded; an all-zero usage reported nothing.
				...(usage.totalTokens > 0 ? { usage } : {}),
			};
		},
		async recap(original) {
			const signal = AbortSignal.any([original.signal, shutdown.signal]);
			signal.throwIfAborted();
			const request = { ...original, signal };
			if (!request.entries.length) throw new Error("There is no conversation to summarize yet.");
			let answer: AssistantMessage | undefined;
			// Read-only: isolated session state, no tools, and the canonical history is untouched.
			for await (const event of streamRequest(request, { summarizing: true, isolated: true })) {
				if (event.type === "done") answer = event.message;
			}
			if (!answer || answer.content.some((block) => block.type === "toolCall"))
				throw new Error("The recap request tried to call tools instead of answering. Nothing was changed.");
			if (answer.stopReason === "length")
				throw new Error(
					"The recap ran out of output budget before it finished. Nothing was changed; retry with a narrower focus.",
				);
			if (!answer.content.some((block) => block.type === "text" && block.text.trim()))
				throw new Error("The recap returned no summary text. Nothing was changed.");
			// The entire native message, including reasoning signatures and reported usage.
			return answer;
		},
		async usage(selection, signal) {
			const merged = AbortSignal.any([signal, shutdown.signal]);
			merged.throwIfAborted();
			const provider = selection.provider;
			const profile = profileFor(config, provider);
			const fetcher = usageFetchers[profile.kind];
			if (!fetcher)
				return usageUnavailable(
					provider,
					`${provider} is a ${profile.kind} endpoint, which publishes no quota API. Its limits are only visible where the key was issued.`,
				);
			let credential: Credential;
			try {
				credential = await credentials.resolve(provider, profile, merged);
			} catch (error) {
				merged.throwIfAborted();
				return usageUnavailable(
					provider,
					error instanceof Error ? error.message : `${provider} authentication is unavailable.`,
				);
			}
			return fetchProviderUsage(provider, profile, credential, fetcher, merged);
		},
		async authStatus() {
			return Promise.all(
				Object.entries(config.providers).map(async ([provider, profile]) => {
					try {
						const credential = await credentials.resolve(provider, profile, shutdown.signal);
						return { provider, available: true, source: credential.source };
					} catch (error) {
						shutdown.signal.throwIfAborted();
						return {
							provider,
							available: false,
							source: error instanceof Error ? error.message : "Authentication unavailable; run salam login.",
						};
					}
				}),
			);
		},
		async login(provider, callbacks) {
			shutdown.signal.throwIfAborted();
			await credentials.login(provider, callbacks, shutdown.signal);
		},
		close() {
			if (!closed) {
				shutdown.abort(new DOMException("Provider gateway closed.", "AbortError"));
				closed = (async () => {
					for (const state of sessions.values()) for (const value of state.values()) value.close();
					sessions.clear();
					await credentials.close();
				})();
			}
			return closed;
		},
	};
}
