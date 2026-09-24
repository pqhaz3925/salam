import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { Arguments, Json, McpServerConfig, SalamConfig, ToolContext } from "../contracts.ts";
import { absolutizePlaywrightLinks, type McpBlock, type PlaywrightLinkScope } from "./content.ts";
import { childEnvironment, describeCommand, describeUrl, expandHeaders } from "./env.ts";

function envMillis(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CONNECT_TIMEOUT = envMillis("SALAM_MCP_CONNECT_TIMEOUT_MS", 30_000);
const LIST_TIMEOUT = envMillis("SALAM_MCP_LIST_TIMEOUT_MS", 20_000);
const CALL_TIMEOUT = envMillis("SALAM_MCP_CALL_TIMEOUT_MS", 120_000);
const CALL_TOTAL_TIMEOUT = envMillis("SALAM_MCP_CALL_TOTAL_TIMEOUT_MS", 900_000);
const CLOSE_TIMEOUT = 6_000;
const RETRY_COOLDOWN = 10_000;
const MAX_PAGES = 25;
const STDERR_LINES = 40;
const CLIENT_INFO = { name: "salam", version: "0.1.0", title: "Salam" };
const LOCAL_PLAYWRIGHT_COMMANDS: Record<string, true> = {
	node: true,
	nodejs: true,
	bun: true,
	npx: true,
	bunx: true,
	npm: true,
	pnpm: true,
	yarn: true,
	"playwright-mcp": true,
	playwright: true,
};
const PACKAGE_RUNNERS: Record<string, true> = { npx: true, bunx: true, npm: true, pnpm: true, yarn: true };

export type McpTransportKind = "stdio" | "http";
export type McpServerState = "connected" | "failed" | "disconnected" | "closed";
export type McpFailureKind =
	| "unknown-server"
	| "unknown-tool"
	| "disconnected"
	| "unsupported"
	| "timeout"
	| "aborted"
	| "protocol"
	| "shutdown";

export class McpFailure extends Error {
	readonly kind: McpFailureKind;
	readonly server: string;

	constructor(kind: McpFailureKind, server: string, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "McpFailure";
		this.kind = kind;
		this.server = server;
	}
}

export interface McpToolInfo {
	/** Configured server key. */
	server: string;
	/** Tool name exactly as the server reports it. */
	name: string;
	title?: string;
	/** Server-provided description, verbatim (may be empty). */
	description: string;
	/** Frozen JSON Schema for the tool arguments. */
	parameters: Record<string, unknown>;
	readOnly: boolean;
}

export interface McpServerStatus {
	name: string;
	kind: McpTransportKind;
	state: McpServerState;
	endpoint: string;
	error?: string;
	/** `name@version` reported by the server during initialize. */
	server?: string;
	/** Implementation name the server reported (e.g. "Playwright"). */
	implementation?: string;
	/** Working directory the stdio server process was spawned in. */
	cwd?: string;
	capabilities: string[];
	tools: string[];
	/** Configured environment variable names — values are never exposed. */
	env: string[];
	/** Header names for HTTP transports. */
	headers: string[];
	unresolved: string[];
	stderr: string[];
	attempts: number;
	connectedAt?: number;
}

export interface McpResourceEntry {
	server: string;
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
	template: boolean;
	meta?: Record<string, unknown>;
}

export interface McpPromptEntry {
	server: string;
	name: string;
	description?: string;
	arguments: { name: string; description?: string; required: boolean }[];
	meta?: Record<string, unknown>;
}

export interface McpCallResult {
	content: McpBlock[];
	isError: boolean;
	structured?: Json;
}

interface RemoteTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: { readOnlyHint?: boolean; title?: string };
}

interface Connection {
	name: string;
	kind: McpTransportKind;
	config: McpServerConfig;
	endpoint: string;
	client: Client | null;
	transport: Transport | null;
	state: McpServerState;
	error?: string;
	capabilities?: ServerCapabilities;
	serverLabel?: string;
	implementation?: string;
	/** Spawn cwd and environment of a stdio transport. */
	cwd?: string;
	launchEnv?: Readonly<Record<string, string>>;
	playwright?: { base: string; artifactRoots: string[] };
	instructions?: string;
	/** Raw discovery output; the catalogue is re-derived from it after every refresh. */
	remote: RemoteTool[];
	tools: McpToolInfo[];
	stderr: string[];
	envNames: string[];
	headerNames: string[];
	unresolved: string[];
	attempts: number;
	connectedAt?: number;
	connecting: Promise<void> | null;
	lastFailureAt: number;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
	return value;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/**
 * Owns every configured MCP connection: transports, lifecycle, discovery and
 * request dispatch. A server that fails to connect stays in the roster with its
 * failure recorded so it can be reported and retried instead of vanishing.
 */
export class McpHub {
	private readonly connections = new Map<string, Connection>();
	private shutdownPromise: Promise<void> | null = null;

