import { Buffer } from "node:buffer";
import { posix } from "node:path";
import type { ToolContext } from "../../contracts.ts";
import { mutationPublication } from "../atomic-io.ts";
import { sha256Hex, ToolFailure } from "../util.ts";
import type { ToolEnvironment, Workspace } from "../workspace.ts";
import type { TextEdit, WorkspaceEdit, DocumentChange } from "./client.ts";
import { uriToPath } from "./manager.ts";

export interface FileVersion {
	path: string;
	before: string | null;
	after: string | null;
	beforeMode?: number;
	afterMode?: number;
}
export interface EditPlan {
	steps: FileVersion[];
	initial: Map<string, string | null>;
	modes?: Map<string, number>;
}
const MAX_BYTES = 8 * 1024 * 1024;

export function applyTextEdits(text: string, edits: TextEdit[], path: string): string {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	const offset = (position: { line: number; character: number }) => {
		const start = starts[position.line];
		let end = starts[position.line + 1] === undefined ? text.length : starts[position.line + 1]! - 1;
		if (text[end - 1] === "\r") end--;
		if (
			start === undefined ||
			!Number.isInteger(position.character) ||
			position.character < 0 ||
			start + position.character > end
		)
			throw new ToolFailure(`Invalid edit range in ${path}.`);
		return start + position.character;
	};
	const ordered = edits
		.map((edit) => ({ start: offset(edit.range.start), end: offset(edit.range.end), value: edit.newText }))
		.sort((a, b) => b.start - a.start || b.end - a.end);
	let boundary = text.length + 1;
	for (const edit of ordered) {
		if (edit.start > edit.end || edit.end > boundary)
			throw new ToolFailure(`Overlapping or reversed edit ranges in ${path}.`);
		text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
		boundary = edit.start;
	}
	if (Buffer.byteLength(text) > MAX_BYTES) throw new ToolFailure(`Edited document exceeds 8 MiB: ${path}`);
	return text;
}

