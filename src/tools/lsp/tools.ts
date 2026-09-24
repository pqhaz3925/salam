import { AsyncResource } from "node:async_hooks";
import type { Arguments, HarnessTool, ToolContext, ToolOutput } from "../../contracts.ts";
import { readTextFile } from "../fs.ts";
import { SEARCH_PAGE_PROPERTIES, searchPage } from "../search.ts";
import { splitText, unifiedDiff } from "../text.ts";
import { argInt, argOptionalString, argString, randomToken, sha256Hex, ToolFailure } from "../util.ts";
import { defineTool, displayPath, type ToolEnvironment, type Workspace } from "../workspace.ts";
import {
	type CallDirection,
	type CallHierarchyItem,
	type Diagnostic,
	type ExternalChange,
	FILE_CHANGED,
	FILE_CREATED,
	FILE_DELETED,
	type Location,
	type LocationLink,
	type LspClient,
	type Position,
	type Range,
	type WorkspaceEdit,
} from "./client.ts";
import {
	LspManager,
	type LspSession,
	languageIdForPath,
	MAX_DOCUMENT_BYTES,
	type OpenedDocument,
	pathToUri,
	type ScanCache,
	uriToPath,
} from "./manager.ts";
import { commitEditPlan, type EditPlan, planWorkspaceEdit, rollbackEdits } from "./transaction.ts";

const SEVERITY_NAME: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
const SYMBOL_KIND_NAME: Record<number, string> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enum member",
	23: "struct",
	24: "event",
	25: "operator",
	26: "type parameter",
};
/** Dependency, build-output, cache and VCS directories never scanned as project sources. */
const EXCLUDED_DIRECTORIES = [
	".git",
	".hg",
	".svn",
	"node_modules",
	"bower_components",
	"jspm_packages",
	"vendor",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".cache",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".mypy_cache",
	".pytest_cache",
	".gradle",
	".dart_tool",
	".build",
	"_build",
	"Pods",
	"DerivedData",
	".terraform",
];
/** Configuration/markup languages are not project sources; a file-mode call still checks them. */
const NON_SOURCE_LANGUAGES: Record<string, true> = {
	json: true,
	yaml: true,
	css: true,
	scss: true,
	less: true,
	html: true,
};
/** Concurrent per-document checks in a project scan; servers queue beyond this anyway. */
const SCAN_CONCURRENCY = 8;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function byPosition(a: Diagnostic, b: Diagnostic): number {
	return a.range.start.line - b.range.start.line || (a.severity ?? 9) - (b.severity ?? 9);
}

function diagnosticRow(shown: string, item: Diagnostic, source: string): string {
	return `${shown}:${item.range.start.line + 1}:${item.range.start.character + 1} ${SEVERITY_NAME[item.severity ?? 1] ?? "info"}${item.code === undefined ? "" : ` [${item.code}]`}: ${item.message}\n    ${source}`;
}

/**
 * Actual project sources under `root`, sorted by path: files a configured
 * server speaks, honouring ignore files and skipping dependency/build/VCS
 * directories. Runs on the execution site, so SSH targets list remotely.
 */
async function discoverSources(workspace: Workspace, context: ToolContext, root: string): Promise<string[]> {
	const binary = await workspace.requireBinary("rg", "project source discovery", context.signal);
	const result = await workspace.executor.exec(
		[
			binary,
			"--files",
			"--no-config",
			"--sort=path",
			...EXCLUDED_DIRECTORIES.map((name) => `--glob=!${name}/`),
			root,
		],
		{ signal: context.signal, cwd: root, timeoutMs: 120_000, maxCaptureBytes: 64 * 1024 * 1024 },
	);
	if (result.code > 1 || result.timedOut || result.aborted || result.droppedStdoutBytes)
		throw new ToolFailure(
			`Source discovery failed: ${result.stderr || "incomplete listing; narrow the path"}`,
		);
	return result.stdout.split("\n").filter((path) => {
		const languageId = path ? languageIdForPath(path) : undefined;
		return languageId !== undefined && !NON_SOURCE_LANGUAGES[languageId];
	});
}

async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) await run(items[next++]!);
		}),
	);
}
const POSITION_PROPERTIES = {
	path: { type: "string", description: "File path in the active local/SSH workspace." },
	line: { type: "integer", minimum: 1, description: "1-based line." },
	character: { type: "integer", minimum: 1, description: "1-based UTF-16 column." },
};
function toPosition(args: Arguments): Position {
	return {
		line: argInt(args, "line", 1, 1, 10_000_000) - 1,
		character: argInt(args, "character", 1, 1, 10_000_000) - 1,
	};
}
function overlaps(left: Range, right: Range): boolean {
	const compare = (a: Position, b: Position) => a.line - b.line || a.character - b.character;
	// A cursor selects a diagnostic at that position; nonempty ranges are half-open.
	if (compare(right.start, right.end) === 0)
		return compare(left.start, right.start) <= 0 && compare(right.start, left.end) <= 0;
	if (compare(left.start, left.end) === 0)
		return compare(right.start, left.start) <= 0 && compare(left.start, right.end) < 0;
	return compare(left.start, right.end) < 0 && compare(right.start, left.end) < 0;
}
function normalizeLocations(result: unknown): Location[] {
	if (!result) return [];
	const entries = Array.isArray(result) ? result : [result];
	return entries
		.map((entry) => {
			const link = entry as LocationLink;
			if (typeof link.targetUri === "string")
				return { uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange };
			return entry as Location;
		})
		.filter((entry) => typeof entry.uri === "string" && entry.range);
}
function renderHover(contents: unknown): string {
	if (contents == null) return "";
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(renderHover).filter(Boolean).join("\n\n");
	if (typeof contents === "object" && "value" in contents && typeof contents.value === "string") {
		return "language" in contents && typeof contents.language === "string"
			? `\`\`\`${contents.language}\n${contents.value}\n\`\`\``
			: contents.value;
	}
	return "";
}