	private constructor(private readonly config: SalamConfig) {}

	static async create(config: SalamConfig): Promise<McpHub> {
		const hub = new McpHub(config);
		const names = Object.keys(config.mcpServers ?? {}).sort();
		for (const name of names) {
			const serverConfig = config.mcpServers[name];
			if (!serverConfig) continue;
			hub.connections.set(name, {
				name,
				kind: serverConfig.url ? "http" : "stdio",
				config: serverConfig,
				endpoint: serverConfig.url
					? describeUrl(serverConfig.url)
					: describeCommand(serverConfig.command ?? "", serverConfig.args),
				client: null,
				transport: null,
				state: "disconnected",
				remote: [],
				tools: [],
				stderr: [],
				envNames: [],
				headerNames: [],
				unresolved: [],
				attempts: 0,
				connecting: null,
				lastFailureAt: 0,
			});
		}
		await Promise.all(
			names.map(async (name) => {
				const connection = hub.connections.get(name);
				if (!connection) return;
				// Failures are recorded on the connection; startup never rejects because of a bad server.
				await hub.connect(connection, true).catch(() => {});
			}),
		);
		hub.rebuildCatalogue();
		return hub;
	}

	servers(): McpServerStatus[] {
		return [...this.connections.values()].map((connection) => ({
			name: connection.name,
			kind: connection.kind,
			state: connection.state,
			endpoint: connection.endpoint,
			error: connection.error,
			server: connection.serverLabel,
			implementation: connection.implementation,
			cwd: connection.cwd,
			capabilities: Object.keys(connection.capabilities ?? {}).sort(),
			tools: connection.tools.map((tool) => tool.name),
			env: connection.envNames,
			headers: connection.headerNames,
			unresolved: connection.unresolved,
			stderr: connection.stderr.slice(-10),
			attempts: connection.attempts,
			connectedAt: connection.connectedAt,
		}));
	}

	/** Every discovered tool of every server, in configured server order. */
	tools(server?: string): McpToolInfo[] {
		const all: McpToolInfo[] = [];
		for (const connection of this.targets(server)) all.push(...connection.tools);
		return all;
	}

	/** Server-provided `instructions` from initialize, meant for the system prompt. */
	serverInstructions(): { server: string; text: string }[] {
		const out: { server: string; text: string }[] = [];
		for (const connection of this.connections.values()) {
			const text = connection.instructions?.trim();
			if (connection.state === "connected" && text)
				out.push({ server: connection.name, text: text.slice(0, 8_000) });
		}
		return out;
	}

	async reconnect(server?: string): Promise<McpServerStatus[]> {
		const targets = server ? [this.require(server)] : [...this.connections.values()];
		await Promise.all(
			targets.map(async (connection) => {
				await this.disconnect(connection, "disconnected");
				await this.connect(connection, true).catch(() => {});
			}),
		);
		this.rebuildCatalogue();
		const names = new Set(targets.map((connection) => connection.name));
		return this.servers().filter((status) => names.has(status.name));
	}

