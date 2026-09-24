import type { Arguments, HarnessTool, Json, ToolContext, ToolOutput } from "../contracts.ts";
import { type ConvertedContent, convertMcpContent, convertResourceContents } from "./content.ts";
import type { McpCallResult, McpHub, McpServerStatus } from "./mcp.ts";
import { McpFailure } from "./mcp.ts";

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
	return Object.freeze({
		type: "object",
		properties: Object.freeze(properties),
		required: Object.freeze(required),
		additionalProperties: false,
	}) as Record<string, unknown>;
}

function failureOutput(error: unknown, label: string): ToolOutput {
	if (error instanceof McpFailure) {
		return {
			text: `MCP ${label} failed [${error.kind}]: ${error.message}`,
			isError: true,
			details: { server: error.server, kind: error.kind },
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return { text: `MCP ${label} failed: ${message}`, isError: true };
}

/** Turns an MCP tool result into harness output, preserving images and never inventing success. */
function callOutput(result: McpCallResult, server: string, tool: string): ToolOutput {
	const converted = convertMcpContent(result.content);
	const pieces: string[] = [];
	if (converted.text.length > 0) pieces.push(converted.text);
	if (result.structured !== undefined)
		pieces.push(`structuredContent:\n${JSON.stringify(result.structured, null, 2)}`);
	if (pieces.length === 0) {
		pieces.push(
			result.isError
				? `MCP tool '${tool}' on '${server}' reported an error with no content.`
				: `MCP tool '${tool}' returned no content.`,
		);
	}
	if (converted.notes.length > 0) pieces.push(`[${converted.notes.join("; ")}]`);
	const details: Json = {
		server,
		tool,
		images: converted.images,
		blocks: result.content.length,
		notes: converted.notes,
		...(result.structured === undefined ? {} : { structuredContent: result.structured }),
	};
	const text = pieces.join("\n\n");
	return {
		text,
		content: withImages(text, converted),
		isError: result.isError,
		details,
	};
}

/** The runtime takes text from content when images are present, not from output.text. */
function withImages(text: string, converted: ConvertedContent): ToolOutput["content"] {
	return converted.images > 0
		? [{ type: "text", text }, ...converted.content.filter((block) => block.type === "image")]
		: undefined;
}

function statusLines(status: McpServerStatus): string[] {
	const lines = [`${status.name} [${status.kind}] ${status.state} — ${status.endpoint}`];
	if (status.server) lines.push(`  server: ${status.server}`);
	if (status.cwd) lines.push(`  cwd: ${status.cwd}`);
	if (status.error) lines.push(`  error: ${status.error}`);
	if (status.capabilities.length > 0) lines.push(`  capabilities: ${status.capabilities.join(", ")}`);
	lines.push(`  tools (${status.tools.length}): ${status.tools.join(", ") || "none"}`);
	if (status.env.length > 0) lines.push(`  env: ${status.env.join(", ")} (values hidden)`);
	if (status.headers.length > 0) lines.push(`  headers: ${status.headers.join(", ")} (values hidden)`);
	if (status.unresolved.length > 0) lines.push(`  unresolved variables: ${status.unresolved.join(", ")}`);
	if (status.attempts > 0) lines.push(`  connection attempts: ${status.attempts}`);
	if (status.stderr.length > 0) lines.push(`  stderr tail:`, ...status.stderr.map((line) => `    ${line}`));
	return lines;
}

function statusJson(status: McpServerStatus): Json {
	return {
		name: status.name,
		kind: status.kind,
		state: status.state,
		endpoint: status.endpoint,
		error: status.error ?? null,
		tools: status.tools,
		capabilities: status.capabilities,
		unresolved: status.unresolved,
		server: status.server ?? null,
		cwd: status.cwd ?? null,
		env: status.env,
		headers: status.headers,
		stderr: status.stderr,
		attempts: status.attempts,
		connectedAt: status.connectedAt ?? null,
	};
}

function stringArgument(args: Arguments, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`'${key}' must be a string`);
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function integerArgument(args: Arguments, key: string, fallback: number, minimum: number): number {
	const value = args[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		throw new Error(`'${key}' must be an integer >= ${minimum}.`);
	return value;
}

function brief(value: string | undefined): string {
	const line = (value ?? "").replace(/\s+/g, " ").trim();
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function matches(query: string | undefined, ...values: (string | undefined)[]): boolean {
	return !query || values.some((value) => value?.toLowerCase().includes(query));
}

function owner(servers: string[], label: string): string {
	const unique = [...new Set(servers)];
	if (unique.length === 1) return unique[0]!;
	if (unique.length > 1)
		throw new Error(`${label} exists on ${unique.join(", ")}. Pass 'server' to disambiguate.`);
	throw new Error(`No MCP server exposes ${label}. Use mcp_list to discover available entries.`);
}

async function listOutput(hub: McpHub, args: Arguments): Promise<ToolOutput> {
	const kind = stringArgument(args, "kind") ?? "tools";
	const server = stringArgument(args, "server");
	const tool = stringArgument(args, "tool");
	const query = stringArgument(args, "query")?.toLowerCase();
	const offset = integerArgument(args, "offset", 0, 0);
	const limit = Math.min(integerArgument(args, "limit", 50, 1), 100);
	if (tool) {
		if (kind !== "tools") throw new Error("'tool' can only be used with kind 'tools'.");
		const found = hub.tools(server).filter((entry) => entry.name === tool);
		const selectedServer =
			server ??
			owner(
				found.map((entry) => entry.server),
				`tool '${tool}'`,
			);
		const selected = found.find((entry) => entry.server === selectedServer);
		if (!selected) throw new Error(`MCP server '${selectedServer}' has no tool '${tool}'.`);
		const details: Json = {
			server: selected.server,
			tool: selected.name,
			...(selected.title ? { title: selected.title } : {}),
			description: selected.description,
			inputSchema: selected.parameters as Json,
			readOnly: selected.readOnly,
		};
		return { text: JSON.stringify(details, null, 2), details };
	}

	let rows: { text: string; data: Json }[];
	let failures: { server: string; error: string }[] = [];
	if (kind === "tools") {
		const entries = hub
			.tools(server)
			.filter((entry) => matches(query, entry.server, entry.name, entry.title, entry.description));
		entries.sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
		rows = entries.map((entry) => {
			const summary = brief(entry.description || entry.title);
			return {
				text: `${entry.server}\t${entry.name}${summary ? ` — ${summary}` : ""}`,
				data: { server: entry.server, tool: entry.name, summary, readOnly: entry.readOnly },
			};
		});
		failures = hub
			.servers()
			.filter((entry) => (!server || entry.name === server) && entry.state !== "connected")
			.map((entry) => ({ server: entry.name, error: entry.error ?? entry.state }));
	} else if (kind === "resources") {
		const result = await hub.listResources(server);
		failures = result.failures;
		const entries = result.entries.filter((entry) =>
			matches(query, entry.server, entry.name, entry.uri, entry.description),
		);
		entries.sort((a, b) => a.server.localeCompare(b.server) || a.uri.localeCompare(b.uri));
		rows = entries.map((entry) => ({
			text: `${entry.server}\t${entry.template ? "template" : "resource"}\t${entry.uri}\t${entry.name}${entry.description ? ` — ${brief(entry.description)}` : ""}`,
			data: {
				server: entry.server,
				uri: entry.uri,
				name: entry.name,
				template: entry.template,
				mimeType: entry.mimeType ?? null,
				summary: brief(entry.description),
			},
		}));
	} else if (kind === "prompts") {
		const result = await hub.listPrompts(server);
		failures = result.failures;
		const entries = result.entries.filter((entry) =>
			matches(query, entry.server, entry.name, entry.description),
		);
		entries.sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
		rows = entries.map((entry) => ({
			text: `${entry.server}\t${entry.name}(${entry.arguments.map((arg) => `${arg.name}${arg.required ? "*" : ""}`).join(", ")})${entry.description ? ` — ${brief(entry.description)}` : ""}`,
			data: {
				server: entry.server,
				name: entry.name,
				summary: brief(entry.description),
				arguments: entry.arguments.map((arg) => ({
					name: arg.name,
					required: arg.required,
					description: arg.description ?? null,
				})),
			},
		}));
	} else if (kind === "servers") {
		const all = hub.servers();
		if (server && !all.some((entry) => entry.name === server))
			throw new McpFailure(
				"unknown-server",
				server,
				`Unknown MCP server '${server}'. Configured: ${all.map((entry) => entry.name).join(", ") || "none"}`,
			);
		rows = all
			.filter(
				(entry) =>
					(!server || entry.name === server) &&
					matches(query, entry.name, entry.server, entry.endpoint, entry.state),
			)
			.map((entry) => ({
				text: server
					? statusLines(entry).join("\n")
					: `${entry.name}\t${entry.kind}\t${entry.state}\t${entry.tools.length} tools; ${entry.capabilities.join(", ") || "no capabilities"}${entry.error ? ` — ${brief(entry.error)}` : ""}`,
				data: statusJson(entry),
			}));
	} else {
		throw new Error("'kind' must be tools, resources, prompts or servers.");
	}
	const page = rows.slice(offset, offset + limit);
	const nextOffset = offset + page.length < rows.length ? offset + page.length : null;
	const lines = page.map((row) => row.text);
	if (!lines.length) lines.push(`No MCP ${kind} ${rows.length > 0 ? "in this page" : "match"}.`);
	lines.push(
		`Showing ${page.length ? offset + 1 : 0}-${page.length ? offset + page.length : 0} of ${rows.length} ${kind}.${nextOffset === null ? "" : ` Continue with offset=${nextOffset}.`}`,
	);
	if (kind === "tools" && page.length)
		lines.push("Use mcp_list with server and tool for the full description and inputSchema.");
	for (const failure of failures) lines.push(`${failure.server}\tunavailable\t${brief(failure.error)}`);
	return {
		text: lines.join("\n"),
		isError: rows.length === 0 && failures.length > 0,
		details: {
			kind,
			entries: page.map((row) => row.data),
			total: rows.length,
			offset,
			nextOffset,
			failures: failures.map((failure) => ({ server: failure.server, error: failure.error })),
		},
	};
}

async function callResource(hub: McpHub, args: Arguments, context: ToolContext): Promise<ToolOutput> {
	const uri = stringArgument(args, "uri");
	if (!uri) throw new Error("Action 'resource' requires 'uri'.");
	let server = stringArgument(args, "server");
	if (!server) {
		const { entries } = await hub.listResources();
		const owners = entries.filter((entry) => entry.uri === uri).map((entry) => entry.server);
		if (!owners.length)
			owners.push(
				...hub
					.servers()
					.filter((entry) => entry.state === "connected" && entry.capabilities.includes("resources"))
					.map((entry) => entry.name),
			);
		server = owner(owners, `resource '${uri}'`);
	}
	const contents = await hub.readResource(server, uri, context.signal);
	const converted = convertResourceContents(contents);
	const notes = converted.notes.length ? `\n[${converted.notes.join("; ")}]` : "";
	const text = (converted.text || `Resource '${uri}' returned no contents.`) + notes;
	return {
		text,
		content: withImages(text, converted),
		details: { server, uri, parts: contents.length, images: converted.images },
	};
}

async function callPrompt(hub: McpHub, args: Arguments, context: ToolContext): Promise<ToolOutput> {
	const name = stringArgument(args, "name");
	if (!name) throw new Error("Action 'prompt' requires 'name'.");
	let server = stringArgument(args, "server");
	if (!server) {
		const { entries } = await hub.listPrompts();
		server = owner(
			entries.filter((entry) => entry.name === name).map((entry) => entry.server),
			`prompt '${name}'`,
		);
	}
	const raw = args.arguments;
	const promptArguments: Record<string, string> = {};
	if (raw !== undefined) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw))
			throw new Error("Prompt 'arguments' must be an object of string values.");
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value !== "string") throw new Error(`Prompt argument '${key}' must be a string.`);
			promptArguments[key] = value;
		}
	}
	const prompt = await hub.getPrompt(server, name, promptArguments, context.signal);
	const converted = convertMcpContent(prompt.messages.map((message) => message.content));
	const header = prompt.description ? `${prompt.description}\n\n` : "";
	const notes = converted.notes.length ? `\n[${converted.notes.join("; ")}]` : "";
	const text = `${header}${converted.text || `Prompt '${name}' returned no content.`}${notes}`;
	return {
		text,
		content: withImages(text, converted),
		details: {
			server,
			prompt: name,
			messages: prompt.messages.length,
			roles: prompt.messages.map((message) => message.role).join(", "),
			images: converted.images,
		},
	};
}

