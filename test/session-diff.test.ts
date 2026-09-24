import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Arguments, ToolContext, ToolOutput } from "../src/contracts.ts";
import { createSessionDiffTool } from "../src/runtime/changes.ts";
import { FileCheckpoints } from "../src/runtime/checkpoints.ts";
import {
	type FileMutationInput,
	type FileSnapshot,
	type MutationStatus,
	type SessionRecord,
	Store,
} from "../src/runtime/store.ts";
import { ArtifactStore } from "../src/tools/artifacts.ts";
import { LocalExecutor } from "../src/tools/exec.ts";
import { LocalFs } from "../src/tools/fs.ts";
import { sha256Hex } from "../src/tools/util.ts";
import { Workspace } from "../src/tools/workspace.ts";

let home: string;
let project: string;
let store: Store;
let workspace: Workspace;
let checkpoints: FileCheckpoints;
let session: SessionRecord;
let context: ToolContext;

interface DiffDetails {
	total: number;
	shown: number;
	nextOffset?: number;
	entries: {
		workspaceId: string;
		path: string;
		changes: {
			status: string;
			summary: string;
			before: FileSnapshot;
			after: FileSnapshot;
			added: number;
			removed: number;
			warnings: string[];
		}[];
		discontinuities: { expected: FileSnapshot; found: FileSnapshot }[];
		drift?: { kind: string; expected: FileSnapshot; current: FileSnapshot | null };
		warnings: string[];
	}[];
}

function details(output: ToolOutput): DiffDetails {
	expect(output.isError).not.toBe(true);
	if (!output.details) throw new Error(`Missing session diff details: ${output.text}`);
	return output.details as unknown as DiffDetails;
}

function point(id = "point-1"): void {
	store.captureCheckpoint(session, 0, id, id, "user");
}

function diff(args: Arguments = {}, toolContext = context): Promise<ToolOutput> {
	return createSessionDiffTool(
		store,
		() => workspace,
		() => session.id,
	).execute(args, toolContext);
}

function image(
	content: string | Uint8Array,
	mode: number | null = 0o644,
	retain = true,
): Extract<FileSnapshot, { kind: "file" }> {
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	const hash = sha256Hex(bytes);
	if (retain) store.putBlob(hash, bytes);
	return { kind: "file", hash, size: bytes.length, ...(mode === null ? {} : { mode }) };
}

/** Historical/interrupted receipts that cannot be produced by a successful current write. */
function record(
	path: string,
	before: FileSnapshot,
	after: FileSnapshot | undefined,
	status: MutationStatus = "done",
	extra: Partial<FileMutationInput> = {},
): number {
	const id = store.recordMutation({
		sessionId: session.id,
		checkpointId: "point-1",
		workspaceId: workspace.id,
		cwd: project,
		path,
		operation: "write",
		before,
		at: Date.now(),
		...extra,
	});
	if (status !== "pending") store.settleMutation(id, status, after);
	return id;
}

beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "salam-session-diff-")));
	project = join(home, "project");
	await mkdir(project);
	store = new Store(join(home, "state"));
	workspace = new Workspace("local", "this machine", new LocalExecutor(project), new LocalFs(), false);
	checkpoints = new FileCheckpoints(store, () => workspace);
	const id = crypto.randomUUID();
	const selection = { provider: "anthropic", model: "claude" };
	session = {
		id,
		title: "session diff",
		cwd: project,
		selection,
		system: [],
		tools: [],
		activeTools: [],
		firstUserText: "",
		notebook: "",
		contexts: [{ selection, sessionId: id, cacheKey: id, contextStart: 0, tokens: 0 }],
		instructions: [],
		updatedAt: Date.now(),
	};
	store.save(session);
	context = {
		cwd: project,
		sessionId: id,
		agentId: "main",
		signal: new AbortController().signal,
		emit: () => undefined,
	};
});

afterEach(async () => {
	store.close();
	await workspace.close();
	await rm(home, { recursive: true, force: true });
});