/** Simulate every ordered operation before performing any mutation. */
export async function planWorkspaceEdit(
	workspace: Workspace,
	edit: WorkspaceEdit,
	signal: AbortSignal,
	versions?: Map<string, number>,
): Promise<EditPlan> {
	const initial = new Map<string, string | null>();
	const current = new Map<string, string | null>();
	const modes = new Map<string, number>();
	const currentModes = new Map<string, number>();
	const steps: FileVersion[] = [];
	const load = async (path: string): Promise<string | null> => {
		if (current.has(path)) return current.get(path)!;
		for (let parent = posix.dirname(path); ; parent = posix.dirname(parent)) {
			if (current.get(parent) != null)
				throw new ToolFailure(`A resource destination's parent is a file: ${parent}`);
			const ancestor = await workspace.fs.stat(parent, { hash: false, signal });
			if (ancestor.kind !== "missing") {
				if (ancestor.kind !== "dir")
					throw new ToolFailure(`A resource destination's parent is not a directory: ${parent}`);
				break;
			}
			if (parent === "/") break;
		}
		const stat = await workspace.fs.stat(path, { signal });
		if (stat.symlink || !["missing", "file"].includes(stat.kind))
			throw new ToolFailure(`Workspace edits require regular files, not directories or links: ${path}`);
		let text: string | null = null;
		if (stat.kind === "file") {
			if (stat.mode !== undefined) {
				modes.set(path, stat.mode);
				currentModes.set(path, stat.mode);
			}
			const read = await workspace.fs.readBytes(path, MAX_BYTES, signal);
			if (read.truncated || read.bytes.includes(0))
				throw new ToolFailure(`Workspace edit cannot safely read ${path}.`);
			try {
				text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
			} catch {
				throw new ToolFailure(`Workspace edit requires UTF-8: ${path}`);
			}
			if (sha256Hex(read.bytes) !== stat.hash)
				throw new ToolFailure(`${path} changed while preparing the workspace edit.`);
		}
		initial.set(path, text);
		current.set(path, text);
		return text;
	};
	const set = (
		path: string,
		before: string | null,
		after: string | null,
		afterMode = currentModes.get(path),
	) => {
		const beforeMode = currentModes.get(path);
		if (before !== after || beforeMode !== afterMode)
			steps.push({ path, before, after, beforeMode, afterMode });
		current.set(path, after);
		if (after === null) currentModes.delete(path);
		else if (afterMode !== undefined) currentModes.set(path, afterMode);
	};
	const changes: DocumentChange[] =
		edit.documentChanges ??
		Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({
			textDocument: { uri, version: null },
			edits,
		}));
	for (const change of changes) {
		if (!("kind" in change)) {
			const path = uriToPath(change.textDocument.uri);
			if (change.textDocument.version != null && versions?.get(path) !== change.textDocument.version)
				throw new ToolFailure(`The server supplied an unverified document version for ${path}.`);
			const before = await load(path);
			if (before === null) throw new ToolFailure(`Cannot edit missing file ${path}.`);
			set(path, before, applyTextEdits(before, change.edits, path));
		} else if (change.kind === "create") {
			const path = uriToPath(change.uri);
			const before = await load(path);
			if (before !== null && !change.options?.overwrite) {
				if (change.options?.ignoreIfExists) continue;
				throw new ToolFailure(`Create destination exists: ${path}`);
			}
			set(path, before, "");
		} else if (change.kind === "rename") {
			const from = uriToPath(change.oldUri),
				to = uriToPath(change.newUri);
			if (from === to) continue;
			const source = await load(from),
				destination = await load(to);
			if (source === null) throw new ToolFailure(`Rename source missing: ${from}`);
			if (destination !== null && !change.options?.overwrite) {
				if (change.options?.ignoreIfExists) continue;
				throw new ToolFailure(`Rename destination exists: ${to}`);
			}
			set(to, destination, source, currentModes.get(from));
			set(from, source, null);
		} else {
			const path = uriToPath(change.uri),
				before = await load(path);
			if (before === null && !change.options?.ignoreIfNotExists)
				throw new ToolFailure(`Delete target missing: ${path}`);
			set(path, before, null);
		}
	}
	return { steps, initial, modes };
}

export async function rollbackEdits(
	workspace: Workspace,
	steps: FileVersion[],
	uncertain: Iterable<string> = [],
): Promise<{
	restored: FileVersion[];
	failures: string[];
	uncertainPaths: string[];
	recoveryPaths: string[];
}> {
	const failures: string[] = [];
	const restored: FileVersion[] = [];
	const uncertainPaths = new Set(uncertain),
		recoveryPaths = new Set<string>();
	for (const step of steps.slice().reverse()) {
		if (uncertainPaths.has(step.path)) {
			failures.push(`${step.path}: rollback skipped because a mutation may still publish.`);
			continue;
		}
		try {
			if (step.before === null) await workspace.fs.remove(step.path, undefined, sha256Hex(step.after!));
			else {
				await workspace.fs.write(
					step.path,
					step.before,
					undefined,
					step.after === null ? null : sha256Hex(step.after),
				);
				if (step.beforeMode !== undefined)
					await workspace.fs.chmod(step.path, step.beforeMode, undefined, sha256Hex(step.before));
			}
			restored.push({
				path: step.path,
				before: step.after,
				after: step.before,
				beforeMode: step.afterMode,
				afterMode: step.beforeMode,
			});
		} catch (rollback) {
			failures.push(`${step.path}: ${String(rollback)}`);
			if (mutationPublication(rollback) === "unknown") uncertainPaths.add(step.path);
			const details = rollback instanceof ToolFailure ? rollback.details : undefined;
			if (
				details &&
				typeof details === "object" &&
				!Array.isArray(details) &&
				Array.isArray(details.recoveryPaths)
			) {
				for (const path of details.recoveryPaths) if (typeof path === "string") recoveryPaths.add(path);
			}
		}
	}
	return {
		restored: restored.filter((step) => !uncertainPaths.has(step.path)),
		failures,
		uncertainPaths: [...uncertainPaths],
		recoveryPaths: [...recoveryPaths],
	};
}

