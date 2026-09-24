import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials, OAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { getOAuthApiKey, refreshOAuthToken } from "@oh-my-pi/pi-ai/oauth";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { ProviderProfile, SalamConfig } from "../contracts";

type StoredCredential =
	| { kind: string; oauth: OAuthCredentials }
	| { kind: string; apiKey: string; baseUrl?: string };
type CredentialFile = { version: 1; providers: Record<string, StoredCredential> };
export interface Credential {
	apiKey: string;
	source: string;
	baseUrl?: string;
	accountId?: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validOAuth(value: unknown): value is OAuthCredentials {
	return (
		record(value) &&
		typeof value.access === "string" &&
		value.access.length > 0 &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}
function endpoint(value: string): string {
	const url = new URL(value.includes("://") ? value : `https://${value}`);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("Invalid provider endpoint. Use an HTTP(S) URL without credentials.");
	return url.toString().replace(/\/+$/, "");
}

/** Capture credential commands privately: neither output nor errors may contain tokens in logs. */
async function capture(argv: string[], signal?: AbortSignal): Promise<string | undefined> {
	signal?.throwIfAborted();
	let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	} catch {
		return undefined;
	}
	const kill = () => {
		try {
			child.kill();
		} catch {}
	};
	const timeout = setTimeout(kill, 20_000);
	signal?.addEventListener("abort", kill, { once: true });
	try {
		const [code, stdout] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).arrayBuffer(),
		]);
		signal?.throwIfAborted();
		return code === 0 ? stdout.trim() : undefined;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", kill);
	}
}

export class Credentials {
	readonly #path: string;
	readonly #config: SalamConfig;
	#refreshes = new Map<string, Promise<Credential>>();
	#writes: Promise<void> = Promise.resolve();
	#external = new Map<string, { credential: Credential; expiresAt: number }>();
	constructor(config: SalamConfig) {
		this.#config = config;
		this.#path = join(config.home, "credentials.json");
	}

