import type { MarkdownRenderable, OnHighlightCallback, Renderable, TextChunk } from "@opentui/core";
import { bg, CodeRenderable, fg, StyledText } from "@opentui/core";
import { createEffect, createMemo, For, on, Show } from "solid-js";
import type { ModelChoice, ViewItem } from "../contracts.ts";
import { classifyShell } from "../tools/shell-kind.ts";
import { SYNTAX_ERRORS } from "../tools/syntax-check.ts";
import type { DiffRow } from "./diff.ts";
import { diffFenceHighlights, parseUnifiedDiff } from "./diff.ts";
import { StyledLine } from "./styled.tsx";
import { flatten, truncate } from "./text.ts";
import {
	bold,
	danger,
	faint,
	glyph,
	italic,
	muted,
	ok,
	palette,
	plain,
	syntaxStyle,
	text,
	thinking,
	user,
	warn,
} from "./theme.ts";

/** Collapsed failures keep this many trailing output lines in view. */
const ERROR_TAIL_LINES = 4;
/** Collapsed results show this many leading output lines, as Claude Code does. */
const OUTPUT_LINES = 3;
/** Collapsed diffs show this many rows before the expand hint. */
const DIFF_ROWS = 12;
const EXPAND_HINT = "(ctrl+o to expand)";
/** How the shell tool opens its report of files that changed on disk. */
const CHANGED_FILES = "[files you had seen changed on disk while this command ran:";
const addedBg = bg(palette.addedBg);
const addedText = fg(palette.added);
const removedText = fg(palette.removed);
const removedBg = bg(palette.removedBg);

/**
 * Argument keys that name what a call acts on, most telling first. The first
 * one present becomes the row's target; unknown tools fall back to their first
 * string argument.
 */