	async callTool(
		server: string,
		tool: string,
		args: Arguments,
		context: ToolContext,
	): Promise<McpCallResult> {
		const connection = this.require(server);
		const client = await this.ready(connection);
		if (!connection.capabilities?.tools) {
			throw new McpFailure("unsupported", server, `MCP server '${server}' does not expose tools.`);
		}
		const known = connection.tools.find((entry) => entry.name === tool);
		if (!known && connection.tools.length > 0) {
			throw new McpFailure(
				"unknown-tool",
				server,
				`MCP server '${server}' has no tool '${tool}'. Available: ${connection.tools.map((entry) => entry.name).join(", ")}`,
			);
		}
		// Only a locally launched, identified Playwright server owns these path conventions.
		// Its workspace is the spawn cwd, never the active agent's (possibly SSH) cwd.
		let linkScope: PlaywrightLinkScope | undefined;
		if (connection.playwright && tool.startsWith("browser_")) {
			const meta = args["_meta"];
			const requestedCwd = meta && typeof meta === "object" ? (meta as Arguments)["cwd"] : undefined;
			if (
				requestedCwd === undefined ||
				(typeof requestedCwd === "string" &&
					!(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(requestedCwd) || requestedCwd.startsWith("//")))
			) {
				linkScope = {
					base:
						typeof requestedCwd === "string"
							? resolve(connection.playwright.base, requestedCwd)
							: connection.playwright.base,
					artifactRoots: connection.playwright.artifactRoots,
					since: Date.now(),
				};
			}
		}
		const result = await this.request(connection, `tools/call ${tool}`, () =>
			client.callTool({ name: tool, arguments: args }, undefined, {
				signal: context.signal,
				timeout: CALL_TIMEOUT,
				resetTimeoutOnProgress: true,
				maxTotalTimeout: CALL_TOTAL_TIMEOUT,
				onprogress: (progress) => {
					const total = typeof progress.total === "number" ? `/${progress.total}` : "";
					const message =
						typeof progress.message === "string" && progress.message.length > 0 ? ` ${progress.message}` : "";
					context.emit(`${server}/${tool}: ${progress.progress}${total}${message}`);
				},
			}),
		);
		const content = Array.isArray(result["content"]) ? (result["content"] as McpBlock[]) : [];
		const structured = result["structuredContent"];
		if (!Array.isArray(result["content"]) && !("toolResult" in result) && structured === undefined) {
			throw new McpFailure(
				"protocol",
				server,
				`MCP server '${server}' returned a malformed result for tool '${tool}'.`,
			);
		}
		if ("toolResult" in result && !Array.isArray(result["content"])) {
			// 2024-style servers answer with a bare `toolResult` payload.
			return {
				content: [{ type: "text", text: JSON.stringify(result["toolResult"], null, 2) }],
				isError: result["isError"] === true,
				structured: (result["toolResult"] ?? null) as Json,
			};
		}
		return {
			content: linkScope ? absolutizePlaywrightLinks(content, linkScope).blocks : content,
			isError: result["isError"] === true,
			structured: structured === undefined ? undefined : (structured as Json),
		};
	}

	async listResources(
		server?: string,
	): Promise<{ entries: McpResourceEntry[]; failures: { server: string; error: string }[] }> {
		const entries: McpResourceEntry[] = [];
		const failures: { server: string; error: string }[] = [];
		for (const connection of this.targets(server)) {
			if (!connection.capabilities?.resources) continue;
			const client = connection.client;
			if (!client) {
				failures.push({ server: connection.name, error: connection.error ?? "not connected" });
				continue;
			}
			try {
				for (let page = 0, cursor: string | undefined; page < MAX_PAGES; page += 1) {
					const result = await client.listResources(cursor ? { cursor } : {}, { timeout: LIST_TIMEOUT });
					for (const resource of result.resources) {
						entries.push({
							server: connection.name,
							uri: resource.uri,
							name: resource.name,
							description: resource.description,
							mimeType: resource.mimeType,
							template: false,
							meta: resource._meta,
						});
					}
					cursor = result.nextCursor;
					if (!cursor) break;
				}
				for (let page = 0, cursor: string | undefined; page < MAX_PAGES; page += 1) {
					const result = await client.listResourceTemplates(cursor ? { cursor } : {}, {
						timeout: LIST_TIMEOUT,
					});
					for (const template of result.resourceTemplates) {
						entries.push({
							server: connection.name,
							uri: template.uriTemplate,
							name: template.name,
							description: template.description,
							mimeType: template.mimeType,
							template: true,
							meta: template._meta,
						});
					}
					cursor = result.nextCursor;
					if (!cursor) break;
				}
			} catch (error) {
				failures.push({ server: connection.name, error: describeError(error) });
			}
		}
		for (const connection of this.targets(server)) {
			if (
				connection.state !== "connected" &&
				!failures.some((failure) => failure.server === connection.name)
			) {
				failures.push({
					server: connection.name,
					error: connection.error ?? `not connected (${connection.state})`,
				});
			}
		}
		return { entries, failures };
	}

	async readResource(server: string, uri: string, signal: AbortSignal): Promise<McpBlock[]> {
		const connection = this.require(server);
		const client = await this.ready(connection);
		if (!connection.capabilities?.resources) {
			throw new McpFailure("unsupported", server, `MCP server '${server}' does not expose resources.`);
		}
		const result = await this.request(connection, `resources/read ${uri}`, () =>
			client.readResource({ uri }, { signal, timeout: LIST_TIMEOUT }),
		);
		return result.contents as McpBlock[];
	}

