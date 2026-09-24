import { posix } from "node:path";
import type { HarnessTool, ToolOutput } from "../contracts.ts";
import { mutationPublication } from "./atomic-io.ts";
import { missingParents, type WorkspaceFs } from "./fs.ts";
import { argBool, argOptionalString, argString, errorText, sha256Hex, ToolFailure } from "./util.ts";
import { defineTool, type ToolEnvironment } from "./workspace.ts";

const CAPTURE_LIMIT = 8 * 1024 * 1024;
interface Entry {
	path: string;
	kind: "file" | "dir";
	mode: number;
	hash?: string;
	bytes?: Uint8Array;
}
interface Step {
	path: string;
	apply(signal?: AbortSignal): Promise<void>;
	undo(): Promise<void>;
}

async function assertState(
	fs: WorkspaceFs,
	path: string,
	expected: Entry | undefined,
	signal?: AbortSignal,
): Promise<void> {
	const stat = await fs.stat(path, { signal });
	if (!expected && (stat.symlink || stat.kind !== "missing"))
		throw new ToolFailure(`Destination ${path} already exists and will not be overwritten.`, {
			publication: "unpublished",
			reason: "destination_exists",
			path,
		});
	if (
		expected &&
		(stat.symlink ||
			stat.kind !== expected.kind ||
			stat.mode !== expected.mode ||
			(expected.kind === "file" && stat.hash !== expected.hash))
	)
		throw new ToolFailure(`${path} changed since preflight; no change was attempted at this path.`, {
			publication: "unpublished",
		});
}

