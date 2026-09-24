import type { HarnessTool, Json, ToolContext, ToolOutput } from "../contracts.ts";
import type { WorkspaceFs } from "../tools/fs.ts";
import { splitText, unifiedDiff } from "../tools/text.ts";
import { argInt, argOptionalString, formatBytes, sha256Hex, ToolFailure } from "../tools/util.ts";
import { defineTool, displayPath, type Workspace } from "../tools/workspace.ts";
import type { FileMutation, FileSnapshot, Store } from "./store.ts";

/**
 * The largest after-image the diff will read back from disk for a legacy
 * record whose own bytes were never retained. Matches the rewind capture limit.
 */
const LEGACY_READ_LIMIT = 8 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * One uninterrupted run of the session's own confirmed mutations to a path:
 * every receipt's `before` equals the previous receipt's `after`, so the net
 * change from `before` to `after` is attributable to the session alone.
 */
interface Segment {
	before: FileSnapshot;
	after: FileSnapshot;
	records: FileMutation[];
}

/** A receipt chain broken by something outside salam. */
interface Discontinuity {
	at: number;
	expected: FileSnapshot;
	found: FileSnapshot;
}

interface Drift {
	kind: "external" | "uncertain" | "unverified";
	expected: FileSnapshot;
	current?: FileSnapshot;
	note: string;
}

interface Entry {
	workspaceId: string;
	workspaceLabel: string;
	path: string;
	shown: string;
	/** Runs with a net effect, oldest first. */
	segments: Segment[];
	discontinuities: Discontinuity[];
	drift?: Drift;
	expected?: FileSnapshot;
	uncertain: boolean;
	warnings: string[];
	fs?: WorkspaceFs;
}

interface Rendered {
	status: string;
	summary: string;
	patch: string;
	added: number;
	removed: number;
	warnings: string[];
}

function modeText(mode: number | undefined): string {
	return mode === undefined ? "" : (mode & 0o7777).toString(8).padStart(4, "0");
}

function describe(state: FileSnapshot): string {
	if (state.kind === "missing") return "missing";
	if (state.kind === "file")
		return `file ${state.hash.slice(0, 12)} (${formatBytes(state.size)}${state.mode === undefined ? "" : `, mode ${modeText(state.mode)}`})`;
	return `directory${state.mode === undefined ? "" : ` (mode ${modeText(state.mode)})`}`;
}

/** Unknown legacy permissions cannot prove continuity or a mode-only no-op. */
function compareState(left: FileSnapshot, right: FileSnapshot): "same" | "different" | "unknown" {
	if (left.kind !== right.kind) return "different";
	if (left.kind === "missing") return "same";
	if (left.kind === "file" && right.kind === "file" && left.hash !== right.hash) return "different";
	const leftMode = modeOf(left);
	const rightMode = modeOf(right);
	if (leftMode === undefined || rightMode === undefined) return "unknown";
	return leftMode === rightMode ? "same" : "different";
}

function isDir(state: FileSnapshot): boolean {
	return state.kind === "dir";
}

function modeOf(state: FileSnapshot): number | undefined {
	return state.kind === "missing" ? undefined : state.mode;
}