test("root-owned child edits collapse to a persistent net diff outside git", async () => {
	const path = join(project, "shared.txt");
	await writeFile(path, "original\n");
	const child = { ...context, sessionId: crypto.randomUUID(), agentId: "worker" };
	point();
	await checkpoints.run("point-1", child, () =>
		workspace.fs.write(path, "intermediate\n", context.signal, sha256Hex("original\n")),
	);
	point("point-2");
	await checkpoints.run("point-2", context, () =>
		workspace.fs.write(path, "final\n", context.signal, sha256Hex("intermediate\n")),
	);
	const first = await diff({}, child);
	expect(details(first).entries.map((entry) => entry.path)).toEqual([path]);
	expect(details(first).entries[0]!.changes).toHaveLength(1);
	expect(first.diff).toContain("-original\n+final\n");
	expect(first.diff).not.toContain("intermediate");
	expect(await Bun.file(join(project, ".git")).exists()).toBe(false);

	await writeFile(path, "outside after commit\n");
	store.close();
	store = new Store(join(home, "state"));
	const resumed = await diff();
	expect(resumed.diff).toBe(first.diff);
	expect(details(resumed).entries[0]!.drift).toMatchObject({
		kind: "external",
		expected: { hash: sha256Hex("final\n") },
		current: { hash: sha256Hex("outside after commit\n") },
	});
	expect(resumed.diff).not.toContain("outside after commit");
});

test("external interleaving splits own changes instead of attributing outside additions", async () => {
	const path = join(project, "interleaved.txt");
	await writeFile(path, "baseline\n");
	point();
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(path, "own first\n", undefined, sha256Hex("baseline\n")),
	);
	await writeFile(path, "outside between writes\n");
	point("point-2");
	await checkpoints.run("point-2", context, () =>
		workspace.fs.write(path, "own second\n", undefined, sha256Hex("outside between writes\n")),
	);
	await writeFile(path, "outside latest\n");
	const result = await diff();
	const entry = details(result).entries[0]!;
	expect(entry.changes).toHaveLength(2);
	expect(entry.discontinuities).toEqual([
		expect.objectContaining({
			expected: expect.objectContaining({ hash: sha256Hex("own first\n") }),
			found: expect.objectContaining({ hash: sha256Hex("outside between writes\n") }),
		}),
	]);
	expect(entry.drift?.kind).toBe("external");
	expect(result.diff).toContain("-baseline\n+own first\n");
	expect(result.diff).toContain("-outside between writes\n+own second\n");
	expect(result.diff).not.toContain("+outside between writes");
	expect(result.diff).not.toContain("outside latest");
});

test("undo and net-zero create/remove or edit cycles disappear without hiding retained edits", async () => {
	const path = join(project, "kept.txt");
	const temporary = join(project, "temporary.txt");
	const cycle = join(project, "cycle.txt");
	await writeFile(path, "original\n");
	await writeFile(cycle, "cycle original\n");
	point();
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(path, "kept\n", undefined, sha256Hex("original\n")),
	);
	point("point-2");
	await checkpoints.run("point-2", context, async () => {
		await workspace.fs.write(path, "undone\n", undefined, sha256Hex("kept\n"));
		await workspace.fs.write(temporary, "temporary\n", undefined, null);
		await workspace.fs.remove(temporary, undefined, sha256Hex("temporary\n"));
		await workspace.fs.write(cycle, "cycle middle\n", undefined, sha256Hex("cycle original\n"));
		await workspace.fs.write(cycle, "cycle original\n", undefined, sha256Hex("cycle middle\n"));
	});
	expect(details(await diff()).entries.map((entry) => entry.path)).toEqual([path]);
	await checkpoints.restore(session.id, "point-2", context.signal);
	const restored = await diff();
	expect(restored.diff).toContain("-original\n+kept\n");
	expect(restored.diff).not.toContain("undone");
	expect(details(await diff({ checkpoint: "point-2" })).total).toBe(0);
	point("point-3");
	await checkpoints.run("point-3", context, () =>
		workspace.fs.write(path, "original\n", undefined, sha256Hex("kept\n")),
	);
	expect(details(await diff()).total).toBe(0);
});

test("checkpoint and directory filtering preserve stable recoverable pages", async () => {
	const area = join(project, "area");
	await mkdir(area);
	await mkdir(join(project, "area-other"));
	point();
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(join(area, "a.txt"), "old\n", undefined, null),
	);
	point("point-2");
	await checkpoints.run("point-2", context, async () => {
		await workspace.fs.write(join(area, "b.txt"), "second\n", undefined, null);
		await workspace.fs.write(join(area, "c.txt"), "third\n", undefined, null);
		await workspace.fs.write(join(project, "area-other", "d.txt"), "not in area\n", undefined, null);
	});
	const args = { checkpoint: "point-2", path: "area", limit: 1 };
	const first = details(await diff(args));
	expect(first.total).toBe(2);
	expect(first.entries.map((entry) => entry.path)).toEqual([join(area, "b.txt")]);
	expect(first.nextOffset).toBe(1);
	const second = details(await diff({ ...args, offset: first.nextOffset! }));
	expect(second.entries.map((entry) => entry.path)).toEqual([join(area, "c.txt")]);
	expect(second.nextOffset).toBeUndefined();
	const beyond = details(await diff({ ...args, offset: 20 }));
	expect(beyond.total).toBe(2);
	expect(beyond.entries).toEqual([]);
	expect((await diff({ checkpoint: "unknown" })).isError).toBe(true);
});

