import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCodexModels } from "@oh-my-pi/pi-catalog/discovery/codex";
import { fetchDevinModels } from "@oh-my-pi/pi-catalog/discovery/devin";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelChoice, ProviderProfile, SalamConfig } from "../contracts";
import type { Credential } from "./auth";
import { expandHeaders } from "../integrations/env";

export function profileFor(config: SalamConfig, name: string): ProviderProfile {
	const profile = config.providers[name];
	if (!profile)
		throw new Error(
			`Unknown provider profile ${name}. Configure it in salam config before selecting a model.`,
		);
	return profile;
}

export function dynamicAnthropic(profile: ProviderProfile, model: string): boolean {
	// Opus 5 accepted basic inference but refused the dynamic-control live probes.
	return profile.kind === "anthropic" && model === "claude-fable-5-1";
}

export class Models {
	readonly #config: SalamConfig;
	#discovered = new Map<string, Model<Api>[]>();
	#discoveries = new Map<string, Promise<Model<Api>[]>>();
	constructor(config: SalamConfig) {
		this.#config = config;
	}

	bundled(provider: string): Model<Api>[] {
		const profile = profileFor(this.#config, provider);
		if (profile.kind === "custom-openai" || profile.kind === "custom-anthropic") {
			if (!profile.baseUrl) throw new Error(`Custom provider ${provider} needs baseUrl in salam config.`);
			const url = new URL(profile.baseUrl);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
				throw new Error(`Invalid baseUrl for ${provider}: use HTTP(S) without embedded credentials.`);
			return (profile.models ?? []).map((spec) =>
				buildModel({
					id: spec.id,
					name: spec.id,
					provider: `salam-custom-${provider}`,
					api: profile.kind === "custom-openai" ? "openai-completions" : "anthropic-messages",
					baseUrl: profile.baseUrl!,
					reasoning: spec.reasoning ?? false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: spec.contextWindow ?? 128_000,
					maxTokens: spec.maxTokens ?? 16_384,
				}),
			);
		}
		const models = this.#discovered.get(provider) ?? getBundledModels(profile.kind);
		const available = models.filter((model) => !model.kind || model.kind === "chat");
		const selected = profile.models
			? profile.models.map((spec) => {
					const known = available.find((model) => model.id === spec.id);
					if (known) {
						const reasoning = spec.reasoning ?? known.reasoning;
						return {
							...known,
							contextWindow: spec.contextWindow ?? known.contextWindow,
							maxTokens: spec.maxTokens ?? known.maxTokens,
							reasoning,
							thinking: reasoning ? known.thinking : undefined,
						};
					}
					const transport =
						available[0] ??
						getBundledModels(profile.kind).find((model) => !model.kind || model.kind === "chat");
					if (!transport)
						throw new Error(`No request transport is available for configured provider ${provider}.`);
					const configured = buildModel({
						id: spec.id,
						name: `${spec.id} (configured)`,
						provider: transport.provider,
						api: transport.api,
						baseUrl: profile.baseUrl ?? transport.baseUrl,
						reasoning: spec.reasoning ?? false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: spec.contextWindow ?? null,
						maxTokens: spec.maxTokens ?? null,
					});
					return {
						...configured,
						contextWindow: spec.contextWindow ?? null,
						maxTokens: spec.maxTokens ?? null,
						reasoning: spec.reasoning ?? false,
						thinking: spec.reasoning ? configured.thinking : undefined,
						// Configuration authorizes routing, not invented catalogue pricing or limits.
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					};
				})
			: available;
		return selected.map((model) => {
			let resolved = profile.baseUrl ? { ...model, baseUrl: profile.baseUrl } : model;
			if (model.api === "anthropic-messages") {
				const anthropic = resolved as Model<"anthropic-messages">;
				const dynamic = dynamicAnthropic(profile, model.id);
				resolved = {
					...anthropic,
					compat: {
						...anthropic.compat,
						supportsMidConversationSystem: dynamic,
						supportsMidConversationToolChanges: dynamic,
						supportsTurnScopedSystem: false,
						supportsPerMessageEffort: false,
					},
				};
			} else if (model.api === "openai-codex-responses") {
				const codex = resolved as Model<"openai-codex-responses">;
				resolved = {
					...codex,
					preferWebsockets: false,
					useResponsesLite: false,
					compat: { ...codex.compat, supportsConfigurationUpdate: false },
				};
			}
			return resolved;
		});
	}

	async discoverDevin(provider: string, credential: Credential, signal?: AbortSignal): Promise<Model<Api>[]> {
		const cached = this.#discovered.get(provider);
		if (cached) return cached;
		let operation = this.#discoveries.get(provider);
		if (!operation) {
			const profile = profileFor(this.#config, provider);
			operation = (async () => {
				const specs = await fetchDevinModels({
					apiKey: credential.apiKey,
					baseUrl: profile.baseUrl ?? credential.baseUrl,
					signal,
					timeoutMs: 15_000,
				});
				signal?.throwIfAborted();
				if (!specs?.length)
					throw new Error(
						"Devin model discovery failed. Check your official CLI login and api_server_url; this route uses Codeium Cascade inference, not the public Devin sessions API.",
					);
				const models = specs.map((spec) => buildModel(spec));
				this.#discovered.set(provider, models);
				return models;
			})();
			this.#discoveries.set(provider, operation);
			void operation.finally(() => this.#discoveries.delete(provider)).catch(() => {});
		}
		return operation;
	}

	/**
	 * The account's live Codex entitlement, union'd over the bundled catalog: a newly
	 * released SKU appears without a catalog bump, while every bundled id keeps its
	 * official pricing, thinking metadata and compatibility flags.
	 */
	async discoverCodex(provider: string, credential: Credential, signal?: AbortSignal): Promise<Model<Api>[]> {
		const cached = this.#discovered.get(provider);
		if (cached) return cached;
		let operation = this.#discoveries.get(provider);
		if (!operation) {
			const profile = profileFor(this.#config, provider);
			operation = (async () => {
				const result = await fetchCodexModels({
					accessToken: credential.apiKey,
					...(credential.accountId ? { accountId: credential.accountId } : {}),
					...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
					signal,
				});
				signal?.throwIfAborted();
				if (!result || result.rejectedStatus)
					throw new Error(
						`Codex model discovery failed${result?.rejectedStatus ? ` with status ${result.rejectedStatus}` : ""}. Run salam login ${provider} to refresh the account entitlement; the bundled catalog still lists the known models.`,
					);
				const catalog = getBundledModels(profile.kind);
				const known = new Set(catalog.map((model) => model.id));
				const models = [
					...catalog,
					...result.models.filter((spec) => !known.has(spec.id)).map((spec) => buildModel(spec)),
				];
				this.#discovered.set(provider, models);
				return models;
			})();
			this.#discoveries.set(provider, operation);
			void operation.finally(() => this.#discoveries.delete(provider)).catch(() => {});
		}
		return operation;
	}

	async resolve(selection: ModelChoice, credential: Credential, signal?: AbortSignal): Promise<Model<Api>> {
		const profile = profileFor(this.#config, selection.provider);
		if (profile.kind === "devin") await this.discoverDevin(selection.provider, credential, signal);
		else if (profile.kind === "openai-codex") {
			try {
				await this.discoverCodex(selection.provider, credential, signal);
			} catch {
				// The bundled Codex catalog still resolves every known SKU without the network.
				signal?.throwIfAborted();
			}
		}
		const model = this.bundled(selection.provider).find((candidate) => candidate.id === selection.model);
		if (!model)
			throw new Error(
				`Model ${selection.model} is not in ${selection.provider}'s configured catalog. Use /models and select an available model; salam will not silently switch providers.`,
			);
		let resolved =
			profile.kind === "devin" && credential.baseUrl && !profile.baseUrl
				? { ...model, baseUrl: credential.baseUrl }
				: model;
		if (profile.headers) {
			const expanded = expandHeaders(profile.headers);
			if (expanded.missing.length)
				throw new Error(
					`Missing environment variables for ${selection.provider} headers: ${expanded.missing.join(", ")}`,
				);
			resolved = { ...resolved, headers: { ...resolved.headers, ...expanded.headers } };
		}
		return resolved;
	}
}
