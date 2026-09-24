import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

/** Structural view of an MCP content block; tolerant of server-specific extras. */
export type McpBlock = { [key: string]: unknown };

export interface ConvertedContent {
	/** Flattened transcript of every block, including markers for non-text payloads. */
	text: string;
	/** Model-visible content preserving images as native blocks. */
	content: (TextContent | ImageContent)[];
	images: number;
	/** Human-readable notes about anything that could not be passed through verbatim. */
	notes: string[];
}

export interface ConvertLimits {
	maxText: number;
	maxImages: number;
}

const DEFAULT_LIMITS: ConvertLimits = { maxText: 240_000, maxImages: 12 };
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|bmp|tiff?)$/i;

export function base64Bytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function stringField(block: McpBlock, key: string): string | undefined {
	const value = block[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Converts MCP content blocks into pi-ai tool-result content. Text and images pass
 * through natively; everything else is described explicitly so nothing silently
 * disappears from the model's view.
 */
export function convertMcpContent(
	blocks: readonly McpBlock[] | undefined,
	limits: ConvertLimits = DEFAULT_LIMITS,
): ConvertedContent {
	const content: (TextContent | ImageContent)[] = [];
	const notes: string[] = [];
	const chunks: string[] = [];
	let textBudget = limits.maxText;
	let images = 0;

	const pushText = (value: string) => {
		if (value.length === 0) return;
		let piece = value;
		if (piece.length > textBudget) {
			piece = piece.slice(0, Math.max(0, textBudget));
			if (notes.every((note) => !note.startsWith("text truncated"))) {
				notes.push(`text truncated at ${limits.maxText} characters`);
			}
		}
		textBudget -= piece.length;
		if (piece.length === 0) return;
		chunks.push(piece);
		const last = content[content.length - 1];
		if (last && last.type === "text") last.text += (last.text.endsWith("\n") ? "" : "\n") + piece;
		else content.push({ type: "text", text: piece });
	};

	const pushImage = (data: string, mimeType: string, origin: string) => {
		const marker = `[image ${mimeType} ${formatBytes(base64Bytes(data))}${origin ? ` from ${origin}` : ""}]`;
		if (images >= limits.maxImages) {
			notes.push(`${marker} omitted: image limit ${limits.maxImages} reached`);
			pushText(`${marker} (omitted: image limit reached)`);
			return;
		}
		images += 1;
		pushText(marker);
		content.push({ type: "image", data, mimeType });
	};

	for (const block of blocks ?? []) {
		const type = stringField(block, "type");
		if (type === "text") {
			pushText(stringField(block, "text") ?? "");
			continue;
		}
		if (type === "image") {
			const data = stringField(block, "data");
			const mimeType = stringField(block, "mimeType") ?? "image/png";
			if (data) pushImage(data, mimeType, "");
			else notes.push("image block without data");
			continue;
		}
		if (type === "audio") {
			const data = stringField(block, "data") ?? "";
			const mimeType = stringField(block, "mimeType") ?? "audio/*";
			pushText(
				`[audio ${mimeType} ${formatBytes(base64Bytes(data))} — audio content is not forwarded to the model]`,
			);
			notes.push("audio content dropped");
			continue;
		}
		if (type === "resource_link") {
			const uri = stringField(block, "uri") ?? "(no uri)";
			const name = stringField(block, "name");
			const mimeType = stringField(block, "mimeType");
			const description = stringField(block, "description");
			const parts = [`[resource_link ${uri}`];
			if (name) parts.push(`name=${name}`);
			if (mimeType) parts.push(`type=${mimeType}`);
			pushText(`${parts.join(" ")}]${description ? ` ${description}` : ""}`);
			continue;
		}
		if (type === "resource") {
			const resource = block.resource;
			if (resource && typeof resource === "object") {
				pushResource(resource as McpBlock, pushText, pushImage);
				continue;
			}
			notes.push("embedded resource without payload");
			continue;
		}
		pushText(`[unsupported content block ${type ?? "without type"}]`);
		notes.push(`unsupported content block: ${type ?? "missing type"}`);
	}

	return { text: chunks.join("\n"), content, images, notes };
}

function pushResource(
	resource: McpBlock,
	pushText: (value: string) => void,
	pushImage: (data: string, mimeType: string, origin: string) => void,
): void {
	const uri = stringField(resource, "uri") ?? "(no uri)";
	const mimeType = stringField(resource, "mimeType") ?? "";
	const text = stringField(resource, "text");
	if (text !== undefined) {
		pushText(`[resource ${uri}${mimeType ? ` ${mimeType}` : ""}]\n${text}`);
		return;
	}
	const blob = stringField(resource, "blob");
	if (blob !== undefined) {
		if (IMAGE_MIME.test(mimeType)) pushImage(blob, mimeType, uri);
		else
			pushText(
				`[binary resource ${uri}${mimeType ? ` ${mimeType}` : ""} ${formatBytes(base64Bytes(blob))} — not decodable as text]`,
			);
		return;
	}
	pushText(`[resource ${uri} with no text or blob payload]`);
}

/** Renders resource contents returned by `resources/read` with the same rules. */
export function convertResourceContents(
	contents: readonly McpBlock[] | undefined,
	limits?: ConvertLimits,
): ConvertedContent {
	const blocks: McpBlock[] = (contents ?? []).map((resource) => ({ type: "resource", resource }));
	return convertMcpContent(blocks, limits);
}

/** Where a Playwright MCP server resolved its client-relative artifact links. */
export interface PlaywrightLinkScope {
	/** Directory the server printed relative paths against (its client workspace). */
	base: string;
	/** Directories the server writes its own artifacts into (snapshots, logs, traces, downloads). */
	artifactRoots: readonly string[];
	/** Call start time, used to recognize files written outside the default output directory. */
	since: number;
}

/** Playwright 0.0.82's own artifact titles; arbitrary links in Result are page/tool data. */
const PLAYWRIGHT_RESULT_FILES: Record<string, true> = {
	Console: true,
	Network: true,
	Request: true,
	"Evaluation result": true,
	"Request headers": true,
	"Request body": true,
	"Response headers": true,
	"Response body": true,
	"Storage state": true,
	"Page as pdf": true,
	Trace: true,
	"Action log": true,
	"Network log": true,
	Resources: true,
	Video: true,
};
const PLAYWRIGHT_FILE_LINK = /^- \[([^\]\n]+)\]\((.+)\)$/;
const PLAYWRIGHT_CONSOLE_LINK = /^(- New console entries: )(.+?)(#L\d+(?:-L\d+)?)$/;
const PLAYWRIGHT_DOWNLOAD = /^(- Downloaded file .+? to ")([^"\n]+)(")$/;
/** `scheme:` prefixes (http:, file:, data:, about: …) — never local relative paths. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** mtime granularity and clock slack when deciding whether this call wrote a file. */
const FRESH_SLACK_MS = 2_000;

function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Resolves one relative path printed by Playwright, or returns undefined when it is not
 * provably a local artifact the server wrote: URLs, absolute or home-relative paths,
 * missing files, and files outside the artifact roots that this call did not touch.
 */
function resolveArtifact(
	candidate: string,
	scope: PlaywrightLinkScope,
	roots: readonly string[],
): string | undefined {
	if (candidate.length === 0 || candidate !== candidate.trim()) return undefined;
	if (isAbsolute(candidate) || URL_SCHEME.test(candidate) || candidate.startsWith("~")) return undefined;
	if (candidate.startsWith("//") || candidate.startsWith("\\\\") || candidate.startsWith("#"))
		return undefined;
	if (candidate.includes("?") || candidate.includes("#") || candidate.includes("\0")) return undefined;
	const absolute = resolve(scope.base, candidate);
	let modified: number;
	try {
		const stat = statSync(absolute);
		if (!stat.isFile() && !stat.isDirectory()) return undefined;
		modified = stat.mtimeMs;
	} catch {
		return undefined;
	}
	const real = realOrSelf(absolute);
	const owned = roots.some((root) => {
		const rel = relative(root, real);
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	});
	if (owned || modified >= scope.since - FRESH_SLACK_MS) return absolute;
	return undefined;
}

/**
 * Rewrites the relative artifact links a Playwright MCP server prints (snapshot/screenshot
 * files, console logs, downloads, traces) into absolute local paths. Only Playwright's own
 * line shapes inside its Result/Snapshot/Events sections are considered, fenced code (page
 * snapshots, generated code) is never touched, and a path is rewritten only when it resolves
 * to an existing local file the server owns or just wrote.
 */
export function absolutizePlaywrightLinks(
	blocks: readonly McpBlock[],
	scope: PlaywrightLinkScope,
): { blocks: McpBlock[]; rewritten: number } {
	const roots = scope.artifactRoots.map(realOrSelf);
	let rewritten = 0;
	const out = blocks.map((block) => {
		const text = stringField(block, "text");
		if (stringField(block, "type") !== "text" || text === undefined) return block;
		let fence: string | undefined;
		let section: string | undefined;
		let changed = false;
		const lines = text.split("\n").map((line) => {
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (fence) {
				if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim())
					fence = undefined;
				return line;
			}
			if (marker) {
				fence = marker[1];
				return line;
			}
			if (/^#{1,6}\s/.test(line)) {
				section = line.startsWith("### ") ? line.slice(4).trim() : undefined;
				return line;
			}
			let match: RegExpExecArray | null = null;
			const file = PLAYWRIGHT_FILE_LINK.exec(line);
			if (
				file &&
				((section === "Snapshot" && file[1] === "Snapshot") ||
					(section === "Result" &&
						(PLAYWRIGHT_RESULT_FILES[file[1]!] === true ||
							/^Screenshot of .+$/.test(file[1]!) ||
							/^Annotation (?:image|snapshot)(?: \d+)?$/.test(file[1]!))))
			) {
				match = file;
			} else if (section === "Events") {
				match = PLAYWRIGHT_CONSOLE_LINK.exec(line) ?? PLAYWRIGHT_DOWNLOAD.exec(line);
			}
			if (!match) return line;
			const absolute = resolveArtifact(match[2] ?? "", scope, roots);
			if (!absolute) return line;
			rewritten += 1;
			changed = true;
			return match === file ? `- [${file![1]}](${absolute})` : `${match[1]}${absolute}${match[3]}`;
		});
		return changed ? { ...block, text: lines.join("\n") } : block;
	});
	return { blocks: out, rewritten };
}