/** Waits for background startup connections, so listings and ownership lookups see every server. */
async function startupSettled(hub: McpHub, signal?: AbortSignal): Promise<void> {
	if (!signal) return hub.settled();
	signal.throwIfAborted();
	const { promise, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([hub.settled(), promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export function createMcpTools(hub: McpHub): HarnessTool[] {
	return [
		{
			name: "mcp_list",
			description:
				"Discover MCP tools (default), resources/templates, prompts or server status in compact pages. Filter by server/query. Pass an exact tool name (and server if ambiguous) to retrieve its full description and inputSchema before mcp_call. Server-specific status includes diagnostics; no remote tool schemas are advertised in the baseline.",
			parameters: schema({
				kind: { type: "string", enum: ["tools", "resources", "prompts", "servers"] },
				server: { type: "string", description: "Configured server name; omit for all." },
				query: { type: "string", description: "Case-insensitive substring filter." },
				tool: {
					type: "string",
					description: "Exact server-side tool name: return its full schema instead of a listing.",
				},
				offset: { type: "integer", minimum: 0, description: "Zero-based page offset (default 0)." },
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 50, max 100)." },
			}),
			async execute(args: Arguments, context?: ToolContext): Promise<ToolOutput> {
				try {
					// Server status stays immediately inspectable while a slow server is still starting.
					if (stringArgument(args, "kind") !== "servers") await startupSettled(hub, context?.signal);
					return await listOutput(hub, args);
				} catch (error) {
					return failureOutput(error, "discovery");
				}
			},
		},
		{
			name: "mcp_call",
			description:
				"Call an MCP tool (default action 'tool') using its server-side name and discovered arguments. Other actions read a resource by uri, render a prompt by name (string arguments), or reconnect one/all servers and refresh discovery. Pass server to disambiguate; discover capabilities with mcp_list. Images, structured results and server error flags are preserved.",
			parameters: schema({
				action: { type: "string", enum: ["tool", "resource", "prompt", "reconnect"] },
				server: {
					type: "string",
					description:
						"Configured server name; required if ownership is ambiguous. Reconnect omits it for all servers.",
				},
				tool: { type: "string", description: "Exact server-side tool name for action 'tool'." },
				uri: { type: "string", description: "Resource URI for action 'resource'." },
				name: { type: "string", description: "Prompt name for action 'prompt'." },
				arguments: {
					type: "object",
					additionalProperties: true,
					description:
						"Tool arguments according to its discovered schema, or string-valued prompt arguments.",
				},
			}),
			async execute(args: Arguments, context: ToolContext): Promise<ToolOutput> {
				try {
					await startupSettled(hub, context.signal);
					const action = stringArgument(args, "action") ?? "tool";
					if (action === "resource") return await callResource(hub, args, context);
					if (action === "prompt") return await callPrompt(hub, args, context);
					if (action === "reconnect") {
						const result = await hub.reconnect(stringArgument(args, "server"));
						return {
							text: result.flatMap(statusLines).join("\n") || "No MCP servers are configured.",
							isError: result.length > 0 && result.every((status) => status.state !== "connected"),
							details: result.map(statusJson),
						};
					}
					if (action !== "tool") throw new Error("'action' must be tool, resource, prompt or reconnect.");
					const tool = stringArgument(args, "tool");
					if (!tool) throw new Error("Action 'tool' requires 'tool'.");
					const server =
						stringArgument(args, "server") ??
						owner(
							hub
								.tools()
								.filter((entry) => entry.name === tool)
								.map((entry) => entry.server),
							`tool '${tool}'`,
						);
					const payload = args.arguments;
					if (
						payload !== undefined &&
						(typeof payload !== "object" || payload === null || Array.isArray(payload))
					)
						throw new Error("'arguments' must be an object.");
					return callOutput(
						await hub.callTool(server, tool, (payload as Arguments) ?? {}, context),
						server,
						tool,
					);
				} catch (error) {
					return failureOutput(error, "call");
				}
			},
		},
	];
}
