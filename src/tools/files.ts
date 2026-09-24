import { Buffer } from "node:buffer";
import { extname, posix } from "node:path";
import type { Arguments, HarnessTool, Json, ToolContext, ToolOutput } from "../contracts.ts";
import { type FileStat, readTextFile, type WorkspaceFs } from "./fs.ts";
import { commitEditPlan, type EditPlan } from "./lsp/transaction.ts";
import { isStructuredFile, readStructuredFile } from "./reader-formats.ts";
import { countLines, LINE_COUNT_LIMIT, readTextPage } from "./reader-text.ts";
import { joinText, splitText, unifiedDiff } from "./text.ts";
import {
	argBool,
	argInt,
	argOptionalString,
	argString,
	formatBytes,
	sha256Hex,
	ToolFailure,
} from "./util.ts";
import { defineTool, displayPath, type ToolEnvironment, type Workspace } from "./workspace.ts";

const IMAGE_READ_LIMIT = 5 * 1024 * 1024;
const EDIT_SIZE_LIMIT = 8 * 1024 * 1024;
const BATCH_FILE_LIMIT = 64;
const BATCH_EDIT_LIMIT = 256;
const BATCH_TOTAL_LIMIT = 64 * 1024 * 1024;
const DEFAULT_READ_LINES = 350;
const READ_PAGE_CHARS = 40_000;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

interface Resolved {
	workspace: Workspace;
	path: string;
	shown: string;
	stat: FileStat;
}

async function resolveTarget(
	environment: ToolEnvironment,
	context: ToolContext,
	input: string,
	options: { hash?: boolean } = {},
): Promise<Resolved> {
	const workspace = environment.workspace(context);
	const path = workspace.resolvePath(context.cwd, input);
	const stat = await workspace.fs.stat(path, { hash: options.hash, signal: context.signal });
	return { workspace, path, shown: displayPath(workspace.base(context.cwd), path), stat };
}

/**
 * The single gate protecting every mutation. An agent may only replace bytes it
 * has actually observed: either it read the file during this session (snapshot)
 * or it names the digest explicitly. Anything else — including a human saving
 * the file in their editor a second ago — stops the write.
 */
function assertFresh(
	environment: ToolEnvironment,
	context: ToolContext,
	target: Resolved,
	expectedHash: string | undefined,
	action: string,
): void {
	const current = target.stat.hash;
	if (current === undefined) throw new ToolFailure(`Cannot verify the contents of ${target.shown}.`);
	const snapshot = environment.freshness.get(context, target.workspace.id, target.path);
	const expected = expectedHash ?? snapshot?.hash;
	if (expected === undefined) {
		throw new ToolFailure(
			`Refusing to ${action} ${target.shown}: you have not read it in this session, so a concurrent change would be lost. Call \`read\` on it first, or pass \`expected_hash\` (current: ${current}).`,
			{ path: target.path, reason: "unread", currentHash: current },
		);
	}
	if (expected !== current) {
		throw new ToolFailure(
			`${target.shown} changed on disk since you last read it — refusing to ${action} it. Expected sha256 ${expected}, found ${current}. Re-read the file and redo the change against the new contents.`,
			{ path: target.path, reason: "stale", expectedHash: expected, currentHash: current },
		);
	}
}

async function loadEditableText(fs: WorkspaceFs, target: Resolved, signal: AbortSignal): Promise<string> {
	if (target.stat.size > EDIT_SIZE_LIMIT) {
		throw new ToolFailure(
			`${target.shown} is ${formatBytes(target.stat.size)}, too large to rewrite safely. Use \`shell\` with a streaming tool instead.`,
		);
	}
	const read = await readTextFile(fs, target.path, EDIT_SIZE_LIMIT, signal);
	if (read.binary) throw new ToolFailure(`${target.shown} is a binary file; refusing to edit it as text.`);
	if (read.truncated)
		throw new ToolFailure(`${target.shown} could not be read in full; refusing a partial rewrite.`);
	return read.text;
}

function countOccurrences(haystack: string, needle: string): number[] {
	const positions: number[] = [];
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		positions.push(index);
		index = haystack.indexOf(needle, index + needle.length);
	}
	return positions;
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset && index < text.length; index++) {
		if (text.charCodeAt(index) === 10) line++;
	}
	return line;
}

