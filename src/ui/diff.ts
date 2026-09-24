/**
 * Minimal unified-diff reader. Rendering diffs by hand (rather than through
 * DiffRenderable) keeps the committed scrollback rows deterministic in height
 * and free of background fills, which is the quiet Codex-style look we want.
 */

import type { SimpleHighlight } from "@opentui/core";

export type DiffRowKind = "file" | "hunk" | "add" | "del" | "context" | "meta";

export interface DiffRow {
	kind: DiffRowKind;
	text: string;
	oldLine?: number;
	newLine?: number;
}

export interface ParsedDiff {
	rows: DiffRow[];
	added: number;
	removed: number;
	files: string[];
}

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string): ParsedDiff {
	const rows: DiffRow[] = [];
	const files: string[] = [];
	let added = 0;
	let removed = 0;
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;

	for (const raw of diff.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

		if (line.startsWith("diff --git ")) {
			inHunk = false;
			continue;
		}
		if (line.startsWith("+++ ")) {
			const path = line.slice(4).replace(/^b\//, "");
			if (path !== "/dev/null") {
				files.push(path);
				rows.push({ kind: "file", text: path });
			}
			inHunk = false;
			continue;
		}
		if (line.startsWith("--- ")) {
			inHunk = false;
			continue;
		}
		if (
			line.startsWith("index ") ||
			line.startsWith("new file mode") ||
			line.startsWith("deleted file mode") ||
			line.startsWith("similarity index") ||
			line.startsWith("rename ")
		) {
			continue;
		}

		const hunk = HUNK.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[3]);
			inHunk = true;
			if (rows.length > 0) rows.push({ kind: "hunk", text: "" });
			continue;
		}

		if (!inHunk) {
			if (line.length > 0) rows.push({ kind: "meta", text: line });
			continue;
		}

		if (line.startsWith("\\")) continue;

		const marker = line[0] ?? " ";
		const body = line.slice(1);
		if (marker === "+") {
			rows.push({ kind: "add", text: body, newLine });
			newLine += 1;
			added += 1;
		} else if (marker === "-") {
			rows.push({ kind: "del", text: body, oldLine });
			oldLine += 1;
			removed += 1;
		} else {
			rows.push({ kind: "context", text: body, oldLine, newLine });
			oldLine += 1;
			newLine += 1;
		}
	}

	while (rows.length > 0 && rows[rows.length - 1].kind === "hunk") rows.pop();
	return { rows, added, removed, files };
}

const FILE_HEADER =
	/^(?:diff --git |index |new file mode|deleted file mode|similarity index|rename |Binary files )/;

/**
 * Syntax captures for a fenced ```diff / ```patch block, which has no bundled
 * tree-sitter grammar. Headers, hunk markers and changed lines get the
 * `diff.*` captures styled in the shared syntax theme. A `---`/`+++` pair is
 * a file header; a lone `---` inside a hunk is a removed line.
 */
export function diffFenceHighlights(content: string): SimpleHighlight[] {
	const highlights: SimpleHighlight[] = [];
	const lines = content.split("\n");
	let start = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const end = start + (line.endsWith("\r") ? line.length - 1 : line.length);
		let group: string | undefined;
		if (
			FILE_HEADER.test(line) ||
			(line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) ||
			(line.startsWith("+++ ") && lines[index - 1]?.startsWith("--- "))
		)
			group = "diff.file";
		else if (line.startsWith("@@")) group = "diff.delta";
		else if (line.startsWith("+")) group = "diff.plus";
		else if (line.startsWith("-")) group = "diff.minus";
		if (group && end > start) highlights.push([start, end, group]);
		start += line.length + 1;
	}
	return highlights;
}
