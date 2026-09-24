/** Line-level text handling shared by read, write, edit and the search tools. */

export interface SplitText {
	lines: string[];
	/** True when the source did not end with a newline, so diffs can say so. */
	noEol: boolean;
}

export function splitText(text: string): SplitText {
	if (text.length === 0) return { lines: [], noEol: false };
	const noEol = !text.endsWith("\n");
	const body = noEol ? text : text.slice(0, -1);
	return { lines: body.split("\n"), noEol };
}

export function joinText(lines: readonly string[], noEol: boolean): string {
	if (lines.length === 0) return "";
	return noEol ? lines.join("\n") : `${lines.join("\n")}\n`;
}

/**
 * Renders a slice of a file with 1-based line numbers, clipping pathological
 * single lines (minified bundles) so one line cannot blow the whole budget.
 */
export function numberLines(lines: readonly string[], firstLineNumber: number, maxLineWidth = 2000): string {
	const width = String(firstLineNumber + lines.length - 1).length;
	const out: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const raw = lines[index] ?? "";
		const shown =
			raw.length > maxLineWidth
				? `${raw.slice(0, maxLineWidth)}… (+${raw.length - maxLineWidth} chars)`
				: raw;
		out.push(`${String(firstLineNumber + index).padStart(width, " ")}\t${shown}`);
	}
	return out.join("\n");
}

export interface ClipResult {
	text: string;
	clipped: boolean;
	totalLines: number;
	shownLines: number;
}

/**
 * Head/tail excerpt used whenever a rendered result exceeds the model budget.
 * The omitted middle is always described, never silently dropped.
 */
export function clipText(text: string, maxLines: number, maxChars: number): ClipResult {
	const lines = text.length === 0 ? [] : text.split("\n");
	if (lines.length <= maxLines && text.length <= maxChars) {
		return { text, clipped: false, totalLines: lines.length, shownLines: lines.length };
	}
	let headCount = Math.max(1, Math.floor(maxLines * 0.7));
	let tailCount = Math.max(0, maxLines - headCount - 1);
	let rendered = "";
	let shownLines = 0;
	for (;;) {
		const head = lines.slice(0, Math.min(headCount, lines.length));
		const tailStart = Math.max(head.length, lines.length - tailCount);
		const tail = lines.slice(tailStart);
		const omitted = tailStart - head.length;
		rendered =
			omitted > 0
				? [...head, `… ${omitted} line${omitted === 1 ? "" : "s"} omitted …`, ...tail].join("\n")
				: [...head, ...tail].join("\n");
		shownLines = head.length + tail.length;
		if (rendered.length <= maxChars || headCount <= 1) break;
		headCount = Math.max(1, Math.floor(headCount * 0.7));
		tailCount = Math.floor(tailCount * 0.7);
	}
	if (rendered.length > maxChars) rendered = `${rendered.slice(0, maxChars)}…`;
	return { text: rendered, clipped: true, totalLines: lines.length, shownLines };
}

const NUL = 0;

/** Same heuristic ripgrep and git use: a NUL byte in the head means binary. */
export function looksBinary(bytes: Uint8Array): boolean {
	const limit = Math.min(bytes.length, 8192);
	for (let index = 0; index < limit; index++) {
		if (bytes[index] === NUL) return true;
	}
	return false;
}

interface DiffOp {
	kind: " " | "-" | "+";
	text: string;
}

const MAX_LCS_CELLS = 4_000_000;