	async listPrompts(
		server?: string,
	): Promise<{ entries: McpPromptEntry[]; failures: { server: string; error: string }[] }> {
		const entries: McpPromptEntry[] = [];
		const failures: { server: string; error: string }[] = [];
		for (const connection of this.targets(server)) {
			if (!connection.capabilities?.prompts) continue;
			const client = connection.client;
			if (!client) {
				failures.push({ server: connection.name, error: connection.error ?? "not connected" });
				continue;
			}
			try {
				for (let page = 0, cursor: string | undefined; page < MAX_PAGES; page += 1) {
					const result = await client.listPrompts(cursor ? { cursor } : {}, { timeout: LIST_TIMEOUT });
					for (const prompt of result.prompts) {
						entries.push({
							server: connection.name,
							name: prompt.name,
							description: prompt.description,
							arguments: (prompt.arguments ?? []).map((argument) => ({
								name: argument.name,
								description: argument.description,
								required: argument.required === true,
							})),
							meta: prompt._meta,
						});
					}
					cursor = result.nextCursor;
					if (!cursor) break;
				}
			} catch (error) {
				failures.push({ server: connection.name, error: describeError(error) });
			}
		}
		return { entries, failures };
	}

	async getPrompt(
		server: string,
		name: string,
		args: Record<string, string>,
		signal: AbortSignal,
	): Promise<{ description?: string; messages: { role: string; content: McpBlock }[] }> {
		const connection = this.require(server);
		const client = await this.ready(connection);
		if (!connection.capabilities?.prompts) {
			throw new McpFailure("unsupported", server, `MCP server '${server}' does not expose prompts.`);
		}
		const result = await this.request(connection, `prompts/get ${name}`, () =>
			client.getPrompt({ name, arguments: args }, { signal, timeout: LIST_TIMEOUT }),
		);
		return {
			description: result.description,
			messages: result.messages.map((message) => ({
				role: message.role,
				content: message.content as McpBlock,
			})),
		};
	}

	async close(): Promise<void> {
		if (!this.shutdownPromise) {
			this.shutdownPromise = (async () => {
				await Promise.all(
					[...this.connections.values()].map((connection) => this.disconnect(connection, "closed")),
				);
			})();
		}
		return this.shutdownPromise;
	}

	private targets(server?: string): Connection[] {
		if (server === undefined) return [...this.connections.values()];
		return [this.require(server)];
	}

	private require(server: string): Connection {
		const connection = this.connections.get(server);
		if (!connection) {
			const known = [...this.connections.keys()].join(", ") || "none configured";
			throw new McpFailure(
				"unknown-server",
				server,
				`Unknown MCP server '${server}'. Configured servers: ${known}`,
			);
		}
		return connection;
	}

	/** Returns a live client, retrying a previously failed connection when the cooldown allows. */
	private async ready(connection: Connection): Promise<Client> {
		if (this.shutdownPromise) {
			throw new McpFailure(
				"shutdown",
				connection.name,
				"Integrations are shutting down; MCP requests are no longer accepted.",
			);
		}
		if (connection.state !== "connected" || !connection.client) {
			await this.connect(connection, false);
			this.rebuildCatalogue();
		}
		const client = connection.client;
		if (!client || connection.state !== "connected") {
			throw new McpFailure(
				"disconnected",
				connection.name,
				`MCP server '${connection.name}' is not connected: ${connection.error ?? "unknown error"}. Use mcp_call with action "reconnect" to retry.`,
			);
		}
		return client;
	}

	private async request<T>(connection: Connection, label: string, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			const message = describeError(error);
			if (/aborted|AbortError/i.test(message) || (error instanceof Error && error.name === "AbortError")) {
				throw new McpFailure("aborted", connection.name, `${connection.name}: ${label} was cancelled.`, {
					cause: error,
				});
			}
			if (/timed? ?out|Request timeout/i.test(message)) {
				throw new McpFailure(
					"timeout",
					connection.name,
					`${connection.name}: ${label} timed out (${message}).`,
					{ cause: error },
				);
			}
			if (connection.state !== "connected") {
				throw new McpFailure(
					"disconnected",
					connection.name,
					`${connection.name}: ${label} failed — ${message}`,
					{ cause: error },
				);
			}
			throw new McpFailure("protocol", connection.name, `${connection.name}: ${label} failed — ${message}`, {
				cause: error,
			});
		}
	}

