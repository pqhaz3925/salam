import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Variables inherited by MCP children on top of the SDK's conservative default set
 * (HOME, PATH, SHELL, TERM, USER, …). Everything here is non-secret process plumbing
 * that servers routinely need; credentials must come from explicit `env` entries.
 */
const EXTRA_INHERITED = [
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TMPDIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
];

const SECRET_HINT =
	/(secret|token|password|passwd|api[-_]?key|access[-_]?key|credential|auth|cookie|session|bearer|private)/i;

export interface Expansion {
	value: string;
	missing: string[];
}

/**
 * Expands `${NAME}`, `${NAME:-fallback}` and `$NAME` against the parent environment.
 * `$$` escapes a literal dollar. Unset variables expand to an empty string and are
 * reported through `missing` so a misconfigured server fails loudly in status output
 * instead of silently handing a server an empty credential.
 */
export function expandTemplate(raw: string, source: NodeJS.ProcessEnv = process.env): Expansion {
	const missing: string[] = [];
	let out = "";
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];
		if (char !== "$") {
			out += char;
			continue;
		}
		const next = raw[index + 1];
		if (next === "$") {
			out += "$";
			index += 1;
			continue;
		}
		if (next === "{") {
			const end = raw.indexOf("}", index + 2);
			if (end < 0) {
				out += char;
				continue;
			}
			const body = raw.slice(index + 2, end);
			index = end;
			const separator = body.indexOf(":-");
			const name = separator < 0 ? body : body.slice(0, separator);
			const fallback = separator < 0 ? undefined : body.slice(separator + 2);
			const value = source[name];
			if (value !== undefined && value !== "") out += value;
			else if (fallback !== undefined) out += fallback;
			else missing.push(name);
			continue;
		}
		const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(index + 1));
		if (!match) {
			out += char;
			continue;
		}
		const value = source[match[0]];
		if (value !== undefined) out += value;
		else missing.push(match[0]);
		index += match[0].length;
	}
	return { value: out, missing };
}

export interface ChildEnvironment {
	env: Record<string, string>;
	/** Names only — values are never surfaced anywhere. */
	configured: string[];
	missing: string[];
}

export function childEnvironment(configured: Record<string, string> | undefined): ChildEnvironment {
	const env: Record<string, string> = { ...getDefaultEnvironment() };
	for (const name of EXTRA_INHERITED) {
		const value = process.env[name];
		if (value !== undefined && !value.startsWith("()")) env[name] = value;
	}
	const missing: string[] = [];
	const names: string[] = [];
	for (const [name, raw] of Object.entries(configured ?? {})) {
		const expansion = expandTemplate(raw);
		env[name] = expansion.value;
		names.push(name);
		for (const variable of expansion.missing) missing.push(`${name}←$${variable}`);
	}
	return { env, configured: names, missing };
}

export interface ExpandedHeaders {
	headers: Record<string, string>;
	names: string[];
	missing: string[];
}

export function expandHeaders(configured: Record<string, string> | undefined): ExpandedHeaders {
	const headers: Record<string, string> = {};
	const names: string[] = [];
	const missing: string[] = [];
	for (const [name, raw] of Object.entries(configured ?? {})) {
		const expansion = expandTemplate(raw);
		headers[name] = expansion.value;
		names.push(name);
		for (const variable of expansion.missing) missing.push(`${name}←$${variable}`);
	}
	return { headers, names, missing };
}

/** Command line rendered for diagnostics with credential-looking arguments masked. */
export function describeCommand(command: string, args: readonly string[] | undefined): string {
	const rendered = (args ?? []).map((arg) => {
		const equals = arg.indexOf("=");
		if (arg.startsWith("-") && equals > 0) {
			const flag = arg.slice(0, equals);
			return SECRET_HINT.test(flag) ? `${flag}=***` : arg;
		}
		if (SECRET_HINT.test(arg)) return "***";
		if (arg.length >= 24 && /^[A-Za-z0-9._\-+/=]+$/.test(arg) && !arg.includes("/") && !arg.includes("."))
			return "***";
		return arg;
	});
	return [command, ...rendered].join(" ");
}

/** URL rendered for diagnostics without user-info or query string, both of which carry tokens. */
export function describeUrl(raw: string): string {
	try {
		const url = new URL(raw);
		const query = url.search.length > 0 ? "?…" : "";
		return `${url.protocol}//${url.host}${url.pathname}${query}`;
	} catch {
		return raw.split("?")[0] ?? raw;
	}
}