	async #load(): Promise<CredentialFile> {
		let text: string;
		try {
			text = await readFile(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, providers: {} };
			throw new Error(`Cannot read salam credentials at ${this.#path}. Check file permissions.`);
		}
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`Invalid salam credential file at ${this.#path}. Restore it or run salam login.`);
		}
		if (!record(data) || data.version !== 1 || !record(data.providers))
			throw new Error(`Unsupported salam credential format at ${this.#path}.`);
		for (const value of Object.values(data.providers)) {
			if (
				!record(value) ||
				typeof value.kind !== "string" ||
				!((typeof value.apiKey === "string" && value.apiKey.length > 0) || validOAuth(value.oauth))
			) {
				throw new Error(`Invalid credential entry in ${this.#path}. Run salam login to replace it.`);
			}
		}
		await chmod(this.#path, 0o600);
		return data as unknown as CredentialFile;
	}

	async #store(provider: string, credential: StoredCredential): Promise<void> {
		const operation = this.#writes.then(async () => {
			const data = await this.#load();
			data.providers[provider] = credential;
			await mkdir(this.#config.home, { recursive: true, mode: 0o700 });
			const temp = `${this.#path}.${crypto.randomUUID()}.tmp`;
			try {
				await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
				await rename(temp, this.#path);
			} finally {
				await rm(temp, { force: true });
			}
		});
		this.#writes = operation.catch(() => {});
		return operation;
	}

	async resolve(provider: string, profile: ProviderProfile, signal?: AbortSignal): Promise<Credential> {
		signal?.throwIfAborted();
		if (profile.kind.startsWith("custom-")) {
			if (!profile.apiKeyEnv)
				throw new Error(
					`Provider ${provider} needs apiKeyEnv in its profile. Set that environment variable to the endpoint's API key.`,
				);
			const apiKey = process.env[profile.apiKeyEnv];
			if (!apiKey)
				throw new Error(`Provider ${provider} is unavailable: set ${profile.apiKeyEnv} to its API key.`);
			return { apiKey, source: `environment:${profile.apiKeyEnv}` };
		}
		const owned = (await this.#load()).providers;
		const stored = Object.hasOwn(owned, provider) ? owned[provider] : undefined;
		if (stored) {
			if (stored.kind !== profile.kind)
				throw new Error(
					`Stored credentials for ${provider} belong to ${stored.kind}, not ${profile.kind}. Run salam login ${provider}.`,
				);
			if ("apiKey" in stored)
				return { apiKey: stored.apiKey, baseUrl: stored.baseUrl, source: "salam credentials" };
			if (stored.oauth.expires > Date.now() + 60_000) return this.#oauthKey(profile.kind, stored.oauth);
			let pending = this.#refreshes.get(provider);
			if (!pending) {
				pending = (async () => {
					let fresh: OAuthCredentials;
					try {
						fresh = await refreshOAuthToken(profile.kind as OAuthProvider, stored.oauth, signal);
					} catch {
						signal?.throwIfAborted();
						throw new Error(
							`The salam-owned ${provider} login expired and could not refresh. Run salam login ${provider}.`,
						);
					}
					await this.#store(provider, { kind: profile.kind, oauth: fresh });
					return this.#oauthKey(profile.kind, fresh);
				})();
				this.#refreshes.set(provider, pending);
				void pending.finally(() => this.#refreshes.delete(provider)).catch(() => {});
			}
			return pending;
		}
		const cached = this.#external.get(provider);
		if (cached && cached.expiresAt > Date.now()) return cached.credential;
		if (profile.kind === "openai-codex") {
			const token = await capture(["omp", "token", "openai-codex", "--account", "1"], signal);
			if (token && !/\s/.test(token)) {
				const credential = { apiKey: token, source: "OMP token broker, account 1" };
				let expiresAt = Date.now() + 45_000;
				try {
					const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
					if (typeof claims.exp === "number") expiresAt = Math.min(expiresAt, claims.exp * 1000 - 30_000);
				} catch {
					/* Non-JWT broker tokens use the short import cache lifetime. */
				}
				this.#external.set(provider, { credential, expiresAt });
				return credential;
			}
			throw new Error(
				`Codex authentication unavailable. Run salam login ${provider}, or configure an active OMP openai-codex account 1 with a working token broker.`,
			);
		}
		if (profile.kind === "anthropic") {
			if (process.platform === "darwin") {
				const raw = await capture(
					["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
					signal,
				);
				if (raw) {
					try {
						const data = JSON.parse(raw);
						const grant = data.claudeAiOauth;
						if (
							record(grant) &&
							typeof grant.accessToken === "string" &&
							typeof grant.expiresAt === "number" &&
							grant.expiresAt > Date.now() + 30_000
						) {
							const credential = {
								apiKey: grant.accessToken,
								source: "Claude Code macOS Keychain (read-only)",
							};
							this.#external.set(provider, {
								credential,
								expiresAt: Math.min(Date.now() + 45_000, grant.expiresAt - 30_000),
							});
							return credential;
						}
					} catch {}
				}
			}
			throw new Error(
				`Claude subscription authentication unavailable or expired. Run salam login ${provider}, or refresh your Claude Code login. Disabled OMP Anthropic credentials are deliberately not used.`,
			);
		}
		const path = join(homedir(), ".local", "share", "devin", "credentials.toml");
		try {
			const data = Bun.TOML.parse(await readFile(path, "utf8")) as Record<string, unknown>;
			if (
				typeof data.windsurf_api_key === "string" &&
				data.windsurf_api_key.length > 0 &&
				typeof data.api_server_url === "string" &&
				data.api_server_url.length > 0
			) {
				const credential = {
					apiKey: data.windsurf_api_key,
					baseUrl: endpoint(data.api_server_url),
					source: "official Devin credentials.toml (read-only)",
				};
				this.#external.set(provider, { credential, expiresAt: Date.now() + 45_000 });
				return credential;
			}
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof Error && error.message.startsWith("Invalid provider endpoint")) throw error;
		}
		throw new Error(
			`Devin inference authentication unavailable. Sign in with the official Devin CLI (credentials.toml needs windsurf_api_key and api_server_url), or run salam login ${provider}. Public Devin agent-session API keys are not inference credentials.`,
		);
	}

	async #oauthKey(kind: string, oauth: OAuthCredentials): Promise<Credential> {
		const result = await getOAuthApiKey(kind as OAuthProvider, { [kind]: oauth });
		if (!result) throw new Error(`Missing ${kind} OAuth credential. Run salam login ${kind}.`);
		// Devin's OAuth apiEndpoint is its token-mint host, not the Cascade inference endpoint.
		return {
			apiKey: result.apiKey,
			source: "salam credentials",
			accountId: oauth.accountId,
			baseUrl: kind === "devin" ? undefined : oauth.apiEndpoint,
		};
	}

	async login(
		provider: string,
		callbacks: { url: (url: string) => void; prompt: (message: string) => Promise<string> },
		signal: AbortSignal,
	): Promise<void> {
		const profile = this.#config.providers[provider];
		if (!profile) throw new Error(`Unknown provider profile: ${provider}`);
		if (profile.kind.startsWith("custom-"))
			throw new Error(
				`Custom provider ${provider} uses ${profile.apiKeyEnv ?? "apiKeyEnv"}; set the environment variable instead of OAuth login.`,
			);
		const definition = getProviderDefinition(profile.kind);
		if (!definition?.login)
			throw new Error(
				`No interactive login flow is available for ${profile.kind}. Use its official client authentication.`,
			);
		let result: OAuthCredentials | string;
		try {
			result = await definition.login({
				signal,
				onAuth: (info) => callbacks.url(info.launchUrl ?? info.url),
				onPrompt: (prompt) => callbacks.prompt(prompt.message),
				onManualCodeInput: () => callbacks.prompt("Paste the OAuth authorization code or redirect URL:"),
			});
		} catch {
			signal.throwIfAborted();
			throw new Error(
				`Login failed for ${provider}. Retry salam login ${provider}. Existing credentials were not changed.`,
			);
		}
		if (typeof result === "string") {
			if (!result) throw new Error("Login returned an empty credential.");
			await this.#store(provider, { kind: profile.kind, apiKey: result });
		} else {
			if (!validOAuth(result)) throw new Error("Login returned an invalid credential.");
			await this.#store(provider, {
				kind: profile.kind,
				oauth: { ...result, authorizedAt: result.authorizedAt ?? Date.now() },
			});
		}
		this.#external.delete(provider);
	}
	async close(): Promise<void> {
		await Promise.allSettled(this.#refreshes.values());
		await this.#writes;
		this.#external.clear();
	}
}