/** Every line ends in CRLF, so a model's LF-only snippet means the same lines. */
function crlfOnly(text: string): boolean {
	const lf = countOccurrences(text, "\n").length;
	return lf > 0 && countOccurrences(text, "\r\n").length === lf;
}

interface ExactReplacement {
	text: string;
	count: number;
	/** The snippet was matched after adapting its LF line breaks to the file's CRLF. */
	crlf: boolean;
}

/**
 * Shared by `edit` and `batch_edit`: one literal replacement that refuses a
 * missing or ambiguous match unless every occurrence is explicitly requested.
 * Untouched bytes (a BOM, the file's line endings) are carried over verbatim.
 */
function replaceExact(
	original: string,
	needle: string,
	replacement: string,
	all: boolean,
	where: { shown: string; path: string; label: string; oldName: string; newName: string; allName: string },
): ExactReplacement {
	if (needle.length === 0) throw new ToolFailure(`${where.label}\`${where.oldName}\` must not be empty.`);
	if (needle === replacement)
		throw new ToolFailure(`${where.label}\`${where.oldName}\` and \`${where.newName}\` are identical.`);
	let positions = countOccurrences(original, needle);
	let crlf = false;
	if (positions.length === 0 && needle.includes("\n") && !needle.includes("\r") && crlfOnly(original)) {
		const adapted = needle.replaceAll("\n", "\r\n");
		positions = countOccurrences(original, adapted);
		if (positions.length > 0) {
			crlf = true;
			needle = adapted;
			if (!replacement.includes("\r")) replacement = replacement.replaceAll("\n", "\r\n");
		}
	}
	if (positions.length === 0) {
		const collapsed = needle.replaceAll(/\s+/g, " ").trim();
		const nearby = collapsed.length > 0 && original.replaceAll(/\s+/g, " ").includes(collapsed);
		throw new ToolFailure(
			`${where.label}\`${where.oldName}\` does not appear in ${where.shown}.${nearby ? " A block with the same text but different whitespace exists — copy the exact indentation from `read`." : ""}`,
			{ path: where.path, reason: "no-match" },
		);
	}
	if (positions.length > 1 && !all) {
		const lines = positions.slice(0, 5).map((offset) => lineOf(original, offset));
		throw new ToolFailure(
			`${where.label}\`${where.oldName}\` appears ${positions.length} times in ${where.shown} (lines ${lines.join(", ")}${positions.length > lines.length ? ", …" : ""}). Include more surrounding context to make it unique, or set \`${where.allName}\`.`,
			{ path: where.path, reason: "ambiguous", occurrences: positions.length },
		);
	}
	// Literal splicing: String.replace would expand `$&`-style patterns in code.
	const text =
		positions.length === 1
			? original.slice(0, positions[0]) + replacement + original.slice(positions[0]! + needle.length)
			: original.split(needle).join(replacement);
	return { text, count: positions.length, crlf };
}

interface BatchFileRequest {
	path: string;
	expectedHash: string | undefined;
	edits: { oldText: string; newText: string; all: boolean }[];
}

function batchObject(value: unknown, where: string): Arguments {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ToolFailure(`\`${where}\` must be an object.`);
	return value as Arguments;
}

function batchString(value: unknown, where: string, optional = false): string | undefined {
	if (value === undefined || value === null) {
		if (optional) return undefined;
		throw new ToolFailure(`Missing required argument \`${where}\`.`);
	}
	if (typeof value !== "string")
		throw new ToolFailure(`\`${where}\` must be a string, received ${typeof value}.`);
	return value;
}