	private async connect(connection: Connection, force: boolean): Promise<void> {
		if (this.shutdownPromise) {
			throw new McpFailure("shutdown", connection.name, "Integrations are shutting down.");
		}
		if (connection.state === "connected" && connection.client) return;
		if (connection.connecting) return connection.connecting;
		if (!force && connection.lastFailureAt > 0 && Date.now() - connection.lastFailureAt < RETRY_COOLDOWN) {
			throw new McpFailure(
				"disconnected",
				connection.name,
				`MCP server '${connection.name}' is not connected: ${connection.error ?? "unknown error"} (retry cooling down).`,
			);
		}
		const attempt = this.establish(connection);
		connection.connecting = attempt;
		try {
			await attempt;
		} finally {
			connection.connecting = null;
		}
	}

	private async establish(connection: Connection): Promise<void> {
		connection.attempts += 1;
		const config = connection.config;
		let transport: Transport;
		try {
			transport = this.createTransport(connection, config);
		} catch (error) {
			connection.state = "failed";
			connection.error = describeError(error);
			connection.lastFailureAt = Date.now();
			throw error instanceof McpFailure
				? error
				: new McpFailure("protocol", connection.name, connection.error, { cause: error });
		}

		const client = new Client(CLIENT_INFO, {
			capabilities: {},
			listChanged: {
				tools: {
					autoRefresh: true,
					debounceMs: 300,
					onChanged: (error, tools) => {
						if (error) {
							connection.error = `tools/list_changed refresh failed: ${describeError(error)}`;
							return;
						}
						if (!tools) return;
						connection.remote = tools as RemoteTool[];
						this.rebuildCatalogue();
					},
				},
			},
		});
		client.onerror = (error) => {
			connection.error = describeError(error);
		};
		client.onclose = () => {
			connection.client = null;
			connection.transport = null;
			if (connection.state === "connected") {
				connection.state = "disconnected";
				connection.error = connection.error ?? "transport closed by the server";
				connection.lastFailureAt = Date.now();
			}
		};

		try {
			await client.connect(transport, { timeout: CONNECT_TIMEOUT });
		} catch (error) {
			await client.close().catch(() => {});
			await transport.close().catch(() => {});
			connection.client = null;
			connection.transport = null;
			connection.state = "failed";
			connection.error = describeError(error);
			connection.lastFailureAt = Date.now();
			throw new McpFailure(
				"disconnected",
				connection.name,
				`Failed to connect to MCP server '${connection.name}': ${connection.error}`,
				{
					cause: error,
				},
			);
		}

		connection.client = client;
		connection.transport = transport;
		connection.capabilities = client.getServerCapabilities();
		const info = client.getServerVersion();
		connection.serverLabel = info ? `${info.name}@${info.version}` : undefined;
		connection.implementation = info?.name;
		connection.playwright = undefined;
		const command = basename(config.command ?? "")
			.replace(/\.(cmd|exe)$/i, "")
			.toLowerCase();
		const argv = config.args ?? [];
		const packageRunner = PACKAGE_RUNNERS[command] === true || (command === "bun" && argv[0] === "x");
		const playwrightPackage =
			argv.some((arg) => /^@playwright\/mcp(?:@|$)/.test(arg)) ||
			argv.includes("playwright-mcp") ||
			argv.includes("run-mcp-server");
		if (
			connection.kind === "stdio" &&
			connection.cwd &&
			connection.implementation === "Playwright" &&
			LOCAL_PLAYWRIGHT_COMMANDS[command] === true &&
			(!packageRunner || playwrightPackage)
		) {
			let outputDir = connection.launchEnv?.["PLAYWRIGHT_MCP_OUTPUT_DIR"];
			for (let index = 0; index < argv.length; index += 1) {
				const arg = argv[index]!;
				if (arg === "--output-dir") outputDir = argv[index + 1];
				else if (arg.startsWith("--output-dir=")) outputDir = arg.slice("--output-dir=".length);
			}
			const base = connection.cwd;
			const artifactRoots = outputDir
				? [resolve(base, outputDir)]
				: [
						resolve(base, ".playwright-mcp"),
						resolve(connection.launchEnv?.["TMPDIR"] ?? tmpdir(), ".playwright-mcp"),
					];
			connection.playwright = { base, artifactRoots };
		}
		connection.instructions = client.getInstructions();
		connection.state = "connected";
		connection.error = undefined;
		connection.connectedAt = Date.now();
		connection.lastFailureAt = 0;

		if (connection.capabilities?.tools) {
			try {
				const discovered: RemoteTool[] = [];
				for (let page = 0, cursor: string | undefined; page < MAX_PAGES; page += 1) {
					const result = await client.listTools(cursor ? { cursor } : {}, { timeout: LIST_TIMEOUT });
					discovered.push(...(result.tools as RemoteTool[]));
					cursor = result.nextCursor;
					if (!cursor) break;
				}
				connection.remote = discovered;
			} catch (error) {
				connection.remote = [];
				connection.error = `tool discovery failed: ${describeError(error)}`;
			}
		} else {
			connection.remote = [];
		}
		// The caller rebuilds the catalogue once concurrent connection attempts settle.
	}