const TARGET_KEYS = [
	"command",
	"pattern",
	"query",
	"path",
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

/** The user's message on a tinted full-width band, as Claude Code shows it. */
export function UserBlock(props: { text: string }) {
	return (
		<box flexDirection="column" width="100%" marginTop={1} backgroundColor={palette.userBg}>
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
			<StyledLine wrapMode="none" content={new StyledText([italic(thinking("\u2234 Thinking\u2026"))])} />
			<box width="100%" paddingLeft={2}>
				<StyledLine wrapMode="word" width="100%" content={content()} />
			</box>
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

/**
 * One diff row: line number, then the line on a green or red band for additions and removals,
 * padded to `width` so the band reads as a row, as in Claude Code.
 */
function diffRowChunks(row: DiffRow, width: number): TextChunk[] {
	const gutter = (value: number | undefined) => (value === undefined ? "    " : String(value).padStart(4));
	if (row.kind === "file") return [muted(row.text)];
	if (row.kind === "meta") return [faint(row.text)];
	if (row.kind === "hunk") return [faint(`   ${glyph.ellipsis}`)];
	const tabs = row.text.replace(/\t/g, "  ");
	if (row.kind === "context") return [faint(gutter(row.newLine)), text(`   ${tabs}`)];
	const added = row.kind === "add";
	const band = added ? addedBg : removedBg;
	const body = `${gutter(added ? row.newLine : row.oldLine)} ${added ? "+" : "-"} ${tabs}`;
	return [band((added ? addedText : removedText)(body.length < width ? body.padEnd(width) : body))];
}

/** Rows hung under a tool header: `⎿` on the first, an aligned indent on the rest. */
function hanging(rows: TextChunk[][]): StyledText {
	const chunks: TextChunk[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		if (index > 0) chunks.push(plain("\n"));
		chunks.push(faint(index === 0 ? `${glyph.branch}  ` : "   "), ...rows[index]!);
	}
	return new StyledText(chunks);
}

/**
 * Drops hunk markers that open a diff or a file (nothing precedes them to elide) and the blank
 * row a final newline leaves.
 */
function trimDiff(rows: DiffRow[]): DiffRow[] {
	const kept = rows.filter(
		(row, index) => row.kind !== "hunk" || (index > 0 && rows[index - 1]!.kind !== "file"),
	);
	const last = kept.at(-1);
	return last?.kind === "context" && last.text.length === 0 ? kept.slice(0, -1) : kept;
}

/** The runtime's todo listing, `1. [status] text`, as a checklist. */
function todoRows(lines: string[]): TextChunk[][] | undefined {
	const rows: TextChunk[][] = [];
	for (const line of lines) {
		const item = /^\d+\. \[(\w+)\] (.*)$/.exec(line);
		if (!item) return undefined;
		const [, status, content] = item;
		rows.push(
			status === "completed"
				? [ok("\u2713 "), faint(content!)]
				: status === "in_progress"
					? [warn(`${glyph.todoActive} `), bold(text(content!))]
					: status === "blocked" || status === "abandoned"
						? [danger(`${glyph.todoBlocked} `), muted(content!)]
						: [muted("\u25a1 "), text(content!)],
		);
	}
	return rows.length > 0 ? rows : undefined;
}

/** `web_search` → `WebSearch`: tool names read like Claude Code's `Bash(…)` and `Read(…)`. */
function displayName(name: string): string {
	return name
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join("");
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
	// batch_edit: the files it changes.
	if (Array.isArray(args.files)) {
		const paths = args.files.flatMap((file) =>
			file && typeof file === "object" && typeof (file as { path?: unknown }).path === "string"
				? [(file as { path: string }).path]
				: [],
		);
		if (paths.length > 0) return { label: paths.join(", "), keys: [] };
	}
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

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * A tool call in Claude Code's shape: `● Name(target)`, then its result hung under `⎿`.
 * Collapsed, the result shows its first lines (failures their last ones) and any diff on
 * tinted rows, each cut short with an expand hint; expanded, every argument, output line
 * and diff row is shown.
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
		let rest = command && first?.endsWith(`$ ${command.split("\n", 1)[0]}`) ? lines().slice(1) : lines();
		// The shell's report of changed files repeats, for the model, the diff drawn below.
		const report = rest.findIndex((line) => line.startsWith(CHANGED_FILES));
		if (report >= 0) rest = rest.slice(0, report);
		rest = rest.filter((line) => !line.startsWith(SYNTAX_ERRORS));
		// With a diff to show, the shell's "(no output)" placeholder says nothing.
		if (props.item.diff && rest.length === 1 && rest[0]!.trim() === "(no output)") rest = [];
		// Leading blank lines would leave the `⎿` pointing at nothing.
		const start = rest.findIndex((line) => line.trim().length > 0);
		return start < 0 ? [] : rest.slice(start);
	});
	const diff = createMemo(() => (props.item.diff ? parseUnifiedDiff(props.item.diff) : undefined));
	/** Files the command left unparseable: always shown, never folded away. */
	const syntax = createMemo(() => {
		const line = lines().find((candidate) => candidate.startsWith(SYNTAX_ERRORS));
		return line?.slice(SYNTAX_ERRORS.length, -1).trim();
	});
	const state = () => props.item.state ?? "done";
	const json = createMemo(() => (state() === "done" ? jsonSummary(output()) : undefined));
	const name = createMemo(() => displayName(props.item.name ?? "tool"));
	/** A shell call labelled by what it does (`Read(a.ts)`), when that is recognisable. */
	const kind = createMemo(() => {
		const command = props.item.name === "shell" ? scalarArgument(args() ?? {}, "command") : undefined;
		return command ? classifyShell(command, props.item.text) : undefined;
	});
	/** Header columns left for the target after the dot, the name, the space and the parentheses. */
	const labelRoom = () => props.width - name().length - 4;
	/** Columns right of the `⎿` gutter, for diff bands. */
	const bodyWidth = () => Math.max(8, props.width - 5);

	const header = () => {
		const dot =
			state() === "error" ? danger(glyph.tool) : state() === "running" ? faint(glyph.tool) : ok(glyph.tool);
		const chunks: TextChunk[] = [dot, plain(" ")];
		const parts = kind();
		if (parts) {
			let room = props.width - 2;
			for (const [index, part] of parts.entries()) {
				const lead = index > 0 ? " \u00b7 " : "";
				const verb = truncate(part.verb, room - lead.length);
				if (verb.length === 0) break;
				chunks.push(faint(lead), bold(text(verb)));
				room -= lead.length + verb.length;
				const label = flatten(part.target);
				if (label.length > 0 && room > 3) {
					const shown = truncate(label, room - 2);
					chunks.push(text(`(${shown})`));
					room -= shown.length + 2;
				}
			}
			return new StyledText(chunks);
		}
		const label = target()?.label ?? "";
		chunks.push(bold(text(truncate(name(), props.width - 2))));
		if (label.length > 0 && labelRoom() > 1)
			chunks.push(text("("), text(truncate(label, labelRoom())), text(")"));
		return new StyledText(chunks);
	};

	const hint = (hidden: number): TextChunk[] =>
		hidden > 0
			? [faint(`${glyph.ellipsis} +${hidden} lines ${EXPAND_HINT}`)]
			: [faint(`${glyph.ellipsis} ${EXPAND_HINT}`)];

	const summaryRows = (): TextChunk[][] => {
		const shown = output();
		const room = Math.max(1, props.width - 5);
		if (state() === "running") {
			const tail = shown.filter((line) => line.trim().length > 0).slice(-OUTPUT_LINES);
			return tail.map((line) => [faint(truncate(flatten(line), room))]);
		}
		const todos = props.item.name === "todo" ? todoRows(shown) : undefined;
		if (todos) return todos;
		// A file read is summarised by its header line (path, length, range), as Claude Code does.
		if (props.item.name === "read" && shown.length > 1)
			return [[text(truncate(shown[0]!, room))], hint(shown.length - 1)];
		const rows: TextChunk[][] = [];
		let hidden = 0;
		const summary = json();
		if (summary !== undefined) rows.push([text(summary)]);
		else {
			for (const line of shown.slice(0, OUTPUT_LINES))
				rows.push([text(truncate(line.replace(/\t/g, "  "), room))]);
			hidden += Math.max(0, shown.length - OUTPUT_LINES);
		}
		const broken = syntax();
		if (broken) rows.push([danger(`Syntax errors: ${broken}`)]);
		const parsed = diff();
		if (parsed) {
			const files = parsed.files.length;
			rows.push([
				muted(
					`${files > 1 ? `${files} files, ` : ""}${plural(parsed.added, "addition")} and ${plural(parsed.removed, "removal")}`,
				),
			]);
			const body = trimDiff(parsed.rows.filter((row) => files > 1 || row.kind !== "file"));
			for (const row of body.slice(0, DIFF_ROWS)) rows.push(diffRowChunks(row, bodyWidth()));
			hidden += Math.max(0, body.length - DIFF_ROWS);
		}
		if (hidden > 0 || (summary !== undefined && shown.length > 0)) rows.push(hint(hidden));
		return rows;
	};

	const errorRows = (): TextChunk[][] => {
		const tail = output().slice(-ERROR_TAIL_LINES);
		const hidden = output().length - tail.length;
		const rows: TextChunk[][] = [];
		for (const line of tail) rows.push([danger(line)]);
		if (hidden > 0) rows.push(hint(hidden));
		return rows;
	};

	const expandedRows = (): TextChunk[][] => {
		const rows: TextChunk[][] = [];
		const values = args();
		const parsed = diff();
		if (values) {
			// A classified shell header no longer shows the command itself, so it is listed here.
			const consumed = !kind() && (target()?.label.length ?? 0) <= labelRoom() ? (target()?.keys ?? []) : [];
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
			rows.push([muted(`${plural(parsed.added, "addition")} and ${plural(parsed.removed, "removal")}`)]);
			for (const row of trimDiff(parsed.rows)) rows.push(diffRowChunks(row, bodyWidth()));
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
