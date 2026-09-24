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
				? [
						...head,
						// Output line numbers, so the gap can be read back with `sed -n FROM,TOp` on the full copy.
						`… ${omitted} line${omitted === 1 ? "" : "s"} omitted (lines ${head.length + 1}-${tailStart}) …`,
						...tail,
					].join("\n")
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

/** Past this many line edits a diff is shown as a replacement; bounds the O(D²) Myers trace. */
const MAX_EDIT_DISTANCE = 3_000;

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
	const middle =
		midBefore.length === 0 || midAfter.length === 0
			? undefined
			: myersOps(midBefore, midAfter, MAX_EDIT_DISTANCE);
	if (middle) for (const op of middle) ops.push(op);
	else {
		for (const text of midBefore) ops.push({ kind: "-", text });
		for (const text of midAfter) ops.push({ kind: "+", text });
	}
	for (const text of tail) ops.push({ kind: " ", text });
	return ops;
}

/**
 * Myers' O((N+M)·D) shortest edit script. Cost follows the size of the change,
 * not the file, so a few scattered edits in a 3,000-line file diff as a few
 * hunks instead of a whole-file replacement. Undefined past `maxDistance`
 * edits (the trace is O(D²) memory); the caller then shows a replacement.
 */
function myersOps(a: readonly string[], b: readonly string[], maxDistance: number): DiffOp[] | undefined {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		if (d > maxDistance) return undefined;
		// v for diagonals -d-1..d+1 as left by step d-1: exactly what backtracking step d reads.
		trace.push(v.slice(offset - d - 1, offset + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x =
				k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
					? v[offset + k + 1]!
					: v[offset + k - 1]! + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) return backtrack(a, b, trace);
		}
	}
	return undefined;
}

function backtrack(a: readonly string[], b: readonly string[], trace: readonly Int32Array[]): DiffOp[] {
	const reversed: DiffOp[] = [];
	let x = a.length;
	let y = b.length;
	for (let d = trace.length - 1; d >= 0; d--) {
		const snapshot = trace[d]!;
		const at = (k: number) => snapshot[k + d + 1]!;
		const k = x - y;
		const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
		const previousK = down ? k + 1 : k - 1;
		const previousX = d === 0 ? 0 : at(previousK);
		const previousY = d === 0 ? 0 : previousX - previousK;
		while (x > previousX && y > previousY) {
			reversed.push({ kind: " ", text: a[x - 1]! });
			x--;
			y--;
		}
		if (d === 0) break;
		if (down) reversed.push({ kind: "+", text: b[previousY]! });
		else reversed.push({ kind: "-", text: a[previousX]! });
		x = previousX;
		y = previousY;
	}
	return reversed.reverse();
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