/** Validates the whole batch shape up front so a malformed later entry never follows a write. */
function parseBatchFiles(args: Arguments): BatchFileRequest[] {
	const files = args.files;
	if (!Array.isArray(files) || files.length === 0)
		throw new ToolFailure("`files` must be a non-empty array of {path, edits}.");
	if (files.length > BATCH_FILE_LIMIT)
		throw new ToolFailure(`A batch may change at most ${BATCH_FILE_LIMIT} files; split it.`);
	let editCount = 0;
	return files.map((value, index) => {
		const entry = batchObject(value, `files[${index}]`);
		const unknown = Object.keys(entry).filter((key) => !["path", "expected_hash", "edits"].includes(key));
		if (unknown.length)
			throw new ToolFailure(`\`files[${index}]\` has unknown field(s): ${unknown.join(", ")}.`);
		const edits = entry.edits;
		if (!Array.isArray(edits) || edits.length === 0)
			throw new ToolFailure(`\`files[${index}].edits\` must be a non-empty array of {old_text, new_text}.`);
		editCount += edits.length;
		if (editCount > BATCH_EDIT_LIMIT)
			throw new ToolFailure(`A batch may contain at most ${BATCH_EDIT_LIMIT} edits; split it.`);
		return {
			path: batchString(entry.path, `files[${index}].path`)!,
			expectedHash: batchString(entry.expected_hash, `files[${index}].expected_hash`, true),
			edits: edits.map((raw, editIndex) => {
				const where = `files[${index}].edits[${editIndex}]`;
				const edit = batchObject(raw, where);
				const extra = Object.keys(edit).filter((key) => !["old_text", "new_text", "all"].includes(key));
				if (extra.length) throw new ToolFailure(`\`${where}\` has unknown field(s): ${extra.join(", ")}.`);
				if (edit.all !== undefined && edit.all !== null && typeof edit.all !== "boolean")
					throw new ToolFailure(`\`${where}.all\` must be a boolean.`);
				return {
					oldText: batchString(edit.old_text, `${where}.old_text`)!,
					newText: batchString(edit.new_text, `${where}.new_text`)!,
					all: edit.all === true,
				};
			}),
		};
	});
}

function readPage(text: string, offset: number, column: number, limit: number) {
	const { lines } = splitText(text);
	const start = Math.min(offset - 1, lines.length);
	let line = start;
	let character = column - 1;
	if (line < lines.length && character > lines[line]!.length)
		throw new ToolFailure(`Column ${column} is beyond line ${offset}.`);
	if (
		line < lines.length &&
		character > 0 &&
		/[\uD800-\uDBFF]/.test(lines[line]![character - 1]!) &&
		/[\uDC00-\uDFFF]/.test(lines[line]![character] ?? "")
	) {
		throw new ToolFailure("The requested column splits a Unicode surrogate pair; use the preceding column.");
	}
	const end = Math.min(lines.length, start + Math.min(limit, DEFAULT_READ_LINES));
	const rows: string[] = [];
	let remaining = READ_PAGE_CHARS;
	while (line < end) {
		const value = lines[line]!;
		const prefix = `${line + 1}${character ? `:${character + 1}` : ""}\t`;
		if (remaining <= prefix.length + 2) break;
		let until = Math.min(value.length, character + remaining - prefix.length - 1);
		if (
			until < value.length &&
			/[\uD800-\uDBFF]/.test(value[until - 1] ?? "") &&
			/[\uDC00-\uDFFF]/.test(value[until] ?? "")
		)
			until--;
		const row = prefix + value.slice(character, until);
		rows.push(row);
		remaining -= row.length + 1;
		if (until < value.length) {
			character = until;
			break;
		}
		line++;
		character = 0;
	}
	const truncated = line < lines.length;
	const next = truncated ? { nextOffset: line + 1, nextColumn: character + 1 } : {};
	const footer = truncated ? `\n[continue with offset=${line + 1}, column=${character + 1}]` : "";
	return {
		text: (rows.join("\n") || "(no lines in the requested range)") + footer,
		totalLines: lines.length,
		offset: start + 1,
		column,
		shownLines: rows.length,
		truncated,
		...next,
	};
}

