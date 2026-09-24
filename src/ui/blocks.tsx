import { CodeRenderable, StyledText } from "@opentui/core";
import type { MarkdownRenderable, OnHighlightCallback, Renderable, TextChunk } from "@opentui/core";
import { For, Show, createEffect, createMemo, on } from "solid-js";
import type { ModelChoice, ViewItem } from "../contracts.ts";
import { diffFenceHighlights, parseUnifiedDiff } from "./diff.ts";
import type { DiffRow } from "./diff.ts";
import { StyledLine } from "./styled.tsx";
import {
	bold,
	danger,
	faint,
	glyph,
	italic,
	muted,
	ok,
	plain,
	syntaxStyle,
	text,
	thinking,
	user,
	warn,
} from "./theme.ts";
import { flatten, truncate } from "./text.ts";

/** Collapsed failures keep this many trailing output lines in view. */
const ERROR_TAIL_LINES = 4;
const EXPAND_HINT = "(ctrl+o tool output)";

/**
 * Argument keys that name what a call acts on, most telling first. The first
 * one present becomes the row's target; unknown tools fall back to their first
 * string argument.
 */
const TARGET_KEYS = [
	"command",
	"path",
	"pattern",
	"query",
	"url",
	"uri",
	"server",
	"name",
	"id",
	"target",
	"task",
	"message",
	"summary",
	"reason",
	"text",
];

/** GPT reasoning summaries title each section with a lone `**Title**` line. */
const THOUGHT_HEADING = /^\s*\*\*(.+?)\*\*\s*$/;

type ToolArguments = Record<string, unknown>;

/** Short label for a turn's provider/model, e.g. to distinguish Opus and GPT in one dialog. */
export function modelTag(selection?: ModelChoice): string {
	if (!selection) return "";
	return `${selection.provider}/${selection.label ?? selection.model}`;
}

export function UserBlock(props: { text: string }) {
	return (
		<box flexDirection="column" width="100%" marginTop={1}>
			<For each={props.text.replace(/\s+$/, "").split("\n")}>
				{(line, index) => (
					<StyledLine
						wrapMode="word"
						width="100%"
						content={new StyledText([muted(index() === 0 ? `${glyph.user} ` : "  "), user(line)])}
					/>
				)}
			</For>
		</box>
	);
}

/** Only answers for ```diff/```patch fences, which have no tree-sitter grammar. */
const highlightDiffFence: OnHighlightCallback = (_highlights, context) =>
	context.filetype === "diff" ? diffFenceHighlights(context.content) : undefined;

/**
 * Markdown builds a CodeRenderable per fence and updates it in place while
 * the info string streams in (`di` → `diff`), so the classifier is attached
 * to every diff fence after each content change rather than at creation.
 */
function attachDiffHighlighting(parent: Renderable): void {
	for (const child of parent.getChildren()) {
		if (!(child instanceof CodeRenderable)) attachDiffHighlighting(child);
		else if (child.filetype === "diff" && child.onHighlight === undefined)
			child.onHighlight = highlightDiffFence;
	}
}

/**
 * Reasoning followed by a flat, bullet-led answer. Always shown in full;
 * the ctrl+o toggle only concerns tool output.
 */
export function AssistantBlock(props: { text: string; thinking: string; streaming: boolean }) {
	const reasoning = createMemo(() => /\S/.test(props.thinking));
	let answer: MarkdownRenderable | undefined;
	// Runs after the markdown applied the new content, i.e. after it rebuilt its blocks.
	createEffect(
		on([() => props.text, () => props.streaming], () => {
			if (answer && !answer.isDestroyed) attachDiffHighlighting(answer);
		}),
	);
	return (
		<Show when={reasoning() || props.text.length > 0}>
			<box flexDirection="column" width="100%" marginTop={1} flexShrink={0}>
				<Show when={reasoning()}>
					<ThinkingBlock text={props.thinking} spaced={props.text.length > 0} />
				</Show>
				<Show when={props.text.length > 0}>
					<box flexDirection="row" width="100%">
						<StyledLine width={2} wrapMode="none" content={new StyledText([text("● ")])} />
						<box flexDirection="column" flexGrow={1} minWidth={0}>
							<markdown
								ref={(element: MarkdownRenderable) => {
									answer = element;
								}}
								content={props.text}
								streaming={props.streaming}
								syntaxStyle={syntaxStyle}
								width="100%"
							/>
						</box>
					</box>
				</Show>
			</box>
		</Show>
	);
}

function ThinkingBlock(props: { text: string; spaced: boolean }) {
	const content = createMemo(() => {
		const chunks: TextChunk[] = [];
		const lines = props.text.trim().split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			if (index > 0) chunks.push(plain("\n"));
			const line = lines[index]!;
			const heading = THOUGHT_HEADING.exec(line);
			if (heading) chunks.push(bold(italic(thinking(heading[1]!))));
			else if (line.length > 0) chunks.push(italic(thinking(line)));
		}
		return new StyledText(chunks);
	});
	return (
		<box flexDirection="column" width="100%" marginBottom={props.spaced ? 1 : 0}>
			<StyledLine wrapMode="none" content={new StyledText([faint("thinking")])} />
			<StyledLine wrapMode="word" width="100%" content={content()} />
		</box>
	);
}