test("flat directory, binary and permission receipts report effects and disappear after undo", async () => {
	const directory = join(project, "created");
	const removed = join(project, "removed");
	const executable = join(project, "script.sh");
	await mkdir(removed, { mode: 0o750 });
	await writeFile(executable, "echo hello\n");
	await chmod(executable, 0o644);
	point();
	await checkpoints.run("point-1", context, async () => {
		await workspace.fs.mkdir(directory, context.signal, 0o750);
		await workspace.fs.write(join(directory, "child.txt"), "child contents\n", undefined, null);
		await workspace.fs.write(join(project, "binary.dat"), new Uint8Array([0, 255, 10]), undefined, null);
		await workspace.fs.chmod(executable, 0o755, undefined, sha256Hex("echo hello\n"));
		await workspace.fs.rmdir(removed, context.signal);
	});
	const result = await diff();
	const entries = details(result).entries;
	expect(entries.find((entry) => entry.path === directory)?.changes[0]).toMatchObject({
		status: "A",
		before: { kind: "missing" },
		after: { kind: "dir" },
	});
	expect(entries.find((entry) => entry.path === removed)?.changes[0]).toMatchObject({
		status: "D",
		before: { kind: "dir" },
		after: { kind: "missing" },
	});
	expect(entries.find((entry) => entry.path === executable)?.changes[0]).toMatchObject({
		before: { mode: 0o644 },
		after: { mode: 0o755 },
		added: 0,
		removed: 0,
	});
	expect(entries.find((entry) => entry.path.endsWith("binary.dat"))?.changes[0]?.summary).toContain("binary");
	expect(result.diff).toContain("+child contents\n");
	expect(result.diff).not.toContain("\u0000");
	await checkpoints.restore(session.id, "point-1", context.signal);
	expect(details(await diff()).total).toBe(0);
});

test("chained moves preserve the source deletion and final addition without transient paths", async () => {
	const a = join(project, "a.txt"),
		b = join(project, "b.txt"),
		c = join(project, "c.txt");
	await writeFile(a, "original\n");
	point();
	await checkpoints.run("point-1", context, async () => {
		await workspace.fs.write(a, "edited\n", undefined, sha256Hex("original\n"));
		await workspace.fs.move(a, b, undefined, sha256Hex("edited\n"), null);
		await workspace.fs.move(b, c, undefined, sha256Hex("edited\n"), null);
	});
	const result = await diff();
	expect(details(result).entries.map((entry) => entry.path)).toEqual([a, c]);
	expect(details(result).entries.map((entry) => entry.changes[0]!.status)).toEqual(["D", "A"]);
	expect(result.diff).toContain("--- a/a.txt\n+++ /dev/null");
	expect(result.diff).toContain("--- /dev/null\n+++ b/c.txt");
	expect(result.diff).toContain("-original\n");
	expect(result.diff).toContain("+edited\n");
	expect(result.diff).not.toContain("b.txt");
});

test("pending and receiptless outcomes remain uncertain while proven failures are omitted", async () => {
	const path = join(project, "uncertain.txt");
	const pending = join(project, "pending.txt");
	const failed = join(project, "failed.txt");
	point();
	record(path, image("original\n"), image("confirmed\n"));
	record(path, image("confirmed\n"), undefined);
	record(pending, { kind: "missing" }, undefined, "pending");
	record(failed, { kind: "missing" }, image("external\n"), "failed");
	await writeFile(path, "unknown publication\n");
	const result = await diff();
	const entries = details(result).entries;
	expect(entries.map((entry) => entry.path)).toEqual([pending, path]);
	expect(entries.find((entry) => entry.path === pending)?.changes).toEqual([]);
	expect(entries.find((entry) => entry.path === pending)?.warnings.join(" ")).toMatch(/unknown/);
	expect(entries.find((entry) => entry.path === path)?.drift?.kind).toBe("uncertain");
	expect(entries.find((entry) => entry.path === path)?.warnings.join(" ")).toMatch(/receipt/);
	expect(result.diff).toContain("+confirmed\n");
	expect(result.diff).not.toContain("unknown publication");
	expect(result.diff).not.toContain("+external");
});