/** Lazily quotes source lines, reading at most `maxFiles` documents besides the seeded one. */
function sourceReader(
	workspace: Workspace,
	context: ToolContext,
	maxFiles: number,
	seed?: { path: string; text: string },
): (path: string, line: number) => Promise<string> {
	const sources = new Map<string, Promise<string[] | null>>();
	if (seed) sources.set(seed.path, Promise.resolve(splitText(seed.text).lines));
	let read = 0;
	return async (path, line) => {
		let lines = sources.get(path);
		if (!lines) {
			lines =
				read++ < maxFiles
					? readTextFile(workspace.fs, path, MAX_DOCUMENT_BYTES, context.signal).then(
							(file) => (file.binary || file.truncated ? null : splitText(file.text).lines),
							() => null,
						)
					: Promise.resolve(null);
			sources.set(path, lines);
		}
		return (await lines)?.[line]?.trim() ?? "";
	};
}

async function locationRows(
	opened: OpenedDocument,
	context: ToolContext,
	locations: Location[],
): Promise<string[]> {
	const quote = sourceReader(opened.workspace, context, 12, { path: opened.path, text: opened.text });
	const rows: string[] = [];
	for (const location of locations) {
		const path = uriToPath(location.uri),
			source = await quote(path, location.range.start.line);
		rows.push(
			`${displayPath(opened.workspace.base(context.cwd), path)}:${location.range.start.line + 1}:${location.range.start.character + 1}${source ? `  ${source}` : ""}`,
		);
	}
	return rows;
}

function readinessText(opened: OpenedDocument): string {
	const status = opened.session.client.readiness(opened.uri);
	return status.state === "ready"
		? ""
		: `\n[Language server ${status.state}: ${status.progress.join("; ") || "no diagnostic/readiness evidence received for this document"}. Empty results are not conclusive; retry after initialization.]`;
}

async function applyWorkspaceEdit(
	environment: ToolEnvironment,
	context: ToolContext,
	opened: OpenedDocument,
	edit: WorkspaceEdit,
): Promise<EditPlan> {
	const plan = await planWorkspaceEdit(
		opened.workspace,
		edit,
		context.signal,
		opened.session.client.documentVersions(),
	);
	for (const document of opened.session.client.openDocuments()) {
		const path = uriToPath(document.uri),
			before = plan.initial.get(path);
		if (before !== undefined && before !== null && sha256Hex(before) !== document.hash)
			throw new ToolFailure(
				`${path} changed since the language server read it; retry the action against fresh contents.`,
			);
	}
	await commitEditPlan(environment, opened.workspace, context, plan);
	notifyPlan(opened, plan);
	return plan;
}

function notifyPlan(opened: OpenedDocument, plan: EditPlan): void {
	const watched: ExternalChange[] = plan.steps.map((step) => ({
		uri: pathToUri(step.path),
		type: step.after === null ? FILE_DELETED : step.before === null ? FILE_CREATED : FILE_CHANGED,
		...(step.after === null ? {} : { text: step.after, languageId: languageIdForPath(step.path) }),
	}));
	opened.session.client.notifyExternalChanges(watched);
}

function planOutput(opened: OpenedDocument, context: ToolContext, plan: EditPlan, label: string): ToolOutput {
	const base = opened.workspace.base(context.cwd);
	return {
		text: `${label}: ${plan.steps.length} ordered file change(s) using ${opened.session.serverId}\n${plan.steps.map((step) => `${step.after === null ? "deleted" : step.before === null ? "created" : "updated"} ${displayPath(base, step.path)}`).join("\n")}`,
		diff:
			plan.steps
				.map((step) => unifiedDiff(step.before ?? "", step.after ?? "", displayPath(base, step.path)))
				.join("") || undefined,
		details: {
			server: opened.session.serverId,
			changedFiles: new Set(plan.steps.map((step) => step.path)).size,
			files: [...new Set(plan.steps.map((step) => step.path))],
		},
	};
}

interface CodeAction {
	title: string;
	kind?: string;
	disabled?: { reason: string };
	edit?: WorkspaceEdit;
	command?: { command: string; arguments?: unknown[]; title?: string } | string;
	arguments?: unknown[];
	data?: unknown;
}
interface StoredAction {
	action: CodeAction;
	path: string;
	owner: string;
	workspace: string;
	hash: string;
	client: LspClient;
	generation: number;
}
interface ActionListing {
	client: LspClient;
	generation: number;
	hash: string;
	rows: string[];
}
interface SymbolEntry {
	name: string;
	kind: number;
	detail?: string;
	range?: { start: Position };
	selectionRange?: { start: Position };
	location?: Location;
	children?: SymbolEntry[];
}

export interface LspSuite {
	tools: HarnessTool[];
	close(): Promise<void>;
}

