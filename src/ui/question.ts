import type { TextChunk } from "@opentui/core";
import { StyledText } from "@opentui/core";
import type { UserQuestion } from "../contracts.ts";
import { flatten, truncate, wrapText } from "./text.ts";
import { accent, bold, faint, glyph, muted, plain, text, user } from "./theme.ts";

/** Keyboard state for the question being answered: focused option and, for multi-select, the ticked ones. */
export interface QuestionCursor {
	focus: number;
	picked: readonly number[];
}

/**
 * The answer Enter commits. Typed text always wins for single answers and is
 * appended to ticked options for multi-select; otherwise the focused option
 * answers a single-choice question. A hint explains what is still missing.
 */
export function resolveAnswer(
	question: UserQuestion,
	cursor: QuestionCursor,
	typed: string,
): { answer: string | string[] } | { hint: string } {
	const own = typed.trim();
	const options = question.options ?? [];
	if (question.multi) {
		const values = [...cursor.picked]
			.sort((left, right) => left - right)
			.flatMap((index) => (options[index] ? [options[index].label] : []));
		if (own.length > 0) values.push(own);
		return values.length > 0
			? { answer: values }
			: { hint: options.length > 0 ? "space ticks options, or type an answer" : "type an answer" };
	}
	if (own.length > 0) return { answer: own };
	const focused = options[cursor.focus];
	return focused ? { answer: focused.label } : { hint: "type an answer" };
}

/** Heading hint naming the keys that act on this question. */
export function questionKeys(question: UserQuestion): string {
	if (!question.options?.length) return "type an answer · enter send · esc cancel";
	return question.multi
		? "↑↓ move · space tick · type to add · enter send · esc cancel"
		: "↑↓ choose · or type your own · enter send · esc cancel";
}

/**
 * The question and its options, fitted into `maxRows`: the question wraps and
 * keeps every row it can while leaving room for up to three options; the
 * option list is windowed so the focused option stays visible. A clipped
 * question ends in an ellipsis.
 */
export function buildQuestionText(
	question: UserQuestion,
	cursor: QuestionCursor,
	width: number,
	maxRows: number,
): StyledText {
	const options = question.options ?? [];
	const rows = Math.max(1, maxRows);
	const prompt = wrapText(question.question, width);
	const promptRows = Math.min(prompt.length, Math.max(1, rows - Math.min(options.length, 3)));
	const optionRows = Math.min(options.length, rows - promptRows);
	const chunks: TextChunk[] = [];
	for (let index = 0; index < promptRows; index += 1) {
		if (index > 0) chunks.push(plain("\n"));
		const clipped = index === promptRows - 1 && promptRows < prompt.length;
		chunks.push(
			user(clipped ? `${prompt[index]!.slice(0, Math.max(0, width - 1))}${glyph.ellipsis}` : prompt[index]!),
		);
	}
	const first = Math.min(
		Math.max(0, cursor.focus - optionRows + 1),
		Math.max(0, options.length - optionRows),
	);
	for (let index = first; index < first + optionRows; index += 1) {
		const option = options[index]!;
		const focused = index === cursor.focus;
		const ticked = cursor.picked.includes(index);
		const tick = question.multi ? (ticked ? "[x] " : "[ ] ") : "";
		const label = truncate(option.label, Math.max(1, width - 2 - tick.length));
		chunks.push(plain("\n"), focused ? accent(`${glyph.caret} `) : plain("  "));
		if (tick) chunks.push(ticked ? accent(tick) : muted(tick));
		chunks.push(focused ? bold(accent(label)) : text(label));
		const room = width - 2 - tick.length - label.length - 3;
		if (option.description && room > 4)
			chunks.push(faint(` ${glyph.sep} ${truncate(flatten(option.description), room)}`));
	}
	return new StyledText(chunks);
}