/** Enumerate with no-follow metadata and JSON-safe remote names, including hidden and empty directories. */
async function inspectTree(
	fs: WorkspaceFs,
	root: string,
	signal: AbortSignal,
	capture: boolean,
): Promise<Entry[]> {
	await missingParents(fs, posix.dirname(root), signal);
	const entries: Entry[] = [];
	let capturedBytes = 0;
	const visit = async (path: string): Promise<void> => {
		signal.throwIfAborted();
		const stat = await fs.stat(path, { signal });
		if (stat.symlink || (stat.kind !== "file" && stat.kind !== "dir") || stat.mode === undefined)
			throw new ToolFailure(
				`${path} is not a supported real file or directory. Symbolic links and special objects are refused.`,
			);
		if (entries.length >= 10000)
			throw new ToolFailure("Tree exceeds 10000 tracked entries; nothing was changed.");
		const entry: Entry = { path, kind: stat.kind, mode: stat.mode };
		if (stat.kind === "file") {
			capturedBytes += stat.size;
			if (capturedBytes > 64 * 1024 * 1024)
				throw new ToolFailure("Tree exceeds the 64 MiB reversible operation limit; nothing was changed.");
			if (stat.size > CAPTURE_LIMIT || !stat.hash)
				throw new ToolFailure(`${path} exceeds the reversible file-operation limit of 8 MiB.`);
			entry.hash = stat.hash;
			if (capture) {
				const read = await fs.readBytes(path, CAPTURE_LIMIT, signal);
				if (read.truncated || sha256Hex(read.bytes) !== stat.hash)
					throw new ToolFailure(`${path} changed during preflight.`);
				entry.bytes = read.bytes;
				await assertState(fs, path, entry, signal);
			}
		}
		entries.push(entry);
		if (stat.kind === "dir") for (const child of await fs.entries(path, signal)) await visit(child.path);
	};
	await visit(root);
	return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function treeHash(entries: Entry[], root: string): string {
	return sha256Hex(
		JSON.stringify(
			entries.map(({ path, kind, mode, hash }) => ({
				path: posix.relative(root, path),
				kind,
				mode,
				...(hash ? { hash } : {}),
			})),
		),
	);
}

/** Ordered guarded commits, not simultaneous filesystem visibility. Unknown remote publication is never guessed at. */
async function commit(steps: Step[], signal: AbortSignal): Promise<void> {
	const done: Step[] = [];
	try {
		for (const step of steps) {
			if (signal.aborted)
				throw new ToolFailure("Interrupted before the next operation.", { publication: "unpublished" });
			await step.apply(signal);
			done.push(step);
		}
	} catch (error) {
		if (mutationPublication(error) === "unknown")
			throw new ToolFailure(
				`File operation stopped with uncertain publication: ${errorText(error)}. Confirmed earlier paths were left in place to avoid racing an in-flight operation: ${done.map((step) => step.path).join(", ")}.`,
				{ publication: "unknown" },
			);
		const stuck: string[] = [];
		for (const step of done.toReversed()) {
			try {
				await step.undo();
			} catch (rollback) {
				stuck.push(`${step.path}: ${errorText(rollback)}`);
			}
		}
		throw new ToolFailure(
			`File operation failed: ${errorText(error)}. ${stuck.length ? `Conditional rollback preserved changed paths: ${stuck.join("; ")}` : "Completed steps were rolled back."}`,
			{ publication: stuck.length ? "unknown" : "rolled-back" },
		);
	}
}

export function createFileOperationTools(environment: ToolEnvironment): HarnessTool[] {
	return [
		defineTool({
			name: "file_ops",
			description:
				"Checkpointed mkdir, move and remove for regular files and populated directory trees; never overwrites a destination. inspect returns a reviewed tree_hash: pass expected_tree for directory move/remove. File move/remove requires expected_hash or a fresh read. Nonempty directory removal requires recursive:true. Links/special files are refused. Preflight all paths, ordered commits and conditional rollback preserve concurrent edits; this is not multi-path atomic visibility.",
			parameters: {
				type: "object",
				required: ["op", "path"],
				additionalProperties: false,
				properties: {
					op: { type: "string", enum: ["inspect", "mkdir", "move", "remove"] },
					path: { type: "string" },
					to: { type: "string" },
					recursive: { type: "boolean" },
					expected_hash: { type: "string" },
					expected_tree: { type: "string" },
					mode: {
						type: "integer",
						minimum: 0,
						maximum: 4095,
						description: "mkdir permissions (decimal); applied before publication",
					},
				},
			},
			async run(args, context): Promise<ToolOutput> {
				const op = argString(args, "op");
				if (!["inspect", "mkdir", "move", "remove"].includes(op))
					throw new ToolFailure("Unknown file operation.");
				const workspace = environment.workspace(context);
				const fs = workspace.fs;
				const path = workspace.resolvePath(context.cwd, argString(args, "path"));
				if (path === "/") throw new ToolFailure("Refusing a filesystem-root operation.");
				const steps: Step[] = [];
				const finalModes: Step[] = [];
				const touched = new Set<string>();
				let moved: { to: string; entries: Entry[] } | undefined;
				const make = (target: string, mode: number) => {
					touched.add(target);
					const temporaryMode = mode | 0o700;
					let receipt: Entry | undefined;
					steps.push({
						path: target,
						async apply(signal) {
							await assertState(fs, target, undefined, signal);
							await fs.mkdir(target, signal, temporaryMode);
							receipt = { path: target, kind: "dir", mode: temporaryMode };
						},
						async undo() {
							await assertState(fs, target, receipt);
							await fs.rmdir(target, undefined, receipt!.mode);
						},
					});
					if (temporaryMode !== mode)
						finalModes.unshift({
							path: target,
							async apply(signal) {
								await assertState(fs, target, receipt, signal);
								await fs.chmodDirectory(target, mode, signal, temporaryMode);
							},
							async undo() {
								await assertState(fs, target, { path: target, kind: "dir", mode });
								await fs.chmodDirectory(target, temporaryMode, undefined, mode);
							},
						});
				};
				if (op === "mkdir") {
					const rawMode = args.mode;
					if (
						rawMode !== undefined &&
						(typeof rawMode !== "number" || !Number.isInteger(rawMode) || rawMode < 0 || rawMode > 0o7777)
					)
						throw new ToolFailure("mode must be an integer between 0 and 4095.");
					const mode = typeof rawMode === "number" ? rawMode : 0o755;
					const parents = await missingParents(fs, path, context.signal);
					for (const parent of parents) make(parent, parent === path ? mode : 0o755);
					if (!parents.length)
						return { text: `${path} is already a real directory.`, details: { paths: [] } };
				} else {
					const entries = await inspectTree(fs, path, context.signal, op !== "inspect");
					const digest = treeHash(entries, path);
					if (op === "inspect")
						return {
							text: JSON.stringify(
								{ path, tree_hash: digest, entries: entries.map(({ bytes: _bytes, ...entry }) => entry) },
								null,
								2,
							),
							details: { path, tree_hash: digest },
						};
					const root = entries.find((entry) => entry.path === path)!;
					if (root.kind === "dir") {
						if (argOptionalString(args, "expected_tree") !== digest)
							throw new ToolFailure(
								"Tree is unread or has changed. Run file_ops inspect, review the entries, then retry with its expected_tree. Nothing was changed.",
								{ reason: "tree_review_required", path },
							);
						if (op === "remove" && entries.length > 1 && !argBool(args, "recursive", false))
							throw new ToolFailure("Removing a nonempty directory requires recursive:true.");
					} else {
						const expected =
							argOptionalString(args, "expected_hash") ??
							environment.freshness.get(context, workspace.id, path)?.hash;
						if (expected !== root.hash)
							throw new ToolFailure(
								`Read ${path} first or pass its current expected_hash (${root.hash}); stale/unread operation refused.`,
							);
					}
					let to: string | undefined;
					if (op === "move") {
						to = workspace.resolvePath(context.cwd, argString(args, "to"));
						if (to === path || to.startsWith(`${path}/`) || path.startsWith(`${to}/`))
							throw new ToolFailure("Source and destination must not overlap.");
						await assertState(fs, to, undefined, context.signal);
						moved = { to, entries };
						for (const parent of await missingParents(fs, posix.dirname(to), context.signal))
							make(parent, 0o755);
						for (const entry of entries
							.filter((entry) => entry.kind === "dir")
							.sort((a, b) => a.path.split("/").length - b.path.split("/").length))
							make(posix.join(to, posix.relative(path, entry.path)), entry.mode);
					}
					for (const entry of entries.filter((entry) => entry.kind === "file")) {
						touched.add(entry.path);
						if (to) {
							const destination = posix.join(to, posix.relative(path, entry.path));
							touched.add(destination);
							steps.push({
								path: entry.path,
								async apply(signal) {
									await assertState(fs, entry.path, entry, signal);
									await assertState(fs, destination, undefined, signal);
									await fs.move(entry.path, destination, signal, entry.hash!, null);
								},
								async undo() {
									await assertState(fs, destination, entry);
									await assertState(fs, entry.path, undefined);
									await fs.move(destination, entry.path, undefined, entry.hash!, null);
								},
							});
						} else
							steps.push({
								path: entry.path,
								async apply(signal) {
									await assertState(fs, entry.path, entry, signal);
									await fs.remove(entry.path, signal, entry.hash!);
								},
								async undo() {
									await assertState(fs, entry.path, undefined);
									await fs.write(entry.path, entry.bytes!, undefined, null, entry.mode);
								},
							});
					}
					for (const entry of entries
						.filter((entry) => entry.kind === "dir")
						.sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
						touched.add(entry.path);
						steps.push({
							path: entry.path,
							async apply(signal) {
								await assertState(fs, entry.path, entry, signal);
								await fs.rmdir(entry.path, signal, entry.mode);
							},
							async undo() {
								await assertState(fs, entry.path, undefined);
								await fs.mkdir(entry.path, undefined, entry.mode);
							},
						});
					}
					// Re-enumeration detects added/removed descendants before any mutation, not halfway through deletion.
					if (treeHash(await inspectTree(fs, path, context.signal, false), path) !== digest)
						throw new ToolFailure("Tree changed during preflight; nothing was changed.");
				}
				const paths = [...touched];
				await context.checkMutationPaths?.(paths);
				await commit([...steps, ...finalModes], context.signal);
				if (moved)
					for (const entry of moved.entries) {
						if (entry.kind !== "file") continue;
						environment.freshness.record(context, workspace.id, entry.path, "missing", 0);
						// Keep the committed preimage, not a later external save at the destination.
						environment.freshness.record(
							context,
							workspace.id,
							posix.join(moved.to, posix.relative(path, entry.path)),
							entry.hash!,
							entry.bytes!.byteLength,
						);
					}
				return {
					text: `${op} completed: ${path}${op === "move" ? ` -> ${argString(args, "to")}` : ""}. ${paths.length} tracked paths.`,
					details: { paths },
				};
			},
		}),
	];
}
