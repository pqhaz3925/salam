import { StyledText } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import type { TodoItem } from "../contracts.ts";
import { accent, bold, danger, faint, glyph, muted, ok, plain, text, warn } from "./theme.ts";
import { truncate, wrapText } from "./text.ts";

type Tone = (value: string) => TextChunk;

const MARKERS: Record<TodoItem["status"], { glyph: string; tone: Tone }> = {
	completed: { glyph: glyph.tool, tone: ok },
	in_progress: { glyph: glyph.todoActive, tone: warn },
	pending: { glyph: glyph.toolRunning, tone: faint },
	blocked: { glyph: glyph.todoBlocked, tone: danger },
	abandoned: { glyph: glyph.todoAbandoned, tone: faint },
};

export interface TodoProgress {
	/** Completed items. */
	done: number;
	/** Items still counted toward the plan: everything except abandoned ones. */
	total: number;
	blocked: number;
	/** The in-progress item, else the next pending one, else the first blocked one. */
	current: TodoItem;
}

/** Progress of a todo list, or undefined once nothing is left to do (so no row is spent on it). */
export function todoProgress(todos: readonly TodoItem[] | undefined): TodoProgress | undefined {
	if (!todos) return undefined;
	let done = 0;
	let total = 0;
	let blocked = 0;
	let active: TodoItem | undefined;
	let pending: TodoItem | undefined;
	let firstBlocked: TodoItem | undefined;
	for (const item of todos) {
		if (item.status === "abandoned") continue;
		total += 1;
		if (item.status === "completed") done += 1;
		else if (item.status === "in_progress") active ??= item;
		else if (item.status === "pending") pending ??= item;
		else {
			blocked += 1;
			firstBlocked ??= item;
		}
	}
	const current = active ?? pending ?? firstBlocked;
	return current ? { done, total, blocked, current } : undefined;
}

/** One status row above the composer: `todo 2/5 · ◐ current item · 1 blocked`. */
export function buildTodoLine(progress: TodoProgress, width: number): StyledText {
	const count = `todo ${progress.done}/${progress.total}`;
	const current = progress.current;
	const marker = MARKERS[current.status];
	const prefix = current.status === "pending" ? "next: " : current.status === "blocked" ? "blocked: " : "";
	const blocked =
		progress.blocked > 0 && current.status !== "blocked" ? ` ${glyph.sep} ${progress.blocked} blocked` : "";
	const room = width - count.length - blocked.length - 5;
	const chunks: TextChunk[] = [accent(truncate(count, width))];
	if (room > 0)
		chunks.push(
			faint(` ${glyph.sep} `),
			marker.tone(marker.glyph),
			plain(" "),
			text(truncate(prefix + current.content, room)),
		);
	if (blocked.length > 0 && count.length + blocked.length <= width) chunks.push(warn(blocked));
	return new StyledText(chunks);
}

/**
 * The full list for `/todo`, pre-wrapped to `width` so the overlay can window
 * rows exactly: phase headings, a status marker per item with a hanging
 * indent, and the reason under blocked or abandoned items.
 */
export function buildTodoRows(todos: readonly TodoItem[], width: number): TextChunk[][] {
	if (todos.length === 0) return [[faint("  no todos")]];
	const rows: TextChunk[][] = [];
	const body = Math.max(1, width - 4);
	let phase: string | undefined;
	for (const item of todos) {
		if (item.phase !== undefined && item.phase !== phase) {
			for (const line of wrapText(item.phase, Math.max(1, width - 2)))
				rows.push([plain("  "), bold(muted(line))]);
		}
		phase = item.phase;
		const marker = MARKERS[item.status];
		const tone = item.status === "completed" || item.status === "abandoned" ? muted : text;
		wrapText(item.content, body).forEach((line, index) => {
			rows.push(
				index === 0
					? [plain("  "), marker.tone(marker.glyph), plain(" "), tone(line)]
					: [plain("    "), tone(line)],
			);
		});
		if (item.reason) for (const line of wrapText(item.reason, body)) rows.push([plain("    "), faint(line)]);
	}
	return rows;
}