function diffOps(before: readonly string[], after: readonly string[]): DiffOp[] {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let end = 0;
	while (
		end < before.length - start &&
		end < after.length - start &&
		before[before.length - 1 - end] === after[after.length - 1 - end]
	) {
		end++;
	}
	const head = before.slice(0, start);
	const tail = before.slice(before.length - end);
	const midBefore = before.slice(start, before.length - end);
	const midAfter = after.slice(start, after.length - end);

	const ops: DiffOp[] = head.map((text) => ({ kind: " " as const, text }));
	if (midBefore.length === 0 || midAfter.length === 0 || midBefore.length * midAfter.length > MAX_LCS_CELLS) {
		for (const text of midBefore) ops.push({ kind: "-", text });
		for (const text of midAfter) ops.push({ kind: "+", text });
	} else {
		const rows = midBefore.length + 1;
		const cols = midAfter.length + 1;
		const table = new Int32Array(rows * cols);
		for (let i = midBefore.length - 1; i >= 0; i--) {
			for (let j = midAfter.length - 1; j >= 0; j--) {
				table[i * cols + j] =
					midBefore[i] === midAfter[j]
						? table[(i + 1) * cols + j + 1]! + 1
						: Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
			}
		}
		let i = 0;
		let j = 0;
		while (i < midBefore.length && j < midAfter.length) {
			if (midBefore[i] === midAfter[j]) {
				ops.push({ kind: " ", text: midBefore[i]! });
				i++;
				j++;
			} else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
				ops.push({ kind: "-", text: midBefore[i]! });
				i++;
			} else {
				ops.push({ kind: "+", text: midAfter[j]! });
				j++;
			}
		}
		while (i < midBefore.length) ops.push({ kind: "-", text: midBefore[i++]! });
		while (j < midAfter.length) ops.push({ kind: "+", text: midAfter[j++]! });
	}
	for (const text of tail) ops.push({ kind: " ", text });
	return ops;
}

/**
 * Unified diff for the UI's diff pane. Contains real hunk headers so the
 * output is also a valid patch a human can apply by hand.
 */
export function unifiedDiff(
	beforeText: string,
	afterText: string,
	beforePath: string,
	afterPath: string = beforePath,
	context = 3,
): string {
	const before = splitText(beforeText);
	const after = splitText(afterText);
	const ops = diffOps(before.lines, after.lines);
	if (!ops.some((op) => op.kind !== " ")) return "";

	const changed: number[] = [];
	for (let index = 0; index < ops.length; index++) {
		if (ops[index]!.kind !== " ") changed.push(index);
	}
	const groups: Array<{ from: number; to: number }> = [];
	for (const index of changed) {
		const from = Math.max(0, index - context);
		const to = Math.min(ops.length - 1, index + context);
		const last = groups[groups.length - 1];
		if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
		else groups.push({ from, to });
	}

	const out = [`--- a/${beforePath.replace(/^\/+/, "")}`, `+++ b/${afterPath.replace(/^\/+/, "")}`];
	let beforeLine = 1;
	let afterLine = 1;
	let cursor = 0;
	for (const group of groups) {
		while (cursor < group.from) {
			const op = ops[cursor]!;
			if (op.kind !== "+") beforeLine++;
			if (op.kind !== "-") afterLine++;
			cursor++;
		}
		let beforeCount = 0;
		let afterCount = 0;
		const body: string[] = [];
		for (let index = group.from; index <= group.to; index++) {
			const op = ops[index]!;
			if (op.kind !== "+") beforeCount++;
			if (op.kind !== "-") afterCount++;
			body.push(`${op.kind}${op.text}`);
			const isLastBefore = op.kind !== "+" && beforeLine + beforeCount - 1 === before.lines.length;
			const isLastAfter = op.kind !== "-" && afterLine + afterCount - 1 === after.lines.length;
			if (
				(op.kind === "-" && before.noEol && isLastBefore) ||
				(op.kind === "+" && after.noEol && isLastAfter)
			) {
				body.push("\\ No newline at end of file");
			}
		}
		out.push(
			`@@ -${beforeCount === 0 ? beforeLine - 1 : beforeLine},${beforeCount} +${afterCount === 0 ? afterLine - 1 : afterLine},${afterCount} @@`,
		);
		out.push(...body);
		beforeLine += beforeCount;
		afterLine += afterCount;
		cursor = group.to + 1;
	}
	return `${out.join("\n")}\n`;
}

/** 1-based line/column of a UTF-16 offset, for reporting where a match landed. */
export function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lineStart = 0;
	for (let index = 0; index < offset && index < text.length; index++) {
		if (text.charCodeAt(index) === 10) {
			line++;
			lineStart = index + 1;
		}
	}
	return { line, column: offset - lineStart + 1 };
}