export function NoticeBlock(props: { text: string; error: boolean; width: number }) {
	return (
		<box flexDirection="column" width="100%" marginTop={1}>
			<For each={props.text.replace(/\s+$/, "").split("\n")}>
				{(line, index) => (
					<StyledLine
						wrapMode="word"
						width="100%"
						content={
							new StyledText([
								index() === 0 ? (props.error ? danger("! ") : muted(`${glyph.bullet} `)) : muted("  "),
								props.error ? danger(line) : muted(line),
							])
						}
					/>
				)}
			</For>
		</box>
	);
}

function diffRowChunks(row: DiffRow): TextChunk[] {
	const gutter = (value: number | undefined) =>
		faint(value === undefined ? "     " : String(value).padStart(5));
	if (row.kind === "file") return [muted(row.text)];
	if (row.kind === "meta") return [faint(row.text)];
	if (row.kind === "hunk") return [faint(glyph.ellipsis)];
	if (row.kind === "add") return [gutter(row.newLine), ok(` + ${row.text}`)];
	if (row.kind === "del") return [gutter(row.oldLine), danger(` - ${row.text}`)];
	return [gutter(row.newLine), text(`   ${row.text}`)];
}

/** Rows hung under a tool header: `└` on the first, an aligned indent on the rest. */
function hanging(rows: TextChunk[][]): StyledText {
	const chunks: TextChunk[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		if (index > 0) chunks.push(plain("\n"));
		chunks.push(faint(index === 0 ? `${glyph.branch} ` : "  "), ...rows[index]!);
	}
	return new StyledText(chunks);
}

/** The call's recorded arguments; the runtime stores them as JSON in `details`. */
function toolArguments(details: string | undefined): ToolArguments | undefined {
	if (!details) return undefined;
	try {
		const value: unknown = JSON.parse(details);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as ToolArguments)
			: undefined;
	} catch {
		return undefined;
	}
}

function scalarArgument(args: ToolArguments, key: string): string | undefined {
	const value = args[key];
	if (typeof value === "string") return value.trim().length > 0 ? value : undefined;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

/** What a call acts on, built only from its real arguments, plus the keys it consumed. */
function toolTarget(args: ToolArguments | undefined): { label: string; keys: string[] } | undefined {
	if (!args) return undefined;
	const key =
		TARGET_KEYS.find((name) => scalarArgument(args, name) !== undefined) ??
		Object.keys(args).find(
			(name) => typeof args[name] === "string" && scalarArgument(args, name) !== undefined,
		);
	if (key === undefined) return undefined;
	const parts = [flatten(scalarArgument(args, key)!)];
	const keys = [key];
	const add = (name: string, separator: string): boolean => {
		const value = scalarArgument(args, name);
		if (value === undefined) return false;
		parts.push(separator, flatten(value));
		keys.push(name);
		return true;
	};
	if (key === "path") {
		if (add("line", ":") || add("offset", ":")) add("character", ":");
	} else if (key === "pattern" || key === "query") add("path", " in ");
	else if (key === "server") add("tool", " ");
	return { label: parts.join(""), keys };
}

/** A compact description of a JSON result, so collapsed rows never dump raw JSON. */
function jsonSummary(lines: string[]): string | undefined {
	const first = lines[0]?.trimStart() ?? "";
	const last = lines[lines.length - 1]?.trimEnd() ?? "";
	if (!((first.startsWith("{") && last.endsWith("}")) || (first.startsWith("[") && last.endsWith("]"))))
		return undefined;
	let value: unknown;
	try {
		value = JSON.parse(lines.join("\n"));
	} catch {
		return undefined;
	}
	if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value);
		return keys.length > 0 ? `{ ${keys.join(", ")} }` : "{}";
	}
	return undefined;
}

function argumentRows(key: string, value: unknown): TextChunk[][] {
	const shown = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
	const lines = shown.split("\n");
	if (lines.length === 1) return [[faint(`${key}: ${shown}`)]];
	return [[faint(`${key}:`)], ...lines.map((line) => [faint(`  ${line}`)])];
}

/**
 * A tool call as one compact action row: status dot, tool name and target.
 * Collapsed, the result is a one-line summary (failures keep their last lines);
 * expanded, every argument, retained output line and diff row is shown.
 */