export function createLspTools(environment: ToolEnvironment): LspSuite {
	const manager = new LspManager(environment);
	const actions = new Map<string, StoredAction>();
	const listings = new Map<string, ActionListing>();
	const locationTools = (
		[
			["lsp_definition", "textDocument/definition", "definition"],
			["lsp_type_definition", "textDocument/typeDefinition", "type definition"],
			["lsp_implementation", "textDocument/implementation", "implementation"],
			["lsp_references", "textDocument/references", "reference"],
		] as const
	).map(([name, method, label]) =>
		defineTool({
			name,
			description: `Find ${label} locations using the active workspace language server. Positions are 1-based. Page with skip/limit or recover complete results from artifacts. Initializing/unknown readiness is reported honestly.`,
			parameters: {
				type: "object",
				properties: {
					...POSITION_PROPERTIES,
					...SEARCH_PAGE_PROPERTIES,
					...(name === "lsp_references" ? { include_declaration: { type: "boolean" } } : {}),
				},
				required: ["path", "line", "character"],
				additionalProperties: false,
			},
			async run(args, context) {
				const opened = await manager.open(context, argString(args, "path"));
				const result = await opened.session.client.request<unknown>(
					method,
					{
						textDocument: { uri: opened.uri },
						position: toPosition(args),
						...(name === "lsp_references"
							? { context: { includeDeclaration: args.include_declaration !== false } }
							: {}),
					},
					60_000,
				);
				const locations = normalizeLocations(result);
				const rows = await locationRows(opened, context, locations);
				const output = await searchPage(environment, context, args, name, rows);
				output.text += readinessText(opened);
				output.details = {
					...(output.details && typeof output.details === "object" && !Array.isArray(output.details)
						? output.details
						: {}),
					server: opened.session.serverId,
					readiness: opened.session.client.readiness(opened.uri),
				};
				return output;
			},
		}),
	);
	const hover = defineTool({
		name: "lsp_hover",
		description:
			"Show symbol type, signature and documentation at a 1-based position. Reports actual server readiness when information is absent.",
		parameters: {
			type: "object",
			properties: POSITION_PROPERTIES,
			required: ["path", "line", "character"],
			additionalProperties: false,
		},
		async run(args, context) {
			const opened = await manager.open(context, argString(args, "path"));
			const result = await opened.session.client.request<{ contents?: unknown } | null>(
				"textDocument/hover",
				{ textDocument: { uri: opened.uri }, position: toPosition(args) },
			);
			const text = renderHover(result?.contents).trim();
			const bounded = await environment.artifacts.bound(text || "The server returned no hover information.", {
				sessionId: context.sessionId,
				label: "lsp-hover",
			});
			return {
				text: bounded.text + readinessText(opened),
				details: {
					server: opened.session.serverId,
					found: text ? 1 : 0,
					readiness: opened.session.client.readiness(opened.uri),
					...(bounded.artifact ? { artifact: bounded.artifact } : {}),
				},
			};
		},
	});
	async function requestDiagnostics(opened: OpenedDocument, timeout: number) {
		const client = opened.session.client;
		if (client.serverId === "typescript-language-server")
			return { items: await client.typescriptDiagnostics(opened.uri, timeout), pulled: true };
		if (client.supportsPullDiagnostics) {
			const result = await client.request<{ items?: Diagnostic[]; kind?: string } | null>(
				"textDocument/diagnostic",
				{ textDocument: { uri: opened.uri } },
				timeout,
			);
			if (!result || result.kind === "unchanged" || !Array.isArray(result.items))
				throw new ToolFailure(
					"Server did not return a full diagnostic report; no clean-file claim is possible.",
				);
			return { items: result.items, pulled: true };
		}
		return { items: await client.awaitDiagnostics(opened.uri, timeout), pulled: false };
	}
	async function fileDiagnostics(args: Arguments, context: ToolContext, path: string): Promise<ToolOutput> {
		const opened = await manager.open(context, path),
			client = opened.session.client;
		const timeout = argInt(args, "timeout", 15, 1, 600) * 1000;
		const { items, pulled } = await requestDiagnostics(opened, timeout);
		const readiness = client.readiness(opened.uri);
		if (!pulled && !client.hasDiagnostics(opened.uri))
			return {
				text: `${opened.session.serverId} is initializing or has not published diagnostics; no result yet for ${opened.path}. Retry lsp_diagnostics.${readinessText(opened)}`,
				isError: true,
				details: { server: opened.session.serverId, ready: false, readiness },
			};
		const lines = splitText(opened.text).lines,
			shown = displayPath(opened.workspace.base(context.cwd), opened.path);
		const rows = items
			.slice()
			.sort(byPosition)
			.map((item) => diagnosticRow(shown, item, lines[item.range.start.line]?.trim() ?? ""));
		const output = await searchPage(environment, context, args, "lsp-diagnostics", rows);
		const errors = items.filter((item) => (item.severity ?? 1) === 1).length;
		output.text = `${items.length} diagnostic(s), ${errors} error(s) from ${opened.session.serverId}.\n${output.text}${readiness.state === "initializing" ? readinessText(opened) : ""}`;
		output.isError = false;
		output.details = {
			...(output.details && typeof output.details === "object" && !Array.isArray(output.details)
				? output.details
				: {}),
			server: opened.session.serverId,
			count: items.length,
			errors,
			ready: true,
			readiness,
		};
		return output;
	}
	type ScanRecord =
		| {
				path: string;
				status: "checked";
				items: Diagnostic[];
				/** Text the server diagnosed, when opened; native reports quote from disk. */
				text?: string;
		  }
		| { path: string; status: "unready"; reason: string }
		| { path: string; status: "failed"; reason: string }
		| { path: string; status: "unsupported"; reason: string };
	/**
	 * Folder/project diagnostics. Native `workspace/diagnostic` is used where a
	 * server advertises it, but only files it returned full reports for count as
	 * checked; every other discovered file is opened and diagnosed individually.
	 * Anything not proven by a report is listed as unready/failed/unsupported.
	 */
	async function projectDiagnostics(
		args: Arguments,
		context: ToolContext,
		workspace: Workspace,
		target: string,
	): Promise<ToolOutput> {
		const deadline = Date.now() + argInt(args, "timeout", 90, 1, 600) * 1000,
			offset = argInt(args, "file_offset", 0, 0, Number.MAX_SAFE_INTEGER),
			maxFiles = argInt(args, "max_files", 200, 1, 2000);
		const files = await discoverSources(workspace, context, target);
		const batch = files.slice(offset, offset + maxFiles),
			end = offset + batch.length,
			unscanned = files.length - end;
		const records = new Map<string, ScanRecord>(
			batch.map((path) => [
				path,
				{ path, status: "unready", reason: "not reached before the time budget expired" },
			]),
		);
		const cache: ScanCache = { roots: new Map(), servers: new Map() };
		const groups = new Map<LspSession, string[]>();
		await eachLimited(batch, SCAN_CONCURRENCY, async (path) => {
			try {
				const { session } = await manager.session(context, path, cache);
				let group = groups.get(session);
				if (!group) {
					group = [];
					groups.set(session, group);
				}
				group.push(path);
			} catch (error) {
				context.signal.throwIfAborted();
				const reason = errorText(error);
				records.set(path, {
					path,
					status: /^No .*language server/.test(reason) ? "unsupported" : "failed",
					reason,
				});
			}
		});
		const native: string[] = [],
			notes: string[] = [],
			openedByScan: { client: LspClient; uri: string }[] = [];
		try {
			for (const [session, paths] of groups) {
				const client = session.client;
				await manager.refresh(session, context.signal);
				const alreadyOpen = new Set(client.openDocuments().map((document) => uriToPath(document.uri)));
				let pending = paths;
				// tsserver's LSP wrapper answers per document; its diagnostics go through tsserver directly.
				if (client.supportsWorkspaceDiagnostics && client.serverId !== "typescript-language-server") {
					try {
						const reports = await client.workspaceDiagnostics(Math.max(1, deadline - Date.now()));
						pending = [];
						for (const path of paths) {
							const items = reports.get(path);
							if (items) records.set(path, { path, status: "checked", items });
							else pending.push(path);
						}
						native.push(session.serverId);
					} catch (error) {
						context.signal.throwIfAborted();
						notes.push(
							`${session.serverId} workspace diagnostics unavailable (${errorText(error)}); documents were checked individually.`,
						);
					}
				}
				await eachLimited(pending, SCAN_CONCURRENCY, async (path) => {
					if (Date.now() >= deadline) return;
					let opened: OpenedDocument;
					try {
						opened = await manager.open(context, path, { refresh: false, cache });
					} catch (error) {
						context.signal.throwIfAborted();
						const reason = errorText(error);
						records.set(path, { path, status: /initializing/.test(reason) ? "unready" : "failed", reason });
						return;
					}
					if (!alreadyOpen.has(path)) openedByScan.push({ client, uri: opened.uri });
					const remaining = deadline - Date.now();
					if (remaining <= 0) return;
					try {
						const { items, pulled } = await requestDiagnostics(opened, remaining);
						if (!pulled && !client.hasDiagnostics(opened.uri)) {
							const progress = client.readiness(opened.uri).progress;
							records.set(path, {
								path,
								status: "unready",
								reason: `${session.serverId} published no diagnostics before the timeout${progress.length ? ` (server busy: ${progress.join("; ")})` : ""}`,
							});
						} else records.set(path, { path, status: "checked", items, text: opened.text });
					} catch (error) {
						context.signal.throwIfAborted();
						records.set(path, {
							path,
							status: client.alive ? "unready" : "failed",
							reason: errorText(error),
						});
					}
				});
			}
		} finally {
			// Scan-only buffers would otherwise pin every project file in server memory.
			for (const { client, uri } of openedByScan) client.closeDocument(uri);
		}

		const base = workspace.base(context.cwd),
			ordered = batch.map((path) => records.get(path)!),
			quote = sourceReader(workspace, context, 200);
		const rows: string[] = [];
		let count = 0,
			errors = 0,
			filesWithDiagnostics = 0;
		for (const record of ordered) {
			if (record.status !== "checked" || !record.items?.length) continue;
			filesWithDiagnostics++;
			count += record.items.length;
			errors += record.items.filter((item) => (item.severity ?? 1) === 1).length;
			const lines = record.text === undefined ? undefined : splitText(record.text).lines,
				shown = displayPath(base, record.path);
			for (const item of record.items.slice().sort(byPosition))
				rows.push(
					diagnosticRow(
						shown,
						item,
						lines
							? (lines[item.range.start.line]?.trim() ?? "")
							: await quote(record.path, item.range.start.line),
					),
				);
		}
		const checked = ordered.filter((record) => record.status === "checked").length,
			unready = ordered.filter((record) => record.status === "unready"),
			failed = ordered.filter((record) => record.status === "failed"),
			unsupportedByReason = new Map<string, string[]>();
		for (const record of ordered) {
			if (record.status !== "unsupported") continue;
			const reason = record.reason;
			let paths = unsupportedByReason.get(reason);
			if (!paths) {
				paths = [];
				unsupportedByReason.set(reason, paths);
			}
			paths.push(record.path);
		}
		const unsupportedCount = ordered.length - checked - unready.length - failed.length;
		const complete = offset === 0 && unscanned === 0 && checked === batch.length;
		const servers = [...new Set([...groups.keys()].map((session) => session.serverId))];
		const shownTarget = displayPath(base, target);
		const summary: string[] = [];
		if (files.length === 0)
			summary.push(
				`No supported source files were discovered under ${shownTarget} (dependency/build/VCS directories and ignored files excluded); nothing was checked.`,
			);
		else {
			summary.push(
				`Project diagnostics for ${shownTarget}${servers.length ? ` using ${servers.join(", ")}` : ""}: ${files.length} source file(s) discovered (dependency/build/VCS directories and ignored files excluded); this call scanned files ${batch.length ? `${offset + 1}-${end}` : "none"} and obtained reports for ${checked}.`,
				`${count} diagnostic(s), ${errors} error(s) in ${filesWithDiagnostics} file(s).`,
			);
			if (complete)
				summary.push(
					count === 0
						? "Complete: every discovered file was checked and no diagnostics were reported."
						: "Complete: every discovered file was checked.",
				);
			else {
				summary.push("INCOMPLETE — files without a report are NOT known to be clean:");
				if (unready.length)
					summary.push(
						`  ${unready.length} file(s) returned no diagnostic report (server initializing or timed out); retry, or raise timeout.`,
					);
				if (failed.length) summary.push(`  ${failed.length} file(s) failed.`);
				if (unsupportedCount) summary.push(`  ${unsupportedCount} file(s) have no usable language server.`);
				if (offset > 0) summary.push(`  files before file_offset=${offset} were not checked by this call.`);
				if (unscanned > 0)
					summary.push(`  ${unscanned} file(s) not yet scanned; continue with file_offset=${end}.`);
				for (const record of [...unready, ...failed].slice(0, 20))
					summary.push(`  ${record.status} ${displayPath(base, record.path)}: ${record.reason}`);
				if (unready.length + failed.length > 20)
					summary.push(`  … ${unready.length + failed.length - 20} more in details.`);
				for (const [reason, paths] of unsupportedByReason)
					summary.push(
						`  unsupported (${paths.length}): ${reason} e.g. ${paths
							.slice(0, 3)
							.map((path) => displayPath(base, path))
							.join(", ")}`,
					);
			}
			if (native.length) summary.push(`Native workspace diagnostics used from ${native.join(", ")}.`);
			summary.push(...notes);
		}
		const output = await searchPage(environment, context, args, "lsp-diagnostics", rows);
		output.text = `${summary.join("\n")}\n${output.text}`;
		output.isError = !complete;
		output.details = {
			...(output.details && typeof output.details === "object" && !Array.isArray(output.details)
				? output.details
				: {}),
			target,
			servers,
			total: files.length,
			fileOffset: offset,
			scanned: batch.length,
			checked,
			...(unscanned > 0 ? { nextFileOffset: end } : {}),
			complete,
			count,
			errors,
			filesWithDiagnostics,
			nativeWorkspaceDiagnostics: native,
			unready: unready.slice(0, 100).map((record) => ({ path: record.path, reason: record.reason })),
			failed: failed.slice(0, 100).map((record) => ({ path: record.path, reason: record.reason })),
			unsupported: [...unsupportedByReason].map(([reason, paths]) => ({
				reason,
				count: paths.length,
				examples: paths.slice(0, 5),
			})),
		};
		return output;
	}
	const diagnostics = defineTool({
		name: "lsp_diagnostics",
		description:
			"Read language-server diagnostics for a file, or for every project source under a directory (default: cwd). Directory scans skip dependency/build/VCS directories and ignored files, use native workspace diagnostics where advertised and otherwise open and diagnose each discovered file. Waits for actual diagnostics/progress, not a cosmetic sleep; a timeout or unready server is reported as incomplete, never as clean. Page diagnostics with skip/limit; page large projects with max_files/file_offset.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"File or directory in the active local/SSH workspace; defaults to the current directory.",
				},
				timeout: {
					type: "integer",
					minimum: 1,
					maximum: 600,
					description: "Seconds to wait: per file (default 15) or for the whole directory scan (default 90).",
				},
				max_files: {
					type: "integer",
					minimum: 1,
					maximum: 2000,
					description: "Directory scans: source files checked per call, default 200.",
				},
				file_offset: {
					type: "integer",
					minimum: 0,
					description: "Directory scans: discovered files to skip; use nextFileOffset to continue.",
				},
				...SEARCH_PAGE_PROPERTIES,
			},
			additionalProperties: false,
		},
		async run(args, context) {
			const workspace = environment.workspace(context),
				path = workspace.resolvePath(context.cwd, argOptionalString(args, "path") ?? ".");
			const stat = await workspace.fs.stat(path, { hash: false, signal: context.signal });
			if (stat.kind === "dir") return projectDiagnostics(args, context, workspace, path);
			if (stat.kind !== "file") throw new ToolFailure(`Path not found: ${path}`);
			return fileDiagnostics(args, context, path);
		},
	});
	const callHierarchy = defineTool({
		name: "lsp_call_hierarchy",
		description:
			"Show the functions that call the symbol at a 1-based position (direction incoming, default) or the functions it calls (outgoing), from the language server's native call hierarchy. Each row names the caller/callee, its declaration location and the call-site lines. Servers without call-hierarchy support are refused, never approximated by text search. Page with skip/limit.",
		parameters: {
			type: "object",
			properties: {
				...POSITION_PROPERTIES,
				direction: {
					type: "string",
					enum: ["incoming", "outgoing"],
					description: "incoming lists callers (default); outgoing lists callees.",
				},
				...SEARCH_PAGE_PROPERTIES,
			},
			required: ["path", "line", "character"],
			additionalProperties: false,
		},
		async run(args, context) {
			const direction = (argOptionalString(args, "direction") ?? "incoming") as CallDirection;
			if (direction !== "incoming" && direction !== "outgoing")
				throw new ToolFailure("direction must be incoming or outgoing.");
			const opened = await manager.open(context, argString(args, "path")),
				client = opened.session.client;
			if (!client.supportsCallHierarchy)
				throw new ToolFailure(
					`${opened.session.serverId} does not advertise call hierarchy support; callers/callees cannot be determined through it.`,
				);
			const targets = await client.prepareCallHierarchy(opened.uri, toPosition(args));
			const base = opened.workspace.base(context.cwd),
				quote = sourceReader(opened.workspace, context, 50, { path: opened.path, text: opened.text });
			const describe = (item: CallHierarchyItem) =>
				`${SYMBOL_KIND_NAME[item.kind] ?? `kind ${item.kind}`} ${item.name}${item.detail ? ` (${item.detail})` : ""} at ${displayPath(base, uriToPath(item.uri))}:${item.selectionRange.start.line + 1}:${item.selectionRange.start.character + 1}`;
			const rows: string[] = [];
			for (const target of targets) {
				for (const call of await client.callHierarchyCalls(target, direction)) {
					// Incoming call sites lie in the caller; outgoing ones in the prepared symbol.
					const sitePath = uriToPath(direction === "incoming" ? call.item.uri : target.uri),
						shownSite = displayPath(base, sitePath);
					let row = `${direction === "incoming" ? "caller" : "callee"} ${describe(call.item)}${targets.length > 1 ? ` [for ${target.name}]` : ""}`;
					for (const range of call.fromRanges.slice(0, 5)) {
						const source = await quote(sitePath, range.start.line);
						row += `\n    call at ${shownSite}:${range.start.line + 1}:${range.start.character + 1}${source ? `  ${source}` : ""}`;
					}
					if (call.fromRanges.length > 5) row += `\n    … ${call.fromRanges.length - 5} more call site(s)`;
					rows.push(row);
				}
			}
			const output = await searchPage(environment, context, args, "lsp-call-hierarchy", rows);
			const heading = targets.length
				? `${direction === "incoming" ? "Incoming calls to" : "Outgoing calls from"} ${targets.map(describe).join("; ")} via ${opened.session.serverId}.`
				: `${opened.session.serverId} found no callable symbol at this position.`;
			output.text = `${heading}\n${output.text}${readinessText(opened)}`;
			output.details = {
				...(output.details && typeof output.details === "object" && !Array.isArray(output.details)
					? output.details
					: {}),
				server: opened.session.serverId,
				direction,
				targets: targets.map((target) => ({
					name: target.name,
					kind: SYMBOL_KIND_NAME[target.kind] ?? target.kind,
					path: uriToPath(target.uri),
					line: target.selectionRange.start.line + 1,
					character: target.selectionRange.start.character + 1,
				})),
				calls: rows.length,
				readiness: client.readiness(opened.uri),
			};
			return output;
		},
	});
	const rename = defineTool({
		name: "lsp_rename",
		description:
			"Rename a symbol across the project using an ordered, preflighted, hash-checked workspace edit. A later failure rolls back only unchanged tool-written content and reports original-content recovery artifacts.",
		parameters: {
			type: "object",
			properties: { ...POSITION_PROPERTIES, new_name: { type: "string" } },
			required: ["path", "line", "character", "new_name"],
			additionalProperties: false,
		},
		async run(args, context) {
			const opened = await manager.open(context, argString(args, "path")),
				newName = argString(args, "new_name");
			if (!newName.trim()) throw new ToolFailure("new_name is empty.");
			const edit = await opened.session.client.request<WorkspaceEdit | null>(
				"textDocument/rename",
				{ textDocument: { uri: opened.uri }, position: toPosition(args), newName },
				90_000,
			);
			if (!edit) throw new ToolFailure(`Server produced no rename.${readinessText(opened)}`);
			return planOutput(
				opened,
				context,
				await applyWorkspaceEdit(environment, context, opened, edit),
				`Renamed to ${newName}`,
			);
		},
	});
	const symbols = defineTool({
		name: "lsp_symbols",
		description:
			"List hierarchical document symbols, or workspace symbols when query is supplied. Page with skip/limit; complete results remain recoverable.",
		parameters: {
			type: "object",
			properties: { path: POSITION_PROPERTIES.path, query: { type: "string" }, ...SEARCH_PAGE_PROPERTIES },
			required: ["path"],
			additionalProperties: false,
		},
		async run(args, context) {
			const opened = await manager.open(context, argString(args, "path")),
				query = argOptionalString(args, "query");
			const result = await opened.session.client.request<SymbolEntry[] | null>(
				query === undefined ? "textDocument/documentSymbol" : "workspace/symbol",
				query === undefined ? { textDocument: { uri: opened.uri } } : { query },
			);
			const rows: string[] = [];
			const visit = (entries: SymbolEntry[], parents: string[]) => {
				for (const entry of entries) {
					const position = entry.location?.range?.start ?? entry.selectionRange?.start ?? entry.range?.start;
					const uri = entry.location?.uri ?? opened.uri;
					rows.push(
						`${displayPath(opened.workspace.base(context.cwd), uriToPath(uri))}${position ? `:${position.line + 1}:${position.character + 1}` : ""} ${[...parents, entry.name].join(" > ")} (kind ${entry.kind})${entry.detail ? ` ${entry.detail}` : ""}`,
					);
					if (entry.children) visit(entry.children, [...parents, entry.name]);
				}
			};
			visit(result ?? [], []);
			const output = await searchPage(environment, context, args, "lsp-symbols", rows);
			output.text += readinessText(opened);
			return output;
		},
	});
	const codeActions = defineTool({
		name: "lsp_code_actions",
		description:
			"List quick fixes and refactorings for a position/range. Each action receives an id for explicit lsp_apply_action; this call changes no files. Page the captured listing with the same arguments and skip/limit. A new listing on this server invalidates older action ids; stale pages/actions explicitly fail.",
		parameters: {
			type: "object",
			properties: {
				...POSITION_PROPERTIES,
				end_line: { type: "integer", minimum: 1 },
				end_character: { type: "integer", minimum: 1 },
				kind: { type: "string" },
				...SEARCH_PAGE_PROPERTIES,
			},
			required: ["path", "line", "character"],
			additionalProperties: false,
		},
		async run(args, context) {
			const opened = await manager.open(context, argString(args, "path")),
				start = toPosition(args),
				kind = argOptionalString(args, "kind");
			const end = {
				line: argInt(args, "end_line", start.line + 1, 1, 10_000_000) - 1,
				character: argInt(args, "end_character", start.character + 1, 1, 10_000_000) - 1,
			};
			if (end.line < start.line || (end.line === start.line && end.character < start.character))
				throw new ToolFailure("Code-action range ends before it starts.");
			const client = opened.session.client,
				owner = `${context.sessionId}\0${context.agentId}`,
				hash = sha256Hex(opened.text);
			const key = JSON.stringify([owner, opened.workspace.id, opened.path, start, end, kind]);
			const skip = argInt(args, "skip", 0, 0, Number.MAX_SAFE_INTEGER);
			let listing = listings.get(key);
			if (skip > 0) {
				if (
					!listing ||
					listing.client !== client ||
					listing.generation !== client.codeActionGeneration ||
					listing.hash !== hash
				)
					throw new ToolFailure(
						"This code-action page is stale or missing; request the first page again with skip=0.",
					);
			} else {
				let diagnostics = client.diagnosticsFor(opened.uri);
				if (!kind || kind === "quickfix" || kind.startsWith("quickfix.")) {
					const report = await requestDiagnostics(opened, 15_000);
					if (!report.pulled && !client.hasDiagnostics(opened.uri))
						throw new ToolFailure(
							"The language server has not published diagnostics yet; retry code actions.",
						);
					diagnostics = report.items;
				}
				const pending = client.request<CodeAction[] | null>("textDocument/codeAction", {
					textDocument: { uri: opened.uri },
					range: { start, end },
					context: {
						diagnostics: diagnostics.filter((item) => overlaps(item.range, { start, end })),
						...(kind ? { only: [kind] } : {}),
					},
				});
				const generation = client.codeActionGeneration;
				const result = await pending;
				if (generation !== client.codeActionGeneration)
					throw new ToolFailure(
						"Another code-action listing superseded this request; request the first page again.",
					);
				const rows = (result ?? []).map((action) => {
					const id = randomToken(12);
					actions.set(id, {
						action,
						path: opened.path,
						owner,
						workspace: opened.workspace.id,
						hash,
						client,
						generation,
					});
					return `${id} ${action.title}${action.kind ? ` [${action.kind}]` : ""}${action.disabled ? ` (disabled: ${action.disabled.reason})` : ""}`;
				});
				// Only the current server generation can be paged; artifacts retain full older listings.
				for (const [previousKey, previous] of listings)
					if (previous.client === client) listings.delete(previousKey);
				listing = { client, generation, hash, rows };
				listings.set(key, listing);
			}
			const output = await searchPage(environment, context, args, "lsp-code-actions", listing!.rows);
			output.text += readinessText(opened);
			return output;
		},
	});
	const applyAction = defineTool({
		name: "lsp_apply_action",
		description:
			"Apply an explicitly selected code-action id. Edits/resource operations use preflight, expected hashes and conditional rollback. Server-requested command edits are permitted only during this explicit action.",
		parameters: {
			type: "object",
			properties: { action: { type: "string" } },
			required: ["action"],
			additionalProperties: false,
		},
		async run(args, context) {
			const id = argString(args, "action"),
				stored = actions.get(id),
				workspace = environment.workspace(context);
			if (
				!stored ||
				stored.owner !== `${context.sessionId}\0${context.agentId}` ||
				stored.workspace !== workspace.id
			)
				throw new ToolFailure("Unknown code action for this agent/workspace.");
			const opened = await manager.open(context, stored.path);
			if (
				stored.client !== opened.session.client ||
				stored.generation !== opened.session.client.codeActionGeneration
			)
				throw new ToolFailure(
					"This code action is stale after another listing or server restart; request code actions again.",
				);
			if (sha256Hex(opened.text) !== stored.hash)
				throw new ToolFailure("The action's document changed; request code actions again.");
			let action = stored.action;
			if (action.disabled) throw new ToolFailure(action.disabled.reason);
			const provider = opened.session.client.capabilities.codeActionProvider;
			if (
				action.data !== undefined &&
				provider &&
				typeof provider === "object" &&
				"resolveProvider" in provider &&
				provider.resolveProvider
			)
				action = await opened.session.client.request<CodeAction>("codeAction/resolve", action);
			if (stored.generation !== opened.session.client.codeActionGeneration)
				throw new ToolFailure(
					"This code action was invalidated while resolving; request code actions again.",
				);
			if (action.disabled) throw new ToolFailure(action.disabled.reason);
			if (!action.edit && !action.command)
				throw new ToolFailure("The resolved action contains neither an edit nor an executable command.");
			const journal: EditPlan = { initial: new Map(), steps: [], modes: new Map() };
			// stdout callbacks run in the server-spawn context, not this checkpoint.
			const apply = AsyncResource.bind(async (edit: WorkspaceEdit) => {
				const plan = await applyWorkspaceEdit(environment, context, opened, edit);
				for (const [path, text] of plan.initial)
					if (!journal.initial.has(path)) journal.initial.set(path, text);
				for (const [path, mode] of plan.modes ?? [])
					if (!journal.modes!.has(path)) journal.modes!.set(path, mode);
				journal.steps.push(...plan.steps);
			});
			try {
				if (action.edit) await apply(action.edit);
				if (stored.generation !== opened.session.client.codeActionGeneration)
					throw new ToolFailure(
						"This code action was invalidated during application; request code actions again.",
					);
				if (action.command) {
					const command =
						typeof action.command === "string"
							? { command: action.command, arguments: action.arguments }
							: action.command;
					await opened.session.client.executeActionCommand(command.command, command.arguments ?? [], apply);
				}
			} catch (error) {
				if (!journal.steps.length) throw error;
				const recovery = await environment.artifacts.store(
					context.sessionId,
					"lsp-action-recovery",
					JSON.stringify(
						[...journal.initial].map(([path, content]) => ({
							path,
							content,
							mode: journal.modes?.get(path),
						})),
						null,
						2,
					),
				);
				const details =
					error instanceof ToolFailure &&
					error.details &&
					typeof error.details === "object" &&
					!Array.isArray(error.details)
						? error.details
						: {};
				const uncertain = Array.isArray(details.uncertainPaths)
					? details.uncertainPaths.filter((path): path is string => typeof path === "string")
					: details.publication === "unknown"
						? journal.steps.map((step) => step.path)
						: [];
				const rollback = await rollbackEdits(workspace, journal.steps, uncertain);
				notifyPlan(opened, { initial: new Map(), steps: rollback.restored });
				const innerFailures = Array.isArray(details.failures)
					? details.failures.filter((failure): failure is string => typeof failure === "string")
					: [];
				const failures = [...innerFailures, ...rollback.failures];
				const retained = Array.isArray(details.recoveryPaths)
					? details.recoveryPaths.filter((path): path is string => typeof path === "string")
					: [];
				const recoveryPaths = [...new Set([...retained, ...rollback.recoveryPaths])];
				const rollbackComplete =
					details.rollbackComplete !== false &&
					details.publication !== "unknown" &&
					failures.length === 0 &&
					rollback.uncertainPaths.length === 0;
				throw new ToolFailure(
					`Code action failed: ${String(error)}. ${rollbackComplete ? "Completed edits were rolled back." : `Rollback remains incomplete or publication is uncertain: ${failures.join("; ")}${rollback.uncertainPaths.length ? ` Pending paths: ${rollback.uncertainPaths.join(", ")}; do not retry or rewind until settled.` : ""}`} Original contents: ${recovery.uri}`,
					{
						recovery: recovery.uri,
						publication: rollbackComplete ? "rolled-back" : "unknown",
						rollbackComplete,
						failures,
						uncertainPaths: rollback.uncertainPaths,
						recoveryPaths,
						...(typeof details.recovery === "string" ? { innerRecovery: details.recovery } : {}),
					},
				);
			}
			actions.delete(id);
			return planOutput(opened, context, journal, action.title);
		},
	});
	const renameFile = defineTool({
		name: "lsp_rename_file",
		description:
			"Rename a regular file and update its imports using workspace/willRenameFiles. Refuses servers without file-rename support instead of silently moving without updating references. Ordered text/resource operations are transactional and hash-checked.",
		parameters: {
			type: "object",
			properties: { path: POSITION_PROPERTIES.path, new_path: { type: "string" } },
			required: ["path", "new_path"],
			additionalProperties: false,
		},
		async run(args, context) {
			const opened = await manager.open(context, argString(args, "path")),
				client = opened.session.client;
			const capability = client.capabilities.workspace;
			let supported = !!client.capabilities["workspace/willRenameFiles"];
			if (capability && typeof capability === "object" && "fileOperations" in capability) {
				const operations = capability.fileOperations;
				if (operations && typeof operations === "object" && "willRename" in operations)
					supported ||= !!operations.willRename;
			}
			if (!supported)
				throw new ToolFailure(`${opened.session.serverId} does not advertise file rename/import updates.`);
			const to = opened.workspace.resolvePath(context.cwd, argString(args, "new_path")),
				newUri = pathToUri(to),
				files = [{ oldUri: opened.uri, newUri }];
			const edit = await client.request<WorkspaceEdit | null>("workspace/willRenameFiles", { files }, 90_000);
			const changes =
				edit?.documentChanges ??
				Object.entries(edit?.changes ?? {}).map(([uri, edits]) => ({
					textDocument: { uri, version: null },
					edits,
				}));
			const alreadyRenamed = changes.some(
				(change) =>
					"kind" in change &&
					change.kind === "rename" &&
					uriToPath(change.oldUri) === opened.path &&
					uriToPath(change.newUri) === to,
			);
			const plan = await applyWorkspaceEdit(environment, context, opened, {
				documentChanges: alreadyRenamed
					? changes
					: [...changes, { kind: "rename", oldUri: opened.uri, newUri }],
			});
			client.notify("workspace/didRenameFiles", { files });
			return planOutput(opened, context, plan, `Renamed file to ${to}`);
		},
	});
	return {
		tools: [
			...locationTools,
			hover,
			diagnostics,
			callHierarchy,
			rename,
			symbols,
			codeActions,
			applyAction,
			renameFile,
		],
		close: () => manager.close(),
	};
}
