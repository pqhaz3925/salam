import type { WorkspaceFs } from "./fs.ts";
import { ToolFailure } from "./util.ts";

/** Scan bounded chunks, discarding the prefix rather than retaining it in memory. */
export async function readTextPage(
	fs: WorkspaceFs,
	path: string,
	offset: number,
	column: number,
	limit: number,
	signal: AbortSignal,
) {
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const rows: string[] = [];
	let byteOffset = 0;
	let line = 1;
	let character = 1;
	let remaining = 40_000;
	let row = "";
	let rowColumn = column;
	let started = false;
	let endedWithNewline = false;
	const finish = () => {
		rows.push(`${line}${rowColumn > 1 ? `:${rowColumn}` : ""}\t${row}`);
		row = "";
	};
	const result = (truncated: boolean) => ({
		text:
			(rows.join("\n") || "(no lines in the requested range)") +
			(truncated ? `\n[continue with offset=${line}, column=${character}]` : ""),
		offset,
		column,
		shownLines: rows.length,
		truncated,
		nextOffset: truncated ? line : undefined,
		nextColumn: truncated ? character : undefined,
		totalLines: truncated ? undefined : byteOffset === 0 ? 0 : endedWithNewline ? line - 1 : line,
	});
	for (;;) {
		signal.throwIfAborted();
		const chunk = await fs.readBytes(path, 64 * 1024, signal, byteOffset);
		byteOffset += chunk.bytes.length;
		let text: string;
		try {
			text = decoder.decode(chunk.bytes, { stream: chunk.truncated });
		} catch {
			throw new ToolFailure(`${path} is not valid UTF-8 text; use a supported document reader.`);
		}
		if (text.includes("\0")) throw new ToolFailure(`${path} is a binary file.`);
		for (const value of text) {
			if (line < offset) {
				endedWithNewline = value === "\n";
				if (value === "\n") {
					line++;
					character = 1;
				}
				continue;
			}
			if (line === offset && character < column) {
				if (value === "\n") throw new ToolFailure(`Column ${column} is beyond line ${offset}.`);
				character += value.length;
				if (character > column)
					throw new ToolFailure("The requested column splits a Unicode surrogate pair.");
				continue;
			}
			if (!started) {
				remaining -= String(line).length + String(rowColumn).length + 3;
				started = true;
			}
			if (remaining < value.length || rows.length >= Math.min(limit, 350)) {
				if (row) finish();
				return result(true);
			}
			endedWithNewline = value === "\n";
			if (value === "\n") {
				if (row.endsWith("\r")) row = row.slice(0, -1);
				finish();
				line++;
				character = 1;
				rowColumn = 1;
				started = false;
			} else {
				row += value;
				character += value.length;
			}
			remaining -= value.length;
		}
		if (!chunk.truncated) {
			if (line === offset && character < column)
				throw new ToolFailure(`Column ${column} is beyond line ${offset}.`);
			if (row || (started && !endedWithNewline)) finish();
			return result(false);
		}
		if (!chunk.bytes.length) throw new ToolFailure(`Reading ${path} made no progress.`);
	}
}