export function ToolBlock(props: { item: ViewItem; width: number; expanded: boolean }) {
	const args = createMemo(() => toolArguments(props.item.details));
	const target = createMemo(() => toolTarget(args()));
	const lines = createMemo(() => {
		const body = props.item.text.replace(/\s+$/, "");
		return body.length > 0 ? body.split("\n") : [];
	});
	/** Output without the `cwd$ command` line `shell` echoes above it, which repeats the row's target. */
	const output = createMemo(() => {
		const values = args();
		const command = values ? scalarArgument(values, "command") : undefined;
		const first = lines()[0];
		return command !== undefined && first !== undefined && first.endsWith(`$ ${command.split("\n", 1)[0]}`)
			? lines().slice(1)
			: lines();
	});
	const diff = createMemo(() => (props.item.diff ? parseUnifiedDiff(props.item.diff) : undefined));
	const state = () => props.item.state ?? "done";
	const json = createMemo(() => (state() === "done" ? jsonSummary(output()) : undefined));
	/** Header columns left for the target after the dot, the name and their spacing. */
	const labelRoom = () => props.width - (props.item.name ?? "tool").length - 3;

	const header = () => {
		const dot =
			state() === "error"
				? danger(glyph.tool)
				: state() === "running"
					? warn(glyph.toolRunning)
					: ok(glyph.tool);
		const label = target()?.label ?? "";
		const chunks: TextChunk[] = [
			dot,
			plain(" "),
			bold(text(truncate(props.item.name ?? "tool", props.width - 2))),
		];
		if (label.length > 0 && labelRoom() > 1) chunks.push(plain(" "), text(truncate(label, labelRoom())));
		return new StyledText(chunks);
	};

	const summaryRows = (): TextChunk[][] => {
		const shown = output();
		const room = Math.max(1, props.width - 4);
		if (state() === "running") {
			for (let index = shown.length - 1; index >= 0; index -= 1)
				if (shown[index]!.trim().length > 0) return [[faint(truncate(flatten(shown[index]!), room))]];
			return [];
		}
		const firstIndex = shown.findIndex((line) => line.trim().length > 0);
		const summary = json() ?? (firstIndex >= 0 ? flatten(shown[firstIndex]!) : "");
		const hidden = json() === undefined ? Math.max(0, shown.length - 1) : 0;
		const parsed = diff();
		const stat = parsed ? `+${parsed.added} -${parsed.removed}` : "";
		const more = hidden > 0 || json() !== undefined || (parsed?.rows.length ?? 0) > 0;
		const hint = more ? `${hidden > 0 ? `${glyph.ellipsis} +${hidden} lines ` : ""}${EXPAND_HINT}` : "";
		const reserved = (stat.length > 0 ? stat.length + 2 : 0) + (hint.length > 0 ? hint.length + 2 : 0);
		const chunks: TextChunk[] = [];
		if (summary.length > 0) chunks.push(muted(truncate(summary, Math.max(8, room - reserved))));
		if (parsed)
			chunks.push(
				plain(chunks.length > 0 ? "  " : ""),
				ok(`+${parsed.added}`),
				plain(" "),
				danger(`-${parsed.removed}`),
			);
		if (hint.length > 0) chunks.push(faint(`${chunks.length > 0 ? "  " : ""}${hint}`));
		return chunks.length > 0 ? [chunks] : [];
	};

	const errorRows = (): TextChunk[][] => {
		const tail = output().slice(-ERROR_TAIL_LINES);
		const hidden = output().length - tail.length;
		const rows: TextChunk[][] = [];
		if (hidden > 0) rows.push([faint(`${glyph.ellipsis} +${hidden} lines ${EXPAND_HINT}`)]);
		for (const line of tail) rows.push([danger(line)]);
		return rows;
	};

	const expandedRows = (): TextChunk[][] => {
		const rows: TextChunk[][] = [];
		const values = args();
		const parsed = diff();
		if (values) {
			const consumed = (target()?.label.length ?? 0) <= labelRoom() ? (target()?.keys ?? []) : [];
			for (const [key, value] of Object.entries(values)) {
				const exact = typeof value !== "string" || flatten(value) === value;
				// The header already shows this value verbatim.
				if (consumed.includes(key) && exact) continue;
				// The diff below is the readable form of an edit payload.
				if (parsed && typeof value === "string" && value.includes("\n")) continue;
				rows.push(...argumentRows(key, value));
			}
		}
		const tone = state() === "error" ? danger : text;
		for (const line of lines()) rows.push([tone(line)]);
		if (parsed) {
			rows.push([ok(`+${parsed.added}`), plain(" "), danger(`-${parsed.removed}`)]);
			for (const row of parsed.rows) rows.push(diffRowChunks(row));
		}
		return rows;
	};

	const detail = createMemo((): { rows: TextChunk[][]; wrap: "none" | "char" | "word" } => {
		if (props.expanded) return { rows: expandedRows(), wrap: "char" };
		if (state() === "error") return { rows: errorRows(), wrap: "word" };
		return { rows: summaryRows(), wrap: "none" };
	});

	return (
		<box flexDirection="column" width="100%" marginTop={1} flexShrink={0}>
			<StyledLine wrapMode="none" width="100%" content={header()} />
			<Show when={detail().rows.length > 0}>
				<box width="100%" paddingLeft={2}>
					<StyledLine wrapMode={detail().wrap} width="100%" content={hanging(detail().rows)} />
				</box>
			</Show>
		</box>
	);
}