test("legacy missing after bytes cannot be invented from external contents but matching disk bytes are usable", async () => {
	const path = join(project, "legacy.txt");
	point();
	record(path, image("before\n"), image("own legacy after\n", 0o644, false));
	await writeFile(path, "outside\n");
	await chmod(path, 0o644);
	const unavailable = await diff();
	expect(details(unavailable).entries[0]!.warnings.join(" ")).toMatch(/after-image.*unavailable/);
	expect(unavailable.diff).not.toContain("+outside");
	expect(details(unavailable).entries[0]!.drift?.kind).toBe("external");
	await writeFile(path, "own legacy after\n");
	const recovered = await diff();
	expect(recovered.diff).toContain("-before\n+own legacy after\n");
	expect(details(recovered).entries[0]!.warnings).toEqual([]);
});

test("unknown legacy modes do not bridge a gap into a falsely attributed permission change", async () => {
	const path = join(project, "legacy-mode.txt");
	point();
	record(path, image("original\n", 0o644), image("first\n", null));
	record(path, image("first\n", 0o755), image("second\n", 0o755));
	await writeFile(path, "second\n");
	await chmod(path, 0o755);
	const result = await diff();
	const entry = details(result).entries[0]!;
	expect(entry.changes).toHaveLength(2);
	expect(entry.discontinuities).toEqual([]);
	expect(entry.warnings.join(" ")).toMatch(/permissions/);
	expect(result.diff).toContain("-original\n+first\n");
	expect(result.diff).toContain("-first\n+second\n");
	expect(result.diff).not.toContain("mode 0644 → 0755");
});

test("offline workspaces retain their own labelled patches and do not enter local path filters", async () => {
	const path = join(project, "same-path.txt");
	point();
	record(path, { kind: "missing" }, image("local\n"));
	record(path, { kind: "missing" }, image("remote\n"), "done", {
		workspaceId: "ssh:offline",
		remote: { host: "offline.example", cwd: project },
	});
	await writeFile(path, "local\n");
	await chmod(path, 0o644);
	const tool = createSessionDiffTool(
		store,
		(toolContext) => {
			if (toolContext.remote) throw new Error("workspace offline");
			return workspace;
		},
		() => session.id,
	);
	const result = await tool.execute({}, context);
	expect(details(result).entries.map((entry) => entry.workspaceId)).toEqual(["local", "ssh:offline"]);
	expect(details(result).entries[1]!.drift?.kind).toBe("unverified");
	expect(result.diff).toContain("[offline.example]");
	expect(result.diff).toContain("+remote\n");
	const filtered = await tool.execute({ path }, context);
	expect(details(filtered).entries.map((entry) => entry.workspaceId)).toEqual(["local"]);
	expect(filtered.diff).not.toContain("+remote\n");
});

test("EOF-newline-only changes and header-looking source lines produce exact patch counts", async () => {
	const eof = join(project, "eof.txt");
	const headers = join(project, "headers.txt");
	await writeFile(eof, "same\n");
	await writeFile(headers, "--old\n");
	point();
	await checkpoints.run("point-1", context, async () => {
		await workspace.fs.write(eof, "same", undefined, sha256Hex("same\n"));
		await workspace.fs.write(headers, "++new\n", undefined, sha256Hex("--old\n"));
	});
	const result = await diff();
	expect(result.diff).toContain("-same\n+same\n\\ No newline at end of file");
	expect(result.diff).toContain("---old\n+++new\n");
	for (const entry of details(result).entries)
		expect(entry.changes[0]).toMatchObject({ added: 1, removed: 1 });
});

test("oversized page patches remain complete through the runtime artifact bounding contract", async () => {
	const path = join(project, "large.txt");
	const sourceLines = Array.from(
		{ length: 700 },
		(_, index) => `line-${index.toString().padStart(3, "0")} ${"x".repeat(100)}`,
	);
	point();
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(path, `${sourceLines.join("\n")}\n`, undefined, null),
	);
	const result = await diff({ limit: 1 });
	const artifacts = new ArtifactStore(join(home, "state"));
	const bounded = await artifacts.bound(`${result.text}\n\n${result.diff}`, {
		sessionId: session.id,
		label: "session_diff-diff",
	});
	expect(bounded.clipped).toBe(true);
	expect(bounded.artifact).toBeDefined();
	const complete = await readFile(artifacts.resolve(bounded.artifact!)!, "utf8");
	const recoveredLines = complete
		.split("\n")
		.filter((line) => line.startsWith("+line-"))
		.map((line) => line.slice(1));
	expect(recoveredLines).toEqual(sourceLines);
	expect(bounded.text).toContain(bounded.artifact!);
});