function decodeText(bytes: Uint8Array): string | undefined {
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

function snapshotJson(state: FileSnapshot | undefined): Json {
	if (!state) return null;
	if (state.kind === "missing") return { kind: "missing" };
	if (state.kind === "file")
		return {
			kind: "file",
			hash: state.hash,
			size: state.size,
			...(state.mode === undefined ? {} : { mode: state.mode }),
		};
	const mode = modeOf(state);
	return { kind: "dir", ...(mode === undefined ? {} : { mode }) };
}

function time(at: number): string {
	return new Date(at).toISOString();
}

/** Current state of a path, or a reason it could not be established exactly. */
async function observe(
	fs: WorkspaceFs,
	path: string,
	signal: AbortSignal,
): Promise<{ state?: FileSnapshot; note?: string }> {
	const stat = await fs.stat(path, { signal });
	if (stat.symlink) return { note: "is now a symbolic link" };
	if (stat.kind === "missing") return { state: { kind: "missing" } };
	if (stat.kind === "dir")
		return { state: { kind: "dir", ...(stat.mode === undefined ? {} : { mode: stat.mode }) } };
	if (stat.kind === "other") return { note: "is now a special file" };
	const hash = stat.hash ?? (stat.size <= LEGACY_READ_LIMIT ? await fs.hash(path, signal) : undefined);
	if (!hash) return { note: `is now ${formatBytes(stat.size)}, too large to hash for comparison` };
	return {
		state: { kind: "file", hash, size: stat.size, ...(stat.mode === undefined ? {} : { mode: stat.mode }) },
	};
}

/**
 * Splits one path's receipts into runs the session can own. Failed records
 * are proven ineffective and skipped. A pending record's outcome is unknown,
 * so it closes the current run without claiming anything about the next.
 */
function chain(records: FileMutation[]): {
	segments: Segment[];
	discontinuities: Discontinuity[];
	warnings: string[];
} {
	const segments: Segment[] = [];
	const discontinuities: Discontinuity[] = [];
	const warnings: string[] = [];
	let current: Segment | undefined;
	let previousAfter: FileSnapshot | undefined;
	for (const record of records) {
		if (record.status === "failed" || record.status === "reverted") continue;
		if (record.status === "pending") {
			warnings.push(
				`A ${record.operation} started at ${time(record.at)} was never confirmed; its publication outcome is unknown${record.remote ? " and may still complete on the remote host" : ""}. Changes before and after it are shown separately.`,
			);
			current = undefined;
			previousAfter = undefined;
			continue;
		}
		if (!record.after) {
			warnings.push(
				`A ${record.operation} at ${time(record.at)} is marked done but has no commit receipt, so its result is unknown.`,
			);
			current = undefined;
			previousAfter = undefined;
			continue;
		}
		const continuity = previousAfter && compareState(previousAfter, record.before);
		if (current && continuity === "same") {
			current.after = record.after;
			current.records.push(record);
		} else {
			if (previousAfter && continuity === "different")
				discontinuities.push({ at: record.at, expected: previousAfter, found: record.before });
			else if (continuity === "unknown")
				warnings.push(
					`Receipt continuity at ${time(record.at)} cannot be verified because legacy permissions were not recorded. Own changes are shown separately.`,
				);
			current = { before: record.before, after: record.after, records: [record] };
			segments.push(current);
		}
		previousAfter = record.after;
	}
	return { segments, discontinuities, warnings };
}

function countLines(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	const lines = patch.split("\n");
	for (let index = 2; index < lines.length; index++) {
		if (lines[index]!.startsWith("+")) added++;
		else if (lines[index]!.startsWith("-")) removed++;
	}
	return { added, removed };
}

/**
 * The shared line diff ignores an EOF-newline-only change. When that bit
 * changes, use a complete-file hunk so the patch still reproduces exact bytes.
 * Large patches remain recoverable through the runtime's artifact bounds.
 */
function contentDiff(before: string, after: string, path: string): string {
	if (before.endsWith("\n") === after.endsWith("\n")) return unifiedDiff(before, after, path);
	const left = splitText(before);
	const right = splitText(after);
	const patch = [
		`--- a/${path.replace(/^\/+/, "")}`,
		`+++ b/${path.replace(/^\/+/, "")}`,
		`@@ -${left.lines.length ? 1 : 0},${left.lines.length} +${right.lines.length ? 1 : 0},${right.lines.length} @@`,
	];
	for (const line of left.lines) patch.push(`-${line}`);
	if (left.noEol) patch.push("\\ No newline at end of file");
	for (const line of right.lines) patch.push(`+${line}`);
	if (right.noEol) patch.push("\\ No newline at end of file");
	return `${patch.join("\n")}\n`;
}

/**
 * Git-independent view of what this session's own tracked tool mutations did
 * to the filesystem, reconstructed only from the persistent mutation journal
 * and content-addressed blobs. External edits are never folded into the
 * session's changes: a broken receipt chain or current drift is reported
 * separately instead.
 */
export function createSessionDiffTool(
	store: Store,
	workspaceFor: (context: ToolContext) => Workspace,
	ownerSessionId: () => string,
): HarnessTool {
	return defineTool({
		name: "session_diff",
		description:
			"Show net changes made by this session's tracked tools, including root-attributed sub-agent changes, locally or over SSH without git. Reverted and ineffective mutations are omitted. Broken receipt chains and current external drift are reported separately; uncertain outcomes and unavailable legacy contents remain explicit. Text gets exact unified diffs; binary, mode and directory changes are summarized. Moves are represented as per-path changes, not inferred renames. Optional checkpoint selects that rewind point and later changes; path filters the current workspace; offset/limit page over reported paths. Shell and MCP writes are not tracked. Oversized patches remain recoverable through runtime artifacts.",
		parameters: {
			type: "object",
			properties: {
				checkpoint: { type: "string", description: "Rewind point id; defaults to the whole session." },
				path: { type: "string", description: "Only this path or its descendants in the current workspace." },
				offset: { type: "integer", minimum: 0, description: "Reported paths to skip. Defaults to 0." },
				limit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_LIMIT,
					description: `Reported paths per page. Defaults to ${DEFAULT_LIMIT}.`,
				},
			},
			additionalProperties: false,
		},
		async run(args, context): Promise<ToolOutput> {
			const sessionId = ownerSessionId();
			const checkpoint = argOptionalString(args, "checkpoint");
			const requestedPath = argOptionalString(args, "path");
			const offset = argInt(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
			const limit = argInt(args, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
			const signal = context.signal;

			const points = store.checkpoints(sessionId);
			let fromId = points.find((point) => point.filesAvailable)?.id;
			let notice = points.some((point) => !point.filesAvailable)
				? "History before file tracking is unavailable; only recorded mutations can be reported.\n"
				: "";
			if (checkpoint !== undefined) {
				const point = points.find((candidate) => candidate.id === checkpoint);
				if (!point) throw new ToolFailure(`Unknown rewind point ${checkpoint} in this session.`);
				fromId = point.id;
				if (!point.filesAvailable)
					notice =
						"This rewind point predates file tracking; every tracked change of the session is shown.\n";
			}
			const records = fromId === undefined ? [] : store.mutationsFrom(sessionId, fromId);

			const here = workspaceFor(context);
			const base = here.base(context.cwd);
			const filter = requestedPath === undefined ? undefined : here.resolvePath(context.cwd, requestedPath);
			const within = (workspaceId: string, path: string): boolean =>
				filter === undefined ||
				(workspaceId === here.id &&
					(path === filter || path.startsWith(filter.endsWith("/") ? filter : `${filter}/`)));

			const groups = new Map<string, FileMutation[]>();
			for (const record of records) {
				if (!within(record.workspaceId, record.path)) continue;
				const key = `${record.workspaceId}\u0000${record.path}`;
				const bucket = groups.get(key);
				if (bucket) bucket.push(record);
				else groups.set(key, [record]);
			}

			const workspaces = new Map<string, Workspace | undefined>();
			const reach = (record: FileMutation): Workspace | undefined => {
				const key = `${record.workspaceId}\u0000${record.cwd}`;
				if (workspaces.has(key)) return workspaces.get(key);
				let workspace: Workspace | undefined;
				if (record.workspaceId === here.id) workspace = here;
				else {
					try {
						const candidate = workspaceFor({
							cwd: record.cwd,
							sessionId: context.sessionId,
							agentId: context.agentId,
							signal,
							emit: () => undefined,
							...(record.remote ? { remote: record.remote } : {}),
						});
						if (candidate.id === record.workspaceId) workspace = candidate;
					} catch {
						workspace = undefined;
					}
				}
				workspaces.set(key, workspace);
				return workspace;
			};

			const entries: Entry[] = [];
			for (const bucket of groups.values()) {
				signal.throwIfAborted();
				const first = bucket[0]!;
				const { segments, discontinuities, warnings } = chain(bucket);
				const effective = segments.filter(
					(segment) => compareState(segment.before, segment.after) !== "same",
				);
				if (!effective.length && !warnings.length && !discontinuities.length) continue;
				const workspace = reach(first);
				const label = workspace?.label ?? (first.remote ? first.remote.host : first.workspaceId);
				const entry: Entry = {
					workspaceId: first.workspaceId,
					workspaceLabel: label,
					path: first.path,
					shown: first.workspaceId === here.id ? displayPath(base, first.path) : first.path,
					segments: effective,
					discontinuities,
					warnings,
					expected: segments.at(-1)?.after,
					uncertain: bucket.some(
						(record) => record.status === "pending" || (record.status === "done" && !record.after),
					),
					...(workspace ? { fs: workspace.fs } : {}),
				};
				entries.push(entry);
			}
			entries.sort(
				(left, right) =>
					Number(right.workspaceId === here.id) - Number(left.workspaceId === here.id) ||
					left.workspaceLabel.localeCompare(right.workspaceLabel) ||
					left.workspaceId.localeCompare(right.workspaceId) ||
					left.path.localeCompare(right.path),
			);

			/**
			 * Bytes of a retained image. A legacy record without a retained image
			 * may still be served from disk, but only bytes whose digest equals
			 * the receipt: content addressing makes them the session's own.
			 */
			const bytesOf = async (entry: Entry, state: FileSnapshot): Promise<Uint8Array | undefined> => {
				if (state.kind !== "file") return undefined;
				const retained = store.blob(state.hash);
				if (retained) return retained;
				if (!entry.fs || state.size > LEGACY_READ_LIMIT) return undefined;
				try {
					const stat = await entry.fs.stat(entry.path, { hash: false, signal });
					if (stat.kind !== "file" || stat.symlink || stat.size > LEGACY_READ_LIMIT) return undefined;
					const read = await entry.fs.readBytes(entry.path, LEGACY_READ_LIMIT, signal);
					return !read.truncated && sha256Hex(read.bytes) === state.hash ? read.bytes : undefined;
				} catch {
					signal.throwIfAborted();
					return undefined;
				}
			};

			const checkDrift = async (entry: Entry): Promise<void> => {
				const expected = entry.expected;
				if (!expected) return;
				if (!entry.fs) {
					entry.drift = {
						kind: "unverified",
						expected,
						note: "workspace is not reachable, so its current state could not be checked",
					};
					return;
				}
				try {
					const now = await observe(entry.fs, entry.path, signal);
					if (!now.state) {
						entry.drift = { kind: "unverified", expected, note: now.note! };
						return;
					}
					const relation = compareState(expected, now.state);
					if (relation === "same") return;
					entry.drift = {
						kind: relation === "unknown" ? "unverified" : entry.uncertain ? "uncertain" : "external",
						expected,
						current: now.state,
						note:
							relation === "unknown"
								? "content matches, but permission drift cannot be checked because legacy modes were not recorded"
								: entry.uncertain
									? "differs from the last confirmed receipt; an unconfirmed operation may account for it, so external attribution is unknown"
									: "changed outside this session since its last confirmed change",
					};
				} catch (error) {
					signal.throwIfAborted();
					entry.drift = {
						kind: "unverified",
						expected,
						note: `current state could not be read: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			};

			const render = async (entry: Entry, segment: Segment): Promise<Rendered> => {
				const { before, after } = segment;
				const warnings: string[] = [];
				const facts: string[] = [];
				const status = before.kind === "missing" ? "A" : after.kind === "missing" ? "D" : "M";
				const oldMode = modeOf(before);
				const newMode = modeOf(after);
				if (
					(before.kind !== "missing" && oldMode === undefined) ||
					(after.kind !== "missing" && newMode === undefined)
				) {
					warnings.push("Legacy permissions were not recorded; a mode change cannot be determined.");
				}
				if (oldMode !== undefined && newMode !== undefined && oldMode !== newMode)
					facts.push(`mode ${modeText(oldMode)} → ${modeText(newMode)}`);
				else if (before.kind === "missing" && newMode !== undefined) facts.push(`mode ${modeText(newMode)}`);

				if (isDir(before) && isDir(after)) {
					if (!facts.length) facts.push("directory permissions unavailable");
					return { status, summary: facts.join("; "), patch: "", added: 0, removed: 0, warnings };
				}
				if (isDir(after))
					facts.push(before.kind === "missing" ? "directory created" : "replaced by a directory");
				if (isDir(before))
					facts.push(after.kind === "missing" ? "directory removed" : "directory replaced by a file");

				const leftFile = before.kind === "file" ? before : undefined;
				const rightFile = after.kind === "file" ? after : undefined;
				if (!leftFile && !rightFile)
					return { status, summary: facts.join("; "), patch: "", added: 0, removed: 0, warnings };
				if (leftFile && rightFile && leftFile.hash === rightFile.hash) {
					facts.push("content unchanged");
					return { status, summary: facts.join("; "), patch: "", added: 0, removed: 0, warnings };
				}

				const leftBytes = leftFile ? await bytesOf(entry, leftFile) : undefined;
				const rightBytes = rightFile ? await bytesOf(entry, rightFile) : undefined;
				if ((leftFile && !leftBytes) || (rightFile && !rightBytes)) {
					for (const [side, state, bytes] of [
						["before", leftFile, leftBytes],
						["after", rightFile, rightBytes],
					] as const) {
						if (state && !bytes)
							warnings.push(
								`The ${side}-image (${describe(state)}) is not retained and cannot be verified on disk, so its content diff is unavailable.`,
							);
					}
					facts.push(`content ${describe(before)} → ${describe(after)} (diff unavailable)`);
					return { status, summary: facts.join("; "), patch: "", added: 0, removed: 0, warnings };
				}
				const fromText = leftBytes ? decodeText(leftBytes) : "";
				const toText = rightBytes ? decodeText(rightBytes) : "";
				if (fromText === undefined || toText === undefined) {
					facts.push(
						`binary content ${leftFile ? `${leftFile.hash.slice(0, 12)} (${formatBytes(leftFile.size)})` : "none"} → ${rightFile ? `${rightFile.hash.slice(0, 12)} (${formatBytes(rightFile.size)})` : "none"}`,
					);
					return { status, summary: facts.join("; "), patch: "", added: 0, removed: 0, warnings };
				}
				let patch = contentDiff(fromText, toText, entry.shown);
				if (patch) {
					const lines = patch.split("\n");
					if (!leftFile) lines[0] = "--- /dev/null";
					if (!rightFile) lines[1] = "+++ /dev/null";
					patch = lines.join("\n");
				} else if (!leftFile || !rightFile) {
					facts.push(`empty file ${rightFile ? "created" : "removed"}`);
				}
				return { status, summary: facts.join("; "), patch, ...countLines(patch), warnings };
			};

			const page = entries.slice(offset, offset + limit);
			const lines: string[] = [];
			const patches: string[] = [];
			const warnings: string[] = [];
			const external: string[] = [];
			const detailEntries: Json[] = [];
			let heading: string | undefined;
			for (const entry of page) {
				signal.throwIfAborted();
				await checkDrift(entry);
				const workspaceHeading = `[${entry.workspaceLabel}]`;
				if (entry.workspaceId !== heading) {
					heading = entry.workspaceId;
					lines.push(workspaceHeading);
				}
				const qualified = `${workspaceHeading} ${entry.shown}`;
				const entryWarnings = [...entry.warnings];
				const renderedSegments: Json[] = [];
				for (const [index, segment] of entry.segments.entries()) {
					const rendered = await render(entry, segment);
					const part = entry.segments.length > 1 ? ` (own change ${index + 1}/${entry.segments.length})` : "";
					const stats = rendered.added || rendered.removed ? ` +${rendered.added} -${rendered.removed}` : "";
					lines.push(
						`${rendered.status} ${entry.shown}${part}${stats}${rendered.summary ? ` — ${rendered.summary}` : ""}`,
					);
					if (rendered.patch || rendered.summary)
						patches.push(
							`=== ${qualified}${part}: ${rendered.status}${rendered.summary ? ` ${rendered.summary}` : ""}\n${rendered.patch}`,
						);
					entryWarnings.push(...rendered.warnings);
					renderedSegments.push({
						status: rendered.status,
						summary: rendered.summary,
						before: snapshotJson(segment.before),
						after: snapshotJson(segment.after),
						operations: segment.records.map((record) => record.operation),
						checkpoints: [...new Set(segment.records.map((record) => record.checkpointId))],
						added: rendered.added,
						removed: rendered.removed,
						warnings: rendered.warnings,
					});
				}
				if (!entry.segments.length)
					lines.push(`? ${entry.shown} — no confirmed net change (see evidence below)`);
				for (const warning of entryWarnings) warnings.push(`${qualified}: ${warning}`);
				for (const gap of entry.discontinuities)
					external.push(
						`${qualified}: changed outside this session before ${time(gap.at)} (expected ${describe(gap.expected)}, found ${describe(gap.found)}); that change is not included above.`,
					);
				if (entry.drift)
					(entry.drift.kind === "external" ? external : warnings).push(
						`${qualified}: ${entry.drift.note}${entry.drift.current ? ` (last receipt ${describe(entry.drift.expected)}, now ${describe(entry.drift.current)})` : ""}.`,
					);
				detailEntries.push({
					workspace: entry.workspaceLabel,
					workspaceId: entry.workspaceId,
					path: entry.path,
					shown: entry.shown,
					changes: renderedSegments,
					discontinuities: entry.discontinuities.map((gap) => ({
						at: gap.at,
						expected: snapshotJson(gap.expected),
						found: snapshotJson(gap.found),
					})),
					...(entry.drift
						? {
								drift: {
									kind: entry.drift.kind,
									note: entry.drift.note,
									expected: snapshotJson(entry.drift.expected),
									current: snapshotJson(entry.drift.current),
								},
							}
						: {}),
					warnings: entryWarnings,
				});
			}

			const scope = `${checkpoint ? `since rewind point ${checkpoint}` : "for the whole session"}${requestedPath ? ` under ${requestedPath}` : ""}`;
			const nextOffset = offset + page.length < entries.length ? offset + page.length : undefined;
			const segments = entries.reduce((count, entry) => count + entry.segments.length, 0);
			const shownSegments = page.reduce((count, entry) => count + entry.segments.length, 0);
			const sections = [
				`${notice}${entries.length} distinct path(s), ${segments} change segment(s) with net tracked changes or unresolved evidence ${scope}${entries.length ? `; showing paths ${page.length ? `${offset + 1}-${offset + page.length}` : "none"} (${shownSegments} change segments)` : ""}. Source: salam's mutation journal (git not used; shell and MCP writes are not tracked).`,
			];
			if (lines.length) sections.push(lines.join("\n"));
			if (warnings.length) sections.push(`Warnings:\n${warnings.map((line) => `- ${line}`).join("\n")}`);
			if (external.length)
				sections.push(
					`External activity (not attributed to this session):\n${external.map((line) => `- ${line}`).join("\n")}`,
				);
			if (nextOffset !== undefined) sections.push(`[continue with offset=${nextOffset}]`);
			// The runtime bounds text + diff together and stores the complete page
			// as an artifact. Never clip patches here: all omitted bytes must be recoverable.
			const diff = patches.join("\n\n");
			return {
				text: sections.join("\n\n"),
				...(diff ? { diff } : {}),
				details: {
					sessionId,
					...(checkpoint ? { checkpoint } : {}),
					...(filter ? { path: filter } : {}),
					total: entries.length,
					offset,
					shown: page.length,
					...(nextOffset !== undefined ? { nextOffset } : {}),
					entries: detailEntries,
				},
			};
		},
	});
}