	private createTransport(connection: Connection, config: McpServerConfig): Transport {
		if (config.url) {
			let url: URL;
			try {
				url = new URL(config.url);
			} catch {
				throw new McpFailure(
					"protocol",
					connection.name,
					`MCP server '${connection.name}' has an invalid url.`,
				);
			}
			const headers = expandHeaders(config.headers);
			connection.headerNames = headers.names;
			connection.unresolved = headers.missing;
			connection.envNames = [];
			connection.cwd = undefined;
			connection.launchEnv = undefined;
			return new StreamableHTTPClientTransport(url, {
				requestInit: headers.names.length > 0 ? { headers: headers.headers } : undefined,
			});
		}
		if (!config.command) {
			throw new McpFailure(
				"protocol",
				connection.name,
				`MCP server '${connection.name}' defines neither 'command' nor 'url'.`,
			);
		}
		const environment = childEnvironment(config.env);
		connection.envNames = environment.configured;
		connection.unresolved = environment.missing;
		connection.headerNames = [];
		const cwd = realpathSync(resolve(this.config.cwd));
		connection.cwd = cwd;
		connection.launchEnv = environment.env;
		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			env: environment.env,
			cwd,
			stderr: "pipe",
		});
		const stderr = transport.stderr;
		if (stderr) {
			stderr.on("data", (chunk: Buffer | string) => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				for (const line of text.split(/\r?\n/)) {
					const trimmed = line.trimEnd();
					if (trimmed.length === 0) continue;
					connection.stderr.push(trimmed.slice(0, 500));
				}
				if (connection.stderr.length > STDERR_LINES)
					connection.stderr.splice(0, connection.stderr.length - STDERR_LINES);
			});
			stderr.on("error", () => {});
		}
		return transport;
	}

	/** Re-derives every server's tool list from its latest discovery output. */
	private rebuildCatalogue(): void {
		for (const connection of this.connections.values()) {
			connection.tools = this.catalogue(connection.name, connection.remote);
		}
	}

	/** Normalises discovery output once, freezing every schema so it can be shared without copies. */
	private catalogue(server: string, tools: readonly RemoteTool[]): McpToolInfo[] {
		const out: McpToolInfo[] = [];
		const seen = new Set<string>();
		for (const tool of tools) {
			if (!tool || typeof tool.name !== "string" || tool.name.length === 0 || seen.has(tool.name)) continue;
			seen.add(tool.name);
			const schema =
				tool.inputSchema && typeof tool.inputSchema === "object"
					? ({ ...tool.inputSchema } as Record<string, unknown>)
					: {};
			if (schema["type"] !== "object") schema["type"] = "object";
			if (!schema["properties"] || typeof schema["properties"] !== "object") schema["properties"] = {};
			out.push({
				server,
				name: tool.name,
				title: tool.title ?? tool.annotations?.title,
				description: tool.description ?? "",
				parameters: deepFreeze(schema),
				readOnly: tool.annotations?.readOnlyHint === true,
			});
		}
		return out;
	}

	private async disconnect(connection: Connection, state: McpServerState): Promise<void> {
		const client = connection.client;
		const transport = connection.transport;
		connection.client = null;
		connection.transport = null;
		connection.state = state;
		if (state === "closed") connection.error = undefined;
		if (!client && !transport) return;
		const abandon = new AbortController();
		const shut = (async () => {
			await client?.close().catch(() => {});
			await transport?.close().catch(() => {});
			return "done" as const;
		})();
		const outcome = await Promise.race([
			shut,
			delay(CLOSE_TIMEOUT, "timeout" as const, { ref: false, signal: abandon.signal }).catch(
				() => "done" as const,
			),
		]);
		abandon.abort();
		if (outcome === "timeout" && transport instanceof StdioClientTransport) {
			// A wedged child ignores stdin close and SIGTERM; never let shutdown hang on it.
			const pid = transport.pid;
			if (pid !== null) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
		}
	}
}
