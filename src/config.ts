import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	McpServerConfig,
	ModelChoice,
	ProviderProfile,
	RemoteTarget,
	SalamConfig,
} from "./contracts.ts";
import { REASONING_LEVELS } from "./contracts.ts";

const builtins: Record<string, ProviderProfile> = {
	anthropic: { kind: "anthropic" },
	"openai-codex": { kind: "openai-codex" },
	devin: { kind: "devin" },
};
const kinds: Record<string, true> = {
	anthropic: true,
	"openai-codex": true,
	devin: true,
	"custom-openai": true,
	"custom-anthropic": true,
};
export interface ConfigOptions {
	cwd?: string;
	home?: string;
	file?: string;
	model?: string;
}
function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value;
}
function strings(value: unknown, label: string): Record<string, string> {
	return Object.fromEntries(
		Object.entries(object(value, label)).map(([key, val]) => [key, text(val, `${label}.${key}`)]),
	);
}
function number(value: unknown, fallback: number, label: string, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
		throw new Error(`${label} must be an integer between ${min} and ${max}`);
	return value;
}
export function parseModel(value: string): ModelChoice {
	const slash = value.indexOf("/");
	if (slash < 1 || slash === value.length - 1)
		throw new Error("Model must be provider/model, e.g. anthropic/claude-fable-5-1");
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}
const MODEL_STATE = "model-state.json";
const MODEL_STATE_DIRECTORIES = 500;
interface ModelState {
	last?: string;
	directories: Record<string, { model: string; at: number }>;
}
async function readModelState(home: string): Promise<ModelState> {
	try {
		const data = object(await Bun.file(join(home, MODEL_STATE)).json(), MODEL_STATE);
		const directories: ModelState["directories"] = Object.create(null);
		if (data.directories && typeof data.directories === "object" && !Array.isArray(data.directories))
			for (const [path, raw] of Object.entries(data.directories as Record<string, unknown>)) {
				const entry = raw as { model?: unknown; at?: unknown };
				if (raw && typeof entry.model === "string")
					directories[path] = { model: entry.model, at: typeof entry.at === "number" ? entry.at : 0 };
			}
		return { ...(typeof data.last === "string" ? { last: data.last } : {}), directories };
	} catch {
		// Missing or unreadable state only means there is no remembered choice.
		return { directories: Object.create(null) };
	}
}
/** The model last chosen with /model in this directory, else anywhere; undefined when none is usable. */
export async function rememberedModel(
	home: string,
	cwd: string,
	providers: Record<string, ProviderProfile>,
): Promise<ModelChoice | undefined> {
	const state = await readModelState(home);
	for (const value of [state.directories[cwd]?.model, state.last]) {
		if (!value) continue;
		try {
			const choice = parseModel(value);
			if (providers[choice.provider]) return choice;
		} catch {
			// A malformed entry is skipped, never fatal.
		}
	}
	return undefined;
}
/** Records an explicit /model choice for this directory and as the global default for new sessions. */
export async function rememberModel(home: string, cwd: string, selection: ModelChoice): Promise<void> {
	const state = await readModelState(home);
	const model = `${selection.provider}/${selection.model}`;
	state.last = model;
	state.directories[cwd] = { model, at: Date.now() };
	const kept = Object.entries(state.directories)
		.sort((a, b) => b[1].at - a[1].at)
		.slice(0, MODEL_STATE_DIRECTORIES);
	const path = join(home, MODEL_STATE);
	const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await writeFile(
		temporary,
		`${JSON.stringify({ last: state.last, directories: Object.fromEntries(kept) }, null, 2)}\n`,
		{
			mode: 0o600,
		},
	);
	await rename(temporary, path);
}
export async function loadConfig(options: ConfigOptions = {}): Promise<SalamConfig> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const home = resolve(options.home ?? process.env.SALAM_HOME ?? join(homedir(), ".salam"));
	await mkdir(home, { recursive: true, mode: 0o700 });
	await chmod(home, 0o700);
	let data: Record<string, unknown> = {};
	let autoMemorySettingsPath = join(home, "config.json");
	const files = [
		...new Set([
			join(home, "config.json"),
			join(cwd, ".salam", "config.json"),
			...(options.file ? [resolve(options.file)] : []),
		]),
	];
	for (const path of files) {
		if (!(await Bun.file(path).exists())) {
			if (options.file && path === resolve(options.file))
				throw new Error(`Configuration file does not exist: ${path}`);
			continue;
		}
		let incoming: Record<string, unknown>;
		try {
			incoming = object(await Bun.file(path).json(), path);
		} catch (error) {
			throw new Error(
				`Cannot read configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		for (const key of Object.keys(incoming)) {
			if (
				![
					"model",
					"webSearchModel",
					"providers",
					"mcpServers",
					"remotes",
					"maxTurns",
					"autoTitle",
					"maxAgents",
					"maxOutputTokens",
					"contextThreshold",
					"reasoning",
					"autoMemoryEnabled",
					"autoMemoryDirectory",
				].includes(key)
			)
				throw new Error(`Unknown configuration key ${key} in ${path}`);
		}
		// A checked-in project config must not redirect memory writes elsewhere on this machine.
		if (
			incoming.autoMemoryDirectory !== undefined &&
			path === join(cwd, ".salam", "config.json") &&
			path !== join(home, "config.json") &&
			!(options.file && path === resolve(options.file))
		)
			throw new Error(
				`autoMemoryDirectory is only accepted from ${join(home, "config.json")} or an explicit --config file, not project configuration ${path}`,
			);
		if (incoming.autoMemoryEnabled !== undefined) autoMemorySettingsPath = path;
		const merged = { ...data, ...incoming };
		for (const key of ["providers", "mcpServers", "remotes"]) {
			if (incoming[key] !== undefined)
				merged[key] = {
					...(data[key] === undefined ? {} : object(data[key], key)),
					...object(incoming[key], `${path}: ${key}`),
				};
		}
		data = merged;
	}
	const providers: Record<string, ProviderProfile> = Object.assign(Object.create(null), builtins);
	for (const [name, raw] of Object.entries(
		data.providers === undefined ? {} : object(data.providers, "providers"),
	)) {
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid provider name: ${name}`);
		const profile = object(raw, `providers.${name}`);
		if (!Object.hasOwn(kinds, String(profile.kind))) throw new Error(`Invalid provider kind for ${name}`);
		const result: ProviderProfile = { kind: profile.kind as ProviderProfile["kind"] };
		if (profile.baseUrl !== undefined) {
			const value = text(profile.baseUrl, `${name}.baseUrl`);
			const url = new URL(value);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
				throw new Error(`${name}.baseUrl must be HTTP(S) without embedded credentials`);
			result.baseUrl = value;
		}
		if (profile.apiKeyEnv !== undefined) result.apiKeyEnv = text(profile.apiKeyEnv, `${name}.apiKeyEnv`);
		if (profile.headers !== undefined) result.headers = strings(profile.headers, `${name}.headers`);
		if (profile.models !== undefined) {
			if (!Array.isArray(profile.models)) throw new Error(`${name}.models must be an array`);
			result.models = profile.models.map((rawModel, index) => {
				const model = object(rawModel, `${name}.models[${index}]`);
				if (model.reasoning !== undefined && typeof model.reasoning !== "boolean")
					throw new Error(`${name}.models[${index}].reasoning must be boolean`);
				return {
					id: text(model.id, `${name}.models[${index}].id`),
					...(model.contextWindow === undefined
						? {}
						: { contextWindow: number(model.contextWindow, 128000, "contextWindow", 1024, 10000000) }),
					...(model.maxTokens === undefined
						? {}
						: { maxTokens: number(model.maxTokens, 16384, "maxTokens", 1, 1000000) }),
					reasoning: model.reasoning as boolean | undefined,
				};
			});
		}
		if (result.kind.startsWith("custom-") && (!result.baseUrl || !result.apiKeyEnv || !result.models?.length))
			throw new Error(`Custom provider ${name} requires baseUrl, apiKeyEnv and a non-empty models array`);
		providers[name] = result;
	}
	const mcpServers: Record<string, McpServerConfig> = Object.create(null);
	for (const [name, raw] of Object.entries(
		data.mcpServers === undefined ? {} : object(data.mcpServers, "mcpServers"),
	)) {
		const server = object(raw, `mcpServers.${name}`);
		if (!!server.command === !!server.url)
			throw new Error(`MCP server ${name} requires exactly one of command or url`);
		const result: McpServerConfig = {};
		if (server.command !== undefined) result.command = text(server.command, `${name}.command`);
		if (server.url !== undefined) {
			result.url = text(server.url, `${name}.url`);
			if (!["http:", "https:"].includes(new URL(result.url).protocol))
				throw new Error(`MCP server ${name} URL must use HTTP(S)`);
		}
		if (server.args !== undefined) {
			if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string"))
				throw new Error(`${name}.args must be a string array`);
			result.args = server.args as string[];
		}
		if (server.env !== undefined) result.env = strings(server.env, `${name}.env`);
		if (server.headers !== undefined) result.headers = strings(server.headers, `${name}.headers`);
		mcpServers[name] = result;
	}
	const remotes: Record<string, RemoteTarget> = Object.create(null);
	for (const [name, raw] of Object.entries(
		data.remotes === undefined ? {} : object(data.remotes, "remotes"),
	)) {
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid remote name: ${name}`);
		const remote = object(raw, `remotes.${name}`);
		const host = text(remote.host, `${name}.host`);
		if (host.startsWith("-") || /[\s\p{Cc}]/u.test(host)) throw new Error(`Invalid SSH host for ${name}`);
		const remoteCwd = text(remote.cwd, `${name}.cwd`);
		if (!remoteCwd.startsWith("/")) throw new Error(`${name}.cwd must be an absolute remote path`);
		remotes[name] = {
			host,
			cwd: remoteCwd,
			...(remote.port !== undefined ? { port: number(remote.port, 22, `${name}.port`, 1, 65535) } : {}),
			...(remote.identityFile !== undefined
				? { identityFile: resolve(text(remote.identityFile, `${name}.identityFile`)) }
				: {}),
			...(remote.knownHostsFile !== undefined
				? { knownHostsFile: resolve(text(remote.knownHostsFile, `${name}.knownHostsFile`)) }
				: {}),
		};
	}
	// Precedence: --model, SALAM_MODEL, the last /model choice (this directory, then any),
	// configuration "model", then the built-in default.
	const explicit = options.model ?? process.env.SALAM_MODEL;
	const remembered = explicit === undefined ? await rememberedModel(home, cwd, providers) : undefined;
	const selection =
		remembered ??
		parseModel(
			explicit ?? (data.model === undefined ? "anthropic/claude-fable-5-1" : text(data.model, "model")),
		);
	if (!providers[selection.provider]) throw new Error(`Provider ${selection.provider} is not configured`);
	const webSearchModel = parseModel(
		data.webSearchModel === undefined
			? "openai-codex/gpt-5.6-luna"
			: text(data.webSearchModel, "webSearchModel"),
	);
	if (!providers[webSearchModel.provider])
		throw new Error(`Web search provider ${webSearchModel.provider} is not configured`);
	const reasoning = REASONING_LEVELS.find((level) => level === (data.reasoning ?? "medium"));
	if (!reasoning) throw new Error(`reasoning must be ${REASONING_LEVELS.join(", ")}`);
	if (data.autoTitle !== undefined && typeof data.autoTitle !== "boolean")
		throw new Error("autoTitle must be boolean");
	if (data.autoMemoryEnabled !== undefined && typeof data.autoMemoryEnabled !== "boolean")
		throw new Error("autoMemoryEnabled must be boolean");
	let autoMemoryDirectory: string | undefined;
	if (data.autoMemoryDirectory !== undefined) {
		const raw = text(data.autoMemoryDirectory, "autoMemoryDirectory").trim();
		if (!raw.startsWith("/") && !raw.startsWith("~/"))
			throw new Error("autoMemoryDirectory must be an absolute path or start with ~/");
		autoMemoryDirectory = resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
		if (autoMemoryDirectory === "/" || autoMemoryDirectory === resolve(homedir()))
			throw new Error("autoMemoryDirectory must be a dedicated directory, not / or the home directory");
	}
	const autoMemoryDisabled = /^(1|true|yes)$/i.test(process.env.SALAM_DISABLE_AUTO_MEMORY ?? "");
	return {
		home,
		cwd,
		selection,
		webSearchModel,
		providers,
		mcpServers,
		remotes,
		maxTurns: number(data.maxTurns, 500, "maxTurns", 1, 100000),
		...(data.autoTitle === false ? { autoTitle: false } : {}),
		maxAgents: number(data.maxAgents, 4, "maxAgents", 1, 16),
		maxOutputTokens: number(data.maxOutputTokens, 16384, "maxOutputTokens", 128, 128000),
		...(data.contextThreshold === undefined
			? {}
			: { contextThreshold: number(data.contextThreshold, 120000, "contextThreshold", 4096, 10000000) }),
		reasoning,
		autoMemorySettingsPath,
		...(autoMemoryDisabled
			? { autoMemoryEnabled: false }
			: data.autoMemoryEnabled !== undefined
				? { autoMemoryEnabled: data.autoMemoryEnabled as boolean }
				: {}),
		...(autoMemoryDirectory ? { autoMemoryDirectory } : {}),
	};
}