export function createFileTools(environment: ToolEnvironment): HarnessTool[] {
	const read = defineTool({
		name: "read",
		description:
			"Read text in streamed numbered pages, including lines beyond large prefixes. Continue with offset/column. Images are real image content. Archives list members (pass member to read one); SQLite lists schema or returns a column-name header followed by positional JSON rows (pass table or read-only query). SQLite requires Python 3.11+ on the active host and caps values/rows at 1 MiB; use length()/substr() for larger cells. PDF, DOCX and gzip/bzip2/xz text use bounded active-host readers. artifact:// results remain locally recoverable even in SSH sessions. Read before editing.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"File path, absolute or relative to the working directory, or an `artifact://…` reference.",
				},
				offset: { type: "integer", description: "First line to return, 1-based. Defaults to 1.", minimum: 1 },
				limit: {
					type: "integer",
					description: "Maximum lines to return, up to 350 per page. Defaults to 350.",
					minimum: 1,
				},
				column: {
					type: "integer",
					description:
						"First UTF-16 column within the starting line, 1-based. Defaults to 1. Use nextColumn to continue a long line.",
					minimum: 1,
				},
				member: { type: "string", description: "Exact archive member name; omit to list members." },
				table: { type: "string", description: "SQLite table/view to read; omit to list schema." },
				query: {
					type: "string",
					description:
						"Read-only SQLite SELECT; bound rows with WHERE/LIMIT and large cells with length()/substr().",
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
		async run(args, context): Promise<ToolOutput> {
			const offset = argInt(args, "offset", 1, 1, 10_000_000);
			const limit = argInt(args, "limit", DEFAULT_READ_LINES, 1, 100_000);
			const column = argInt(args, "column", 1, 1, Number.MAX_SAFE_INTEGER);
			const requested = argString(args, "path");

			// Artifacts are always stored by the harness process, never on an SSH
			// target, so this branch deliberately bypasses the workspace entirely.
			const artifactPath = environment.artifacts.resolve(requested);
			if (artifactPath !== undefined) {
				const artifact = Bun.file(artifactPath);
				if (!(await artifact.exists())) {
					return {
						text: `No such artifact: ${requested}`,
						isError: true,
						details: { path: requested, exists: false, kind: "missing" },
					};
				}
				const content = await artifact.text();
				const page = readPage(content, offset, column, limit);
				return {
					text: `${requested} — ${page.totalLines} lines, ${formatBytes(artifact.size)}\n${page.text}`,
					details: {
						path: requested,
						artifactPath,
						exists: true,
						kind: "file",
						size: artifact.size,
						totalLines: page.totalLines,
						offset: page.offset,
						column: page.column,
						shownLines: page.shownLines,
						truncated: page.truncated,
						...(page.truncated ? { nextOffset: page.nextOffset!, nextColumn: page.nextColumn! } : {}),
					},
				};
			}

			const target = await resolveTarget(environment, context, requested);
			const base: Record<string, Json> = { path: target.path, workspace: target.workspace.label };

			if (target.stat.kind === "missing") {
				return {
					text: `File not found: ${target.shown}`,
					isError: true,
					details: { ...base, exists: false, kind: "missing" },
				};
			}
			if (target.stat.kind === "dir") {
				return {
					text: `${target.shown} is a directory. Use \`list\` to see its entries or \`glob\` to match files inside it.`,
					isError: true,
					details: { ...base, exists: true, kind: "dir" },
				};
			}

			const mimeType = IMAGE_MIME_BY_EXTENSION[extname(target.path).toLowerCase()];
			if (mimeType) {
				const image = await target.workspace.fs.readBytes(target.path, IMAGE_READ_LIMIT, context.signal);
				if (image.truncated) {
					return {
						text: `${target.shown} is larger than ${formatBytes(IMAGE_READ_LIMIT)}; refusing to inline it.`,
						isError: true,
						details: { ...base, exists: true, kind: "image", size: target.stat.size, truncated: true },
					};
				}
				const summary = `${target.shown} — ${mimeType}, ${formatBytes(image.bytes.length)}`;
				return {
					text: summary,
					content: [
						{ type: "text", text: summary },
						{ type: "image", data: Buffer.from(image.bytes).toString("base64"), mimeType },
					],
					details: {
						...base,
						exists: true,
						kind: "image",
						size: target.stat.size,
						hash: target.stat.hash ?? null,
						truncated: false,
					},
				};
			}

			const structured = isStructuredFile(target.path);
			const page = structured
				? readPage(
						await readStructuredFile(target.workspace, target.path, args, context),
						offset,
						column,
						limit,
					)
				: await readTextPage(target.workspace.fs, target.path, offset, column, limit, context.signal);

			if (target.stat.hash) {
				environment.freshness.record(
					context,
					target.workspace.id,
					target.path,
					target.stat.hash,
					target.stat.size,
				);
			}

			// A paged read still states the file's length, so nobody needs `wc -l` first.
			const totalLines =
				page.totalLines ??
				(target.stat.size <= LINE_COUNT_LIMIT
					? await countLines(target.workspace.fs, target.path, context.signal)
					: undefined);
			const shown =
				page.truncated && page.shownLines > 0
					? `; showing lines ${page.offset}-${page.offset + page.shownLines - 1}`
					: "";
			const header = `${target.shown} — ${totalLines === undefined ? "streamed text" : `${totalLines} lines`}, ${formatBytes(target.stat.size)}${shown}`;
			return {
				text: `${header}\n${page.text}`,
				details: {
					...base,
					exists: true,
					kind: "file",
					size: target.stat.size,
					hash: target.stat.hash ?? null,
					...(totalLines === undefined ? {} : { totalLines }),
					offset: page.offset,
					column: page.column,
					shownLines: page.shownLines,
					truncated: page.truncated,
					...(page.truncated ? { nextOffset: page.nextOffset!, nextColumn: page.nextColumn! } : {}),
				},
			};
		},
	});

	const list = defineTool({
		name: "list",
		description:
			'List directory entries in the active workspace (the SSH target when the session is remote). Directories are suffixed with "/". Prefer `glob` when you already know the filename shape you want.',
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory to list. Defaults to the working directory." },
				depth: {
					type: "integer",
					description: "How many levels to descend. Defaults to 2.",
					minimum: 1,
					maximum: 8,
				},
				hidden: { type: "boolean", description: "Include dot-files and dot-directories. Defaults to false." },
			},
			required: [],
			additionalProperties: false,
		},
		async run(args, context): Promise<ToolOutput> {
			const depth = argInt(args, "depth", 2, 1, 8);
			const hidden = argBool(args, "hidden", false);
			const target = await resolveTarget(environment, context, argOptionalString(args, "path") ?? ".", {
				hash: false,
			});
			if (target.stat.kind === "missing") {
				return {
					text: `Directory not found: ${target.shown}`,
					isError: true,
					details: { path: target.path, exists: false },
				};
			}
			if (target.stat.kind !== "dir") {
				return {
					text: `${target.shown} is not a directory.`,
					isError: true,
					details: { path: target.path, kind: target.stat.kind },
				};
			}
			const entries = await target.workspace.fs.list(target.path, depth, hidden, context.signal);
			entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
			const rendered = entries
				.map((entry) => `${posix.relative(target.path, entry.path)}${entry.kind === "dir" ? "/" : ""}`)
				.join("\n");
			const bounded = await environment.artifacts.bound(rendered || "(empty directory)", {
				sessionId: context.sessionId,
				label: "list",
			});
			return {
				text: `${target.shown} — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}\n${bounded.text}`,
				details: {
					path: target.path,
					workspace: target.workspace.label,
					count: entries.length,
					truncated: bounded.clipped,
					...(bounded.artifact ? { artifact: bounded.artifact } : {}),
				},
			};
		},
	});

	const write = defineTool({
		name: "write",
		description:
			"Create a file, or replace an existing file in full, in the active workspace. Writes are atomic. Replacing an existing file requires that you have read it in this session (or pass `expected_hash`) so a concurrent change is never silently discarded. Prefer `edit` for changes to part of a file.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path, absolute or relative to the working directory." },
				content: { type: "string", description: "Complete new contents of the file." },
				expected_hash: {
					type: "string",
					description:
						"sha256 the file must currently have. Only needed when you did not read the file in this session.",
				},
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		async run(args, context): Promise<ToolOutput> {
			const content = argString(args, "content");
			const target = await resolveTarget(environment, context, argString(args, "path"));
			if (target.stat.kind === "dir") throw new ToolFailure(`${target.shown} is a directory.`);
			if (target.stat.kind === "other") throw new ToolFailure(`${target.shown} is not a regular file.`);

			const existed = target.stat.kind === "file";
			let previous: string | undefined;
			if (existed) {
				assertFresh(environment, context, target, argOptionalString(args, "expected_hash"), "overwrite");
				// Only needed for the diff. A binary or oversized predecessor is a
				// perfectly legal thing to overwrite — it just has no useful diff.
				const before = await readTextFile(target.workspace.fs, target.path, EDIT_SIZE_LIMIT, context.signal);
				if (!before.binary && !before.truncated) previous = before.text;
			}
			if (previous === content) {
				return {
					text: `${target.shown} already has exactly this content; nothing written.`,
					details: { path: target.path, changed: false },
				};
			}

			const hash = await target.workspace.fs.write(
				target.path,
				content,
				context.signal,
				existed ? target.stat.hash! : null,
			);
			environment.freshness.record(
				context,
				target.workspace.id,
				target.path,
				hash,
				Buffer.byteLength(content),
			);
			const diff = previous === undefined ? "" : unifiedDiff(previous, content, target.shown);
			const lineCount = splitText(content).lines.length;
			return {
				text: `${existed ? "Updated" : "Created"} ${target.shown} — ${lineCount} lines, ${formatBytes(Buffer.byteLength(content))}`,
				diff: diff || undefined,
				details: {
					path: target.path,
					workspace: target.workspace.label,
					created: !existed,
					changed: true,
					hash,
					lines: lineCount,
				},
			};
		},
	});

	const edit = defineTool({
		name: "edit",
		description:
			"Change part of an existing file in the active workspace. Two forms: exact replacement (`old_string` -> `new_string`), or line-anchored replacement (`start_line`/`end_line` -> `new_string`, 1-based and inclusive). Exact replacement refuses ambiguous matches unless `replace_all` is set. You must have read the file in this session; the edit is rejected if it changed on disk since. Returns a unified diff.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path, absolute or relative to the working directory." },
				old_string: {
					type: "string",
					description:
						"Exact text to replace, including indentation. Must match exactly once unless `replace_all` is true. Omit when using start_line/end_line.",
				},
				new_string: {
					type: "string",
					description: "Replacement text. Use an empty string to delete the matched text or lines.",
				},
				replace_all: {
					type: "boolean",
					description:
						"Replace every occurrence of `old_string` instead of requiring a unique match. Defaults to false.",
				},
				start_line: {
					type: "integer",
					description:
						"First line to replace, 1-based and inclusive. Use with `end_line` instead of `old_string`.",
					minimum: 1,
				},
				end_line: {
					type: "integer",
					description: "Last line to replace, 1-based and inclusive.",
					minimum: 1,
				},
				expected_hash: {
					type: "string",
					description:
						"sha256 the file must currently have. Only needed when you did not read the file in this session.",
				},
			},
			required: ["path", "new_string"],
			additionalProperties: false,
		},
		async run(args, context): Promise<ToolOutput> {
			const replacement = argString(args, "new_string");
			const oldString = argOptionalString(args, "old_string");
			const hasLines = args.start_line !== undefined || args.end_line !== undefined;
			if (oldString !== undefined && hasLines) {
				throw new ToolFailure("Use either `old_string` or `start_line`/`end_line`, not both.");
			}
			if (oldString === undefined && !hasLines) {
				throw new ToolFailure(
					"Provide `old_string` for an exact replacement, or `start_line` and `end_line` for a line-anchored one.",
				);
			}

			const target = await resolveTarget(environment, context, argString(args, "path"));
			if (target.stat.kind === "missing") {
				throw new ToolFailure(`File not found: ${target.shown}. Use \`write\` to create it.`);
			}
			if (target.stat.kind !== "file") throw new ToolFailure(`${target.shown} is not a regular file.`);
			assertFresh(environment, context, target, argOptionalString(args, "expected_hash"), "edit");

			const original = await loadEditableText(target.workspace.fs, target, context.signal);
			let updated: string;
			let summary: string;

			if (oldString !== undefined) {
				const replaced = replaceExact(original, oldString, replacement, argBool(args, "replace_all", false), {
					shown: target.shown,
					path: target.path,
					label: "",
					oldName: "old_string",
					newName: "new_string",
					allName: "replace_all",
				});
				updated = replaced.text;
				summary = `${replaced.count === 1 ? "1 replacement" : `${replaced.count} replacements`} in ${target.shown}${replaced.crlf ? " (matched with the file's CRLF line endings)" : ""}`;
			} else {
				const source = splitText(original);
				if (source.lines.length === 0)
					throw new ToolFailure(`${target.shown} is empty; use \`write\` instead.`);
				if (args.start_line === undefined || args.end_line === undefined) {
					throw new ToolFailure("A line-anchored edit needs both `start_line` and `end_line`.");
				}
				const startLine = argInt(args, "start_line", 1, 1, source.lines.length);
				const endLine = argInt(args, "end_line", 1, 1, source.lines.length);
				if (endLine < startLine)
					throw new ToolFailure(`\`end_line\` (${endLine}) is before \`start_line\` (${startLine}).`);
				const inserted = replacement === "" ? [] : splitText(replacement).lines;
				const next = [...source.lines.slice(0, startLine - 1), ...inserted, ...source.lines.slice(endLine)];
				// The file keeps whatever end-of-file style it already had; an edit to
				// some lines is never an excuse to add or drop a trailing newline.
				updated = joinText(next, source.noEol);
				summary = `lines ${startLine}-${endLine} of ${target.shown} replaced with ${inserted.length} line${inserted.length === 1 ? "" : "s"}`;
			}

			if (updated === original) throw new ToolFailure(`The edit would not change ${target.shown}.`);
			const hash = await target.workspace.fs.write(target.path, updated, context.signal, target.stat.hash!);
			environment.freshness.record(
				context,
				target.workspace.id,
				target.path,
				hash,
				Buffer.byteLength(updated),
			);
			const diff = unifiedDiff(original, updated, target.shown);
			return {
				text: `Edited ${summary}`,
				diff: diff || undefined,
				details: {
					path: target.path,
					workspace: target.workspace.label,
					hash,
					lines: splitText(updated).lines.length,
				},
			};
		},
	});

	const batchEdit = defineTool({
		name: "batch_edit",
		description:
			"Apply exact old_text -> new_text replacements to one or more existing files in one call. Each file's edits run in order against the result of the previous edit; every old_text must match exactly once unless `all` is set. Every file is read, verified fresh (read in this session or `expected_hash`) and fully simulated before anything is written, so any missing, ambiguous, duplicate or stale change rejects the whole batch with no writes. Writes are then committed in order with conditional rollback. Untouched bytes (BOM, line endings) are preserved; LF-only snippets match CRLF files. Use `write`/file operations to create, move or delete files. Returns one combined unified diff.",
		parameters: {
			type: "object",
			properties: {
				files: {
					type: "array",
					minItems: 1,
					maxItems: BATCH_FILE_LIMIT,
					description: "Files to change; each path may appear only once.",
					items: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "Existing file path, absolute or relative to the working directory.",
							},
							expected_hash: {
								type: "string",
								description:
									"sha256 the file must currently have. Only needed when you did not read the file in this session.",
							},
							edits: {
								type: "array",
								minItems: 1,
								description: "Replacements applied in order to this file.",
								items: {
									type: "object",
									properties: {
										old_text: {
											type: "string",
											description:
												"Exact text to replace, including indentation, matched against the file as changed by earlier edits in this entry.",
										},
										new_text: {
											type: "string",
											description: "Replacement text; empty string deletes the match.",
										},
										all: {
											type: "boolean",
											description:
												"Replace every occurrence instead of requiring a unique match. Defaults to false.",
										},
									},
									required: ["old_text", "new_text"],
									additionalProperties: false,
								},
							},
						},
						required: ["path", "edits"],
						additionalProperties: false,
					},
				},
			},
			required: ["files"],
			additionalProperties: false,
		},
		async run(args, context): Promise<ToolOutput> {
			const requests = parseBatchFiles(args);
			const failures: Record<string, Json>[] = [];
			const prepared: {
				target: Resolved;
				before: string;
				after: string;
				replacements: number;
				crlf: boolean;
			}[] = [];
			const seen = new Map<string, number>();
			let total = 0;
			let workspace: Workspace | undefined;
			// Preflight everything and collect every problem: nothing is written
			// unless every file resolves, is fresh and every edit applies.
			for (const [index, request] of requests.entries()) {
				try {
					const target = await resolveTarget(environment, context, request.path);
					workspace = target.workspace;
					const earlier = seen.get(target.path);
					if (earlier !== undefined)
						throw new ToolFailure(
							`files[${index}] names ${target.shown} again (already files[${earlier}]); put all of a file's edits in one entry, in order.`,
							{ path: target.path, reason: "duplicate" },
						);
					seen.set(target.path, index);
					if (target.stat.kind === "missing")
						throw new ToolFailure(`File not found: ${target.shown}. Use \`write\` to create it.`, {
							path: target.path,
							reason: "missing",
						});
					if (target.stat.kind !== "file" || target.stat.symlink)
						throw new ToolFailure(
							`${target.shown} is not a regular file${target.stat.symlink ? " (it is a symbolic link; edit its target path)" : ""}.`,
							{ path: target.path, reason: "not-file" },
						);
					assertFresh(environment, context, target, request.expectedHash, "edit");
					const before = await loadEditableText(target.workspace.fs, target, context.signal);
					if (sha256Hex(before) !== target.stat.hash)
						throw new ToolFailure(`${target.shown} changed while the batch was being prepared.`, {
							path: target.path,
							reason: "stale",
						});
					let after = before;
					let replacements = 0;
					let crlf = false;
					for (const [editIndex, edit] of request.edits.entries()) {
						const replaced = replaceExact(after, edit.oldText, edit.newText, edit.all, {
							shown: target.shown,
							path: target.path,
							label: `files[${index}].edits[${editIndex}]: `,
							oldName: "old_text",
							newName: "new_text",
							allName: "all",
						});
						after = replaced.text;
						replacements += replaced.count;
						crlf ||= replaced.crlf;
					}
					if (after === before)
						throw new ToolFailure(`files[${index}]: the edits would not change ${target.shown}.`, {
							path: target.path,
							reason: "no-change",
						});
					const size = Buffer.byteLength(after);
					if (size > EDIT_SIZE_LIMIT)
						throw new ToolFailure(
							`files[${index}]: ${target.shown} would grow to ${formatBytes(size)}, over the ${formatBytes(EDIT_SIZE_LIMIT)} edit limit.`,
							{ path: target.path, reason: "too-large" },
						);
					total += target.stat.size + size;
					if (total > BATCH_TOTAL_LIMIT)
						throw new ToolFailure(
							`The batch exceeds ${formatBytes(BATCH_TOTAL_LIMIT)} of file content; split it into smaller batches.`,
							{ path: target.path, reason: "too-large" },
						);
					prepared.push({ target, before, after, replacements, crlf });
				} catch (error) {
					if (!(error instanceof ToolFailure)) throw error;
					failures.push({
						file: index,
						path: request.path,
						message: error.message,
						...(error.details === undefined ? {} : { details: error.details }),
					});
				}
			}
			if (failures.length > 0) {
				throw new ToolFailure(
					`batch_edit rejected before any write; no files changed.\n${failures.map((failure) => `- files[${failure.file}] ${failure.path}: ${failure.message}`).join("\n")}`,
					{ changed: false, failures },
				);
			}
			const plan: EditPlan = { initial: new Map(), steps: [] };
			for (const file of prepared) {
				plan.initial.set(file.target.path, file.before);
				plan.steps.push({ path: file.target.path, before: file.before, after: file.after });
			}
			const changedPaths = prepared.map((file) => file.target.path);
			try {
				// Re-verifies every original hash, then writes with CAS and rolls
				// back completed files conditionally on a later failure.
				await commitEditPlan(environment, workspace!, context, plan);
			} catch (error) {
				if (!(error instanceof ToolFailure)) throw error;
				const details =
					error.details && typeof error.details === "object" && !Array.isArray(error.details)
						? error.details
						: {};
				throw new ToolFailure(`batch_edit: ${error.message}`, { ...details, paths: changedPaths });
			}
			const files = prepared.map((file) => ({
				path: file.target.path,
				replacements: file.replacements,
				hash: sha256Hex(file.after),
				lines: splitText(file.after).lines.length,
				...(file.crlf ? { crlf: true } : {}),
			}));
			const diff = prepared.map((file) => unifiedDiff(file.before, file.after, file.target.shown)).join("");
			return {
				text: `Edited ${prepared.length} file${prepared.length === 1 ? "" : "s"}:\n${prepared.map((file) => `${file.target.shown} — ${file.replacements} replacement${file.replacements === 1 ? "" : "s"}${file.crlf ? " (matched with CRLF line endings)" : ""}, sha256 ${sha256Hex(file.after)}`).join("\n")}`,
				diff: diff || undefined,
				details: { workspace: workspace!.label, changed: true, changedPaths, files },
			};
		},
	});

	return [read, list, write, edit, batchEdit];
}

/**
 * Image viewing without the rest of `read`, for restricted tool sets whose text reading goes
 * through the shell: the shell can only return text, so this is what shows the model a picture.
 */
export function createViewImageTool(read: HarnessTool): HarnessTool {
	const extensions = Object.keys(IMAGE_MIME_BY_EXTENSION);
	return {
		name: "view_image",
		description: `Show an image file to you as real image content (${extensions.join(", ")}), such as a screenshot or diagram.`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Image path, absolute or relative to the working directory." },
			},
			required: ["path"],
			additionalProperties: false,
		},
		async execute(args, context): Promise<ToolOutput> {
			const path = typeof args.path === "string" ? args.path : "";
			if (!IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()])
				return { text: `view_image only shows ${extensions.join(", ")} files.`, isError: true };
			return read.execute({ path }, context);
		},
	};
}