/** All writes use CAS; rollback never overwrites an intervening external edit. */
export async function commitEditPlan(
	environment: ToolEnvironment,
	workspace: Workspace,
	context: ToolContext,
	plan: EditPlan,
): Promise<void> {
	for (const [path, text] of plan.initial) {
		const stat = await workspace.fs.stat(path, { signal: context.signal });
		if (
			stat.symlink ||
			(text === null ? stat.kind !== "missing" : stat.kind !== "file" || stat.hash !== sha256Hex(text))
		)
			throw new ToolFailure(`${path} changed since the edit was prepared; no changes applied.`);
		if (plan.modes?.has(path) && stat.mode !== plan.modes.get(path))
			throw new ToolFailure(`${path} permissions changed since preparation; no changes applied.`);
	}
	if (!plan.steps.length) return;
	await context.checkMutationPaths?.([...plan.initial.keys()]);
	const recovery = await environment.artifacts.store(
		context.sessionId,
		"edit-recovery",
		JSON.stringify(
			{
				workspace: workspace.label,
				files: [...plan.initial].map(([path, text]) => ({
					path,
					hash: text === null ? null : sha256Hex(text),
					content: text,
					mode: plan.modes?.get(path),
				})),
			},
			null,
			2,
		),
	);
	const completed: FileVersion[] = [];
	let activePath: string | undefined;
	try {
		for (const step of plan.steps) {
			activePath = step.path;
			if (step.after === null) await workspace.fs.remove(step.path, context.signal, sha256Hex(step.before!));
			else
				await workspace.fs.write(
					step.path,
					step.after,
					context.signal,
					step.before === null ? null : sha256Hex(step.before),
				);
			completed.push(step);
			if (
				step.after !== null &&
				step.afterMode !== undefined &&
				(step.before === null || step.afterMode !== step.beforeMode)
			)
				await workspace.fs.chmod(step.path, step.afterMode, context.signal, sha256Hex(step.after));
		}
	} catch (error) {
		const uncertain =
			mutationPublication(error) === "unknown" && activePath !== undefined ? [activePath] : [];
		const rollback = await rollbackEdits(workspace, completed, uncertain);
		const details = error instanceof ToolFailure ? error.details : undefined;
		const retained =
			details &&
			typeof details === "object" &&
			!Array.isArray(details) &&
			Array.isArray(details.recoveryPaths)
				? details.recoveryPaths.filter((path): path is string => typeof path === "string")
				: [];
		const recoveryPaths = [...new Set([...retained, ...rollback.recoveryPaths])];
		const rollbackComplete = rollback.failures.length === 0 && rollback.uncertainPaths.length === 0;
		throw new ToolFailure(
			`Workspace edit failed: ${String(error)}\n${rollbackComplete ? "All completed steps were rolled back." : `Rollback was incomplete; external changes were preserved.\n${rollback.failures.join("\n")}${rollback.uncertainPaths.length ? `\nPublication remains uncertain; do not retry or rewind until settled: ${rollback.uncertainPaths.join(", ")}` : ""}`}\nOriginal contents and hashes: ${recovery.uri}`,
			{
				recovery: recovery.uri,
				publication: rollbackComplete ? "rolled-back" : "unknown",
				rollbackComplete,
				failures: rollback.failures,
				uncertainPaths: rollback.uncertainPaths,
				recoveryPaths,
			},
		);
	}
	for (const step of plan.steps)
		if (step.after !== null)
			environment.freshness.record(
				context,
				workspace.id,
				step.path,
				sha256Hex(step.after),
				Buffer.byteLength(step.after),
			);
}
