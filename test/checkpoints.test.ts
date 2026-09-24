import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry, ModelChoice, ModelContext, RewindPoint, ToolContext } from "../src/contracts.ts";
import { FileCheckpoints } from "../src/runtime/checkpoints.ts";
import { type SessionRecord, Store } from "../src/runtime/store.ts";
import { atomicRename } from "../src/tools/atomic-rename.ts";
import { LocalExecutor } from "../src/tools/exec.ts";
import { createFileOperationTools } from "../src/tools/file-ops.ts";
import { LocalFs } from "../src/tools/fs.ts";
import { sha256Hex, ToolFailure } from "../src/tools/util.ts";
import { FreshnessTracker, type ToolEnvironment, Workspace } from "../src/tools/workspace.ts";

/**
 * Rewind is the one feature in the harness that deletes work on purpose, so the
 * boundaries worth pinning are the ones where it must refuse: a file somebody
 * else changed, a multi-file restore that cannot be completed as a unit, and a
 * write whose outcome was never confirmed. The fork tests cover the other half
 * of the promise — that going back never damages the session you came from.
 */

let home = "";
let project = "";
let store: Store;
let workspace: Workspace;
let checkpoints: FileCheckpoints;
let session: SessionRecord;
let context: ToolContext;
let previousCache: string | undefined;

function entry(text: string, role: "user" | "assistant", input = 1): HistoryEntry {
	return {
		id: crypto.randomUUID(),
		kind: "message",
		message:
			role === "user"
				? { role, content: text, timestamp: Date.now() }
				: {
						role,
						content: [{ type: "text", text }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude",
						stopReason: "stop",
						usage: {
							input,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: input + 1,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					},
	};
}

/** A response carrying provider-signed reasoning that must survive a rewind byte for byte. */
function signed(text: string, selection: ModelChoice, signature: string): HistoryEntry {
	return {
		id: crypto.randomUUID(),
		kind: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `${text} reasoning`, thinkingSignature: signature },
				{ type: "text", text, textSignature: `${signature}-text` },
			],
			api: selection.provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses",
			provider: selection.provider,
			model: selection.model,
			responseId: `${signature}-response`,
			stopReason: "stop",
			usage: {
				input: 3,
				output: 2,
				cacheRead: 5,
				cacheWrite: 0,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
	};
}

beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "salam-home-")));
	project = await realpath(await mkdtemp(join(tmpdir(), "salam-project-")));
	previousCache = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = join(home, "cache");
	store = new Store(home);
	workspace = new Workspace("local", "this machine", new LocalExecutor(project), new LocalFs(), false);
	checkpoints = new FileCheckpoints(store, () => workspace);
	const id = crypto.randomUUID();
	const selection = { provider: "anthropic", model: "claude" };
	session = {
		id,
		title: "test",
		cwd: project,
		selection,
		system: ["base"],
		tools: [],
		activeTools: [],
		firstUserText: "",
		notebook: "",
		contexts: [{ selection: { ...selection }, sessionId: id, cacheKey: id, contextStart: 0, tokens: 0 }],
		instructions: [],
		updatedAt: Date.now(),
	};
	store.save(session);
	context = {
		cwd: project,
		sessionId: session.id,
		agentId: "main",
		signal: AbortSignal.any([]),
		emit: () => undefined,
	};
});

afterEach(async () => {
	store.close();
	if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = previousCache;
	await rm(home, { recursive: true, force: true });
	await rm(project, { recursive: true, force: true });
});

test("a rewind restores an edited file and removes a created one", async () => {
	const kept = join(project, "kept.ts");
	const made = join(project, "made.ts");
	await writeFile(kept, "original\n");
	await chmod(kept, 0o640);

	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await checkpoints.run("point-1", context, async () => {
		await workspace.fs.write(kept, "rewritten\n", undefined, sha256Hex("original\n"));
		await workspace.fs.write(made, "brand new\n", undefined, null);
		await workspace.fs.chmod(kept, 0o755, undefined, sha256Hex("rewritten\n"));
	});
	expect(await Bun.file(kept).text()).toBe("rewritten\n");

	const result = await checkpoints.restore(session.id, "point-1", AbortSignal.any([]));
	expect(result.files).toBe(2);
	expect(await Bun.file(kept).text()).toBe("original\n");
	expect((await stat(kept)).mode & 0o777).toBe(0o640);
	expect(await Bun.file(made).exists()).toBe(false);
});

test("a rewind recreates a deleted file with its original mode", async () => {
	const removed = join(project, "removed.sh");
	await writeFile(removed, "#!/bin/sh\necho hi\n");
	await chmod(removed, 0o751);

	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await checkpoints.run("point-1", context, () =>
		workspace.fs.remove(removed, undefined, sha256Hex("#!/bin/sh\necho hi\n")),
	);
	expect(await Bun.file(removed).exists()).toBe(false);

	await checkpoints.restore(session.id, "point-1", AbortSignal.any([]));
	expect(await Bun.file(removed).text()).toBe("#!/bin/sh\necho hi\n");
	expect((await stat(removed)).mode & 0o777).toBe(0o751);
});

test("a file changed outside salam is never overwritten by a rewind", async () => {
	const path = join(project, "shared.ts");
	await writeFile(path, "one\n");

	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(path, "two\n", undefined, sha256Hex("one\n")),
	);
	await writeFile(path, "somebody else\n");

	await expect(checkpoints.restore(session.id, "point-1", AbortSignal.any([]))).rejects.toThrow(
		/has changed since salam last wrote it/,
	);
	expect(await Bun.file(path).text()).toBe("somebody else\n");
});

test("an external edit between two harness writes blocks the rewind", async () => {
	const path = join(project, "drift.ts");
	await writeFile(path, "one\n");

	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(path, "two\n", undefined, sha256Hex("one\n")),
	);
	await writeFile(path, "outside\n");
	store.captureCheckpoint(session, 0, "point-2", "second", "user");
	await checkpoints.run("point-2", context, () =>
		workspace.fs.write(path, "three\n", undefined, sha256Hex("outside\n")),
	);

	await expect(checkpoints.restore(session.id, "point-1", AbortSignal.any([]))).rejects.toThrow(
		/edited outside salam between two of its own writes/,
	);
	expect(await Bun.file(path).text()).toBe("three\n");
});

test("one unrestorable path aborts the whole multi-file rewind before any byte moves", async () => {
	const safe = join(project, "safe.ts");
	const touched = join(project, "touched.ts");
	await writeFile(safe, "safe original\n");
	await writeFile(touched, "touched original\n");

	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await checkpoints.run("point-1", context, async () => {
		await workspace.fs.write(safe, "safe written\n", undefined, sha256Hex("safe original\n"));
		await workspace.fs.write(touched, "touched written\n", undefined, sha256Hex("touched original\n"));
	});
	await writeFile(touched, "somebody else\n");

	await expect(checkpoints.restore(session.id, "point-1", AbortSignal.any([]))).rejects.toThrow();
	expect(await Bun.file(safe).text()).toBe("safe written\n");
	expect(await Bun.file(touched).text()).toBe("somebody else\n");
});

test("an unconfirmed write is refused rather than treated as reversible", async () => {
	const path = join(project, "interrupted.ts");
	await writeFile(path, "before\n");

	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	// Exactly what an interruption between the durable record and the bytes
	// landing leaves behind: a mutation that was never settled.
	store.recordMutation({
		sessionId: session.id,
		checkpointId: "point-1",
		workspaceId: workspace.id,
		cwd: project,
		path,
		operation: "write",
		before: { kind: "file", hash: "0".repeat(64), size: 7, mode: 0o644 },
		at: Date.now(),
	});

	await expect(checkpoints.restore(session.id, "point-1", AbortSignal.any([]))).rejects.toThrow(
		/interrupted/,
	);
	expect(await Bun.file(path).text()).toBe("before\n");
});

test("a mutation too large to capture is refused instead of silently untracked", async () => {
	const path = join(project, "huge.bin");
	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await expect(
		checkpoints.run("point-1", context, () =>
			workspace.fs.write(path, new Uint8Array(9 * 1024 * 1024), undefined, null),
		),
	).rejects.toThrow(/rewind capture limit/);
	expect(await Bun.file(path).exists()).toBe(false);
});

test("a symlink is never rewritten while a rewind point is active", async () => {
	const target = join(project, "target.ts");
	const link = join(project, "link.ts");
	await writeFile(target, "target\n");
	await Bun.$`ln -s ${target} ${link}`.quiet();

	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await expect(
		checkpoints.run("point-1", context, () =>
			workspace.fs.write(link, "x\n", undefined, sha256Hex("target\n")),
		),
	).rejects.toThrow(/symbolic link/);
	expect(await Bun.file(target).text()).toBe("target\n");
});

test("an editor save at commit is not recorded as an undoable harness write", async () => {
	const path = join(project, "commit-race.ts");
	await writeFile(path, "original\n");
	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	const exchange = atomicRename.exchange;
	let injected = false;
	const hook = spyOn(atomicRename, "exchange").mockImplementation((source, target) => {
		if (!injected && target === path) {
			injected = true;
			writeFileSync(path, "human change after snapshot\n");
		}
		exchange(source, target);
	});
	try {
		await expect(
			checkpoints.run("point-1", context, () =>
				workspace.fs.write(path, "assistant\n", undefined, sha256Hex("original\n")),
			),
		).rejects.toThrow();
	} finally {
		hook.mockRestore();
	}
	expect(await Bun.file(path).text()).toBe("human change after snapshot\n");
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(path, "retry\n", undefined, sha256Hex("human change after snapshot\n")),
	);
	await checkpoints.restore(session.id, "point-1", context.signal);
	expect(await Bun.file(path).text()).toBe("human change after snapshot\n");
});

test("an unpublished preflight conflict does not poison a successful retry or another file's rewind", async () => {
	const path = join(project, "preflight.ts");
	const other = join(project, "other.ts");
	await writeFile(path, "original\n");
	await writeFile(other, "other original\n");
	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(other, "other changed\n", undefined, sha256Hex("other original\n")),
	);
	const record = store.recordMutation.bind(store);
	let injected = false;
	const hook = spyOn(store, "recordMutation").mockImplementation((mutation) => {
		const id = record(mutation);
		if (!injected && mutation.path === path) {
			injected = true;
			writeFileSync(path, "human version\n");
		}
		return id;
	});
	try {
		await expect(
			checkpoints.run("point-1", context, () =>
				workspace.fs.write(path, "refused\n", undefined, sha256Hex("original\n")),
			),
		).rejects.toThrow();
	} finally {
		hook.mockRestore();
	}
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(path, "retry\n", undefined, sha256Hex("human version\n")),
	);
	const restored = await checkpoints.restore(session.id, "point-1", context.signal);
	expect(restored.files).toBe(2);
	expect(await Bun.file(path).text()).toBe("human version\n");
	expect(await Bun.file(other).text()).toBe("other original\n");
});

test("a proven preflight refusal leaves external symlinks outside the rewind plan", async () => {
	const refused = join(project, "refused.ts");
	const other = join(project, "changed.ts");
	const target = join(project, "external.ts");
	await writeFile(refused, "before\n");
	await writeFile(other, "other before\n");
	await writeFile(target, "external\n");
	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(other, "changed\n", undefined, sha256Hex("other before\n")),
	);
	const record = store.recordMutation.bind(store);
	const hook = spyOn(store, "recordMutation").mockImplementation((mutation) => {
		const id = record(mutation);
		if (mutation.path === refused) {
			unlinkSync(refused);
			symlinkSync(target, refused);
		}
		return id;
	});
	try {
		await expect(
			checkpoints.run("point-1", context, () =>
				workspace.fs.write(refused, "proposal\n", undefined, sha256Hex("before\n")),
			),
		).rejects.toThrow();
	} finally {
		hook.mockRestore();
	}
	const restored = await checkpoints.restore(session.id, "point-1", context.signal);
	expect(restored.files).toBe(1);
	expect(await Bun.file(other).text()).toBe("other before\n");
	expect((await lstat(refused)).isSymbolicLink()).toBe(true);
	expect(await readlink(refused)).toBe(target);
	expect(await Bun.file(target).text()).toBe("external\n");
});

test("an unknown publication cannot be dismissed because the path still matches its snapshot", async () => {
	const path = join(project, "unknown.ts");
	await writeFile(path, "before\n");
	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	const hook = spyOn(atomicRename, "exchange").mockImplementation(() => {
		throw Object.assign(new Error("Publication receipt was lost"), { code: "EIO" });
	});
	try {
		await expect(
			checkpoints.run("point-1", context, () =>
				workspace.fs.write(path, "proposal\n", undefined, sha256Hex("before\n")),
			),
		).rejects.toThrow();
	} finally {
		hook.mockRestore();
	}
	expect(await Bun.file(path).text()).toBe("before\n");
	await expect(checkpoints.restore(session.id, "point-1", context.signal)).rejects.toThrow();
	expect(await Bun.file(path).text()).toBe("before\n");
});

test("checkpoint receipts never attribute an editor save after commit to salam", async () => {
	const path = join(project, "after-commit.ts");
	await writeFile(path, "original\n");
	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	const exchange = atomicRename.exchange;
	const hook = spyOn(atomicRename, "exchange").mockImplementation((source, target) => {
		exchange(source, target);
		if (target === path) writeFileSync(path, "outside after commit\n");
	});
	try {
		await checkpoints.run("point-1", context, () =>
			workspace.fs.write(path, "assistant\n", undefined, sha256Hex("original\n")),
		);
	} finally {
		hook.mockRestore();
	}
	const after = store.mutationsFrom(session.id, "point-1")[0]!.after;
	expect(after?.kind === "file" && after.hash).toBe(sha256Hex("assistant\n"));
	await expect(checkpoints.restore(session.id, "point-1", context.signal)).rejects.toThrow();
	expect(await Bun.file(path).text()).toBe("outside after commit\n");
});

test("an external save after rewind preflight survives the guarded restore", async () => {
	const path = join(project, "rewind-race.ts");
	await writeFile(path, "original\n");
	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await checkpoints.run("point-1", context, () =>
		workspace.fs.write(path, "assistant\n", undefined, sha256Hex("original\n")),
	);
	const exchange = atomicRename.exchange;
	let injected = false;
	const hook = spyOn(atomicRename, "exchange").mockImplementation((source, target) => {
		if (!injected && target === path) {
			injected = true;
			writeFileSync(path, "outside during rewind\n");
		}
		exchange(source, target);
	});
	try {
		await expect(checkpoints.restore(session.id, "point-1", context.signal)).rejects.toThrow();
	} finally {
		hook.mockRestore();
	}
	expect(await Bun.file(path).text()).toBe("outside during rewind\n");
	expect(store.mutationsFrom(session.id, "point-1").map((record) => record.status)).toEqual(["done"]);
});

test("forking after a compaction keeps a valid prefix and leaves the original intact", () => {
	const first = entry("first question", "user");
	const answer = entry("first answer", "assistant");
	const compaction: HistoryEntry = {
		id: crypto.randomUUID(),
		kind: "compaction",
		summary: "so far",
		provider: "anthropic",
		model: "claude",
	};
	const second = entry("second question", "user");
	store.append(session, first, answer, compaction);
	const window = session.contexts[0]!;
	window.compactionId = compaction.id;
	store.captureCheckpoint(session, 0, first.id, "first question", "user");
	const beforeSecond = store.history(session.id).at(-1)!.seq;
	window.contextStart = beforeSecond + 1;
	store.captureCheckpoint(session, beforeSecond, second.id, "second question", "user");
	store.append(session, second, entry("second answer", "assistant"));

	const original = [first.id, answer.id, compaction.id, second.id];
	const fork = store.forkCheckpoint(session.id, second.id);
	const forked = store.history(fork.id);
	expect(forked.map((row) => row.entry.kind)).toEqual(["message", "message", "compaction"]);
	expect(forked.every((row) => !original.includes(row.entry.id))).toBe(true);
	expect(fork.contexts[0]!.compactionId).toBe(forked[2]!.entry.id);
	expect(fork.contexts[0]!.contextStart).toBe(forked[2]!.seq + 1);
	expect(fork.parentId).toBeUndefined();

	// The session that was rewound away from keeps every entry it ever had.
	expect(store.history(session.id)).toHaveLength(5);
	expect(store.get(session.id)!.contexts[0]!.compactionId).toBe(compaction.id);

	// The point that survived the cut is still offered in the branch.
	const points = store.checkpoints(fork.id);
	expect(points).toHaveLength(1);
	expect(points[0]!.prompt).toBe("first question");
	expect(points[0]!.filesAvailable).toBe(true);
	expect(points[0]!.id).toBe(forked[0]!.entry.id);
});

test("legacy history without checkpoints is still rewindable, without claiming files", () => {
	const question = entry("legacy question", "user");
	const answer = entry("legacy answer", "assistant");
	store.append(session, question, answer);

	const points = store.checkpoints(session.id);
	expect(points.map((point) => point.kind)).toEqual(["user", "assistant"]);
	expect(points.every((point) => !point.filesAvailable)).toBe(true);
	expect(points[1]!.beforeSeq).toBe(store.history(session.id)[0]!.seq);

	const fork = store.forkCheckpoint(session.id, answer.id);
	expect(store.history(fork.id)).toHaveLength(1);
	expect(fork.firstUserText).toBe("legacy question");
	expect(store.history(session.id)).toHaveLength(2);
});

test("a rewind before the first user message keeps its cached head seed but not its text", () => {
	const question = entry("first question", "user");
	store.captureCheckpoint(session, 0, question.id, "first question", "user");
	session.firstUserText = "first question";
	session.cacheFirstUserText = "first question";
	store.append(session, question);
	const answer = entry("first answer", "assistant");
	store.captureCheckpoint(
		session,
		store.history(session.id).at(-1)!.seq,
		answer.id,
		"Assistant response",
		"assistant",
	);
	store.append(session, answer);

	const early = store.forkCheckpoint(session.id, question.id);
	expect(store.history(early.id)).toHaveLength(0);
	expect(early.firstUserText).toBe("");
	expect(early.cacheFirstUserText).toBe("first question");

	// A point copied into a later branch that predates the message carries the same seed.
	const later = store.forkCheckpoint(session.id, answer.id);
	const [before] = store.checkpoints(later.id);
	expect(before!.id).toBe(store.history(later.id)[0]!.entry.id);
	expect(before!.state.firstUserText).toBe("");
	expect(before!.state.cacheFirstUserText).toBe("first question");
	expect(later.firstUserText).toBe("first question");
});

test("a rewind across a model switch freezes every model's window at the chosen event", () => {
	const claude = session.selection;
	const gpt: ModelChoice = { provider: "openai-codex", model: "gpt" };
	const first = session.contexts[0]!;
	const seqOf = (id: string) => store.history(session.id).find((row) => row.entry.id === id)!.seq;
	const record = (item: HistoryEntry, prompt: string, kind: RewindPoint["kind"]) => {
		store.captureCheckpoint(session, store.history(session.id).at(-1)?.seq ?? 0, item.id, prompt, kind);
		store.append(session, item);
	};

	// Claude answers with signed reasoning, then compacts behind a signed summary.
	const q1 = entry("first question", "user");
	const a1 = signed("claude answer", claude, "claude-signature");
	record(q1, "first question", "user");
	record(a1, "Assistant response", "assistant");
	const summary: HistoryEntry = {
		id: crypto.randomUUID(),
		kind: "compaction",
		summary: "claude summary",
		native: { encrypted: "claude-compaction-payload" },
		provider: "anthropic",
		model: "claude",
	};
	store.append(session, summary);
	first.compactionId = summary.id;
	first.contextStart = seqOf(summary.id);
	first.cacheBoundary = a1.id;
	first.tokens = 40;

	// Switching to GPT opens its own window under its own transport and cache identity.
	session.selection = gpt;
	const second: ModelContext = {
		selection: gpt,
		sessionId: "gpt-transport",
		cacheKey: "gpt-cache",
		contextStart: 0,
		tokens: 0,
	};
	session.contexts.push(second);
	const q2 = entry("second question", "user");
	const a2 = signed("gpt answer", gpt, "gpt-reasoning-item");
	record(q2, "second question", "user");
	record(a2, "Assistant response", "assistant");
	// GPT rolls onto a notes window whose prefix is frozen with it.
	session.notebook = "notes at the cut";
	second.contextStart = seqOf(a2.id);
	second.notebook = session.notebook;
	second.cacheBoundary = q2.id;
	second.tokens = 12;

	// The chosen event, and everything both models do after it.
	const q3 = entry("third question", "user");
	record(q3, "third question", "user");
	record(signed("future gpt answer", gpt, "future-gpt"), "Assistant response", "assistant");
	session.notebook = "future notes";
	second.notebook = "future notes";
	second.contextStart = store.history(session.id).at(-1)!.seq;
	session.selection = claude;
	const q4 = entry("future question", "user");
	record(q4, "future question", "user");
	record(signed("future claude answer", claude, "future-claude"), "Assistant response", "assistant");
	first.cacheBoundary = q4.id;
	store.save(session);

	const kept = store.history(session.id).filter((row) => row.seq < seqOf(q3.id));
	const source = JSON.stringify(store.history(session.id));
	const sourceSession = JSON.stringify(store.get(session.id));
	const fork = store.forkCheckpoint(session.id, q3.id);
	const forked = store.history(fork.id);

	// Exactly the events before the chosen one; payloads, signatures and origins byte for byte.
	expect(forked.map((row) => JSON.stringify({ ...row.entry, id: "" }))).toEqual(
		kept.map((row) => JSON.stringify({ ...row.entry, id: "" })),
	);
	expect(forked.map((row) => row.entry.origin?.model)).toEqual(["claude", "claude", "claude", "gpt", "gpt"]);
	expect(JSON.stringify([fork, forked])).not.toContain("future");

	// Each window points into the branch's own entries; cache keys are inherited, transports are new.
	const fresh = (id: string) => forked[kept.findIndex((row) => row.entry.id === id)]!;
	const [claudeWindow, gptWindow] = fork.contexts;
	expect(fork.selection).toEqual(gpt);
	expect(fork.notebook).toBe("notes at the cut");
	expect(claudeWindow).toEqual({
		selection: claude,
		sessionId: fork.id,
		cacheKey: session.id,
		contextStart: fresh(summary.id).seq,
		compactionId: fresh(summary.id).entry.id,
		cacheBoundary: fresh(a1.id).entry.id,
		tokens: 40,
	});
	expect(gptWindow).toEqual({
		selection: gpt,
		sessionId: gptWindow!.sessionId,
		cacheKey: "gpt-cache",
		contextStart: fresh(a2.id).seq,
		notebook: "notes at the cut",
		cacheBoundary: fresh(q2.id).entry.id,
		tokens: 12,
	});
	expect([session.id, "gpt-transport", fork.id]).not.toContain(gptWindow!.sessionId);

	// Earlier points carried into the branch share its transports and keep their event's model.
	const points = store.checkpoints(fork.id);
	expect(points.map((point) => point.selection?.model)).toEqual(["claude", "claude", "gpt", "gpt"]);
	for (const point of points)
		for (const window of point.state.contexts)
			expect(window.sessionId).toBe(window.cacheKey === "gpt-cache" ? gptWindow!.sessionId : fork.id);

	// The source is untouched and resumes exactly where it was.
	expect(JSON.stringify(store.history(session.id))).toBe(source);
	expect(JSON.stringify(store.get(session.id))).toBe(sourceSession);
});

test("a v2 database lists read-only as it is, then migrates every session and checkpoint window", () => {
	store.close();
	const path = join(home, "sessions.sqlite");
	const legacyId = crypto.randomUUID();
	const claude = { provider: "anthropic", model: "claude" };
	const question = entry("legacy question", "user");
	const answer = entry("legacy answer", "assistant");
	const summary: HistoryEntry = {
		id: crypto.randomUUID(),
		kind: "compaction",
		summary: "legacy summary",
		provider: "anthropic",
		model: "claude",
	};
	const followUp = entry("after the summary", "user");
	const reply = entry("latest reply", "assistant", 30);
	const state = (
		contextStart: number,
		notebook: string,
		compactionId?: string,
		firstUserText = "legacy question",
	) =>
		JSON.stringify({
			id: legacyId,
			title: "legacy work",
			cwd: project,
			selection: claude,
			system: ["base"],
			tools: [],
			activeTools: [],
			firstUserText,
			notebook,
			contextStart,
			...(compactionId ? { compactionId } : {}),
			instructions: [],
			updatedAt: 1,
		});

	// A v2 database already has every v3 table; only its records and version differ.
	const legacy = new Database(path);
	legacy.query("DELETE FROM sessions").run();
	legacy.query("INSERT INTO sessions(id,parent_id,updated_at,data) VALUES(?,NULL,1,'{}')").run(legacyId);
	const insert = legacy.query("INSERT INTO entries(session_id,id,data) VALUES(?,?,?)");
	const add = (item: HistoryEntry) =>
		Number(insert.run(legacyId, item.id, JSON.stringify(item)).lastInsertRowid);
	const q = add(question);
	const a = add(answer);
	const s = add(summary);
	const f = add(followUp);
	add(reply);
	const current = state(s, "current notes", summary.id);
	legacy.query("UPDATE sessions SET data=? WHERE id=?").run(current, legacyId);
	const point = legacy.query(
		"INSERT INTO checkpoints(session_id,id,kind,before_seq,created_at,prompt,state) VALUES(?,?,?,?,1,?,?)",
	);
	// A point before any user text, an old branch's whole-history window, a
	// compacted window and a notes window.
	point.run(legacyId, question.id, "user", 0, "legacy question", state(0, "", undefined, ""));
	point.run(legacyId, answer.id, "assistant", q, "Assistant response", state(q, "stale notes"));
	point.run(legacyId, followUp.id, "user", s, "after the summary", state(s, "current notes", summary.id));
	point.run(legacyId, reply.id, "assistant", f, "Assistant response", state(a, "notes then"));
	legacy.exec("PRAGMA user_version=2");
	const entries = legacy.query("SELECT seq,id,data FROM entries ORDER BY seq").all();
	legacy.close();

	const reader = new Store(home, true);
	expect(reader.list()).toEqual([
		{
			id: legacyId,
			title: "legacy work",
			updatedAt: 1,
			cwd: project,
			provider: "anthropic",
			model: "claude",
		},
	]);
	reader.close();
	const unmigrated = new Database(path, { readonly: true });
	expect(unmigrated.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
	expect(unmigrated.query<{ data: string }, []>("SELECT data FROM sessions").get()?.data).toBe(current);
	unmigrated.close();

	store = new Store(home);
	const migrated = store.get(legacyId)!;
	const identity = { selection: claude, sessionId: legacyId, cacheKey: legacyId };
	expect(migrated).not.toHaveProperty("contextStart");
	expect(migrated).not.toHaveProperty("compactionId");
	expect(migrated.updatedAt).toBe(1);
	expect(migrated.notebook).toBe("current notes");
	expect(migrated.cacheFirstUserText).toBe("legacy question");
	// A head built before any user text was seeded empty, which is not the same as unseeded.
	expect(store.checkpoint(legacyId, question.id)!.state).toHaveProperty("cacheFirstUserText", "");
	// Only the reply after the summary measured the compacted window.
	expect(migrated.contexts).toEqual([
		{ ...identity, contextStart: s, compactionId: summary.id, restoreControls: true, tokens: 31 },
	]);
	const windows = new Map(store.checkpoints(legacyId).map((each) => [each.id, each.state.contexts]));
	expect(windows.get(answer.id)).toEqual([{ ...identity, contextStart: 0, tokens: 0 }]);
	expect(windows.get(followUp.id)).toEqual([
		{ ...identity, contextStart: s, compactionId: summary.id, restoreControls: true, tokens: 0 },
	]);
	expect(windows.get(reply.id)).toEqual([
		{ ...identity, contextStart: a, notebook: "notes then", tokens: 0 },
	]);
	const history = new Database(path, { readonly: true });
	expect(history.query("SELECT seq,id,data FROM entries ORDER BY seq").all()).toEqual(entries);
	history.close();

	// Rewinding a migrated point stays on the legacy cache with a transport of its own.
	const fork = store.forkCheckpoint(legacyId, followUp.id);
	const forked = store.history(fork.id);
	expect(forked.map((row) => row.entry.kind)).toEqual(["message", "message", "compaction"]);
	expect(fork.contexts).toEqual([
		{
			...identity,
			sessionId: fork.id,
			contextStart: forked[2]!.seq,
			compactionId: forked[2]!.entry.id,
			restoreControls: true,
			tokens: 0,
		},
	]);
	expect(fork.firstUserText).toBe("legacy question");
});

function fileOperations() {
	return createFileOperationTools({
		workspace: () => workspace,
		freshness: new FreshnessTracker(),
	} as unknown as ToolEnvironment)[0]!;
}

test("recursive moves journal descendants and restore modes and empty directory layout", async () => {
	const from = join(project, "source");
	const to = join(project, "nested", "target");
	await mkdir(join(from, "empty"), { recursive: true });
	await writeFile(join(from, "run.sh"), "original\n");
	await chmod(join(from, "run.sh"), 0o751);
	await chmod(join(from, "empty"), 0o750);
	const tool = fileOperations();
	const inspected = await tool.execute({ op: "inspect", path: from }, context);
	const manifest = JSON.parse(inspected.text);
	store.captureCheckpoint(session, 0, "tree", "tree", "user");
	const moved = await checkpoints.run("tree", context, () =>
		tool.execute({ op: "move", path: from, to, expected_tree: manifest.tree_hash }, context),
	);
	expect(moved.isError).not.toBe(true);
	expect(await Bun.file(join(to, "run.sh")).text()).toBe("original\n");
	expect((await workspace.fs.stat(from)).kind).toBe("missing");
	const descendant = await checkpoints.run("tree", context, () =>
		tool.execute({ op: "move", path: join(to, "run.sh"), to: join(to, "renamed.sh") }, context),
	);
	expect(descendant.isError).not.toBe(true);
	expect(await Bun.file(join(to, "renamed.sh")).text()).toBe("original\n");
	await checkpoints.restore(session.id, "tree", context.signal);
	expect(await Bun.file(join(from, "run.sh")).text()).toBe("original\n");
	expect((await stat(join(from, "run.sh"))).mode & 0o777).toBe(0o751);
	expect((await stat(join(from, "empty"))).mode & 0o777).toBe(0o750);
	expect((await workspace.fs.stat(join(project, "nested"))).kind).toBe("missing");
});

test("recursive removal requires a reviewed manifest and preserves layout on restore", async () => {
	const path = join(project, "tree");
	await mkdir(join(path, "empty"), { recursive: true });
	await writeFile(join(path, ".hidden"), "secret\n");
	const tool = fileOperations();
	const manifest = JSON.parse((await tool.execute({ op: "inspect", path }, context)).text);
	expect(
		(await tool.execute({ op: "remove", path, expected_tree: manifest.tree_hash }, context)).isError,
	).toBe(true);
	await writeFile(join(path, "new"), "external\n");
	const stale = await tool.execute(
		{ op: "remove", path, recursive: true, expected_tree: manifest.tree_hash },
		context,
	);
	expect(stale.isError).toBe(true);
	expect(stale.details).toMatchObject({ reason: "tree_review_required" });
	expect(await Bun.file(join(path, "new")).text()).toBe("external\n");
	const current = JSON.parse((await tool.execute({ op: "inspect", path }, context)).text);
	expect(JSON.stringify(stale)).not.toContain(current.tree_hash);
	store.captureCheckpoint(session, 0, "tree", "tree", "user");
	const result = await checkpoints.run("tree", context, () =>
		tool.execute({ op: "remove", path, recursive: true, expected_tree: current.tree_hash }, context),
	);
	expect(result.isError).not.toBe(true);
	await checkpoints.restore(session.id, "tree", context.signal);
	expect(await Bun.file(join(path, ".hidden")).text()).toBe("secret\n");
	expect((await stat(join(path, "empty"))).isDirectory()).toBe(true);
});

test("restore refuses externally added descendants before undoing any tracked file", async () => {
	const existing = join(project, "existing");
	const nested = join(project, "created", "deep", "own");
	await writeFile(existing, "before");
	store.captureCheckpoint(session, 0, "tree", "tree", "user");
	await checkpoints.run("tree", context, async () => {
		await workspace.fs.write(existing, "after", undefined, sha256Hex("before"));
		await workspace.fs.write(nested, "own", undefined, null);
	});
	await writeFile(join(project, "created", "external"), "keep me");
	await expect(checkpoints.restore(session.id, "tree", context.signal)).rejects.toThrow(
		/untracked descendant/,
	);
	expect(await Bun.file(existing).text()).toBe("after");
	expect(await Bun.file(nested).text()).toBe("own");
	expect(await Bun.file(join(project, "created", "external")).text()).toBe("keep me");
});

test("failed recursive move conditionally rolls back while preserving a concurrent destination edit", async () => {
	const source = join(project, "source");
	const target = join(project, "target");
	await mkdir(source);
	await writeFile(join(source, "a"), "a");
	await writeFile(join(source, "b"), "b");
	const tool = fileOperations();
	const manifest = JSON.parse((await tool.execute({ op: "inspect", path: source }, context)).text);
	const move = workspace.fs.move.bind(workspace.fs);
	const hook = spyOn(workspace.fs, "move").mockImplementation(
		async (from, to, signal, expected, destination) => {
			if (from === join(source, "b")) {
				await writeFile(join(target, "a"), "external");
				throw new ToolFailure("injected failure", { publication: "unpublished" });
			}
			await move(from, to, signal, expected, destination);
		},
	);
	try {
		const result = await tool.execute(
			{ op: "move", path: source, to: target, expected_tree: manifest.tree_hash },
			context,
		);
		expect(result.isError).toBe(true);
		expect(await Bun.file(join(target, "a")).text()).toBe("external");
		expect(await Bun.file(join(source, "b")).text()).toBe("b");
	} finally {
		hook.mockRestore();
	}
});

test("committed after images remain available after a later external save", async () => {
	const path = join(project, "after-image");
	await writeFile(path, "before");
	store.captureCheckpoint(session, 0, "after", "after", "user");
	const write = workspace.fs.write.bind(workspace.fs);
	await checkpoints.run("after", context, async () => {
		await write(path, "own bytes", undefined, sha256Hex("before"));
		await writeFile(path, "external bytes");
	});
	expect(new TextDecoder().decode(store.blob(sha256Hex("own bytes")))).toBe("own bytes");
	expect(await Bun.file(path).text()).toBe("external bytes");
});

test("move refuses an occupied destination without changing either file", async () => {
	const source = join(project, "a.py"),
		destination = join(project, "b.ts");
	await writeFile(source, "source bytes");
	await writeFile(destination, "destination bytes");
	const result = await fileOperations().execute(
		{
			op: "move",
			path: source,
			to: destination,
			expected_hash: sha256Hex("source bytes"),
		},
		context,
	);
	expect(result.isError).toBe(true);
	expect(result.details).toMatchObject({ reason: "destination_exists", path: destination });
	expect(await Bun.file(source).text()).toBe("source bytes");
	expect(await Bun.file(destination).text()).toBe("destination bytes");
});

test("successful moves carry freshness forward but never bless a later external write", async () => {
	const source = join(project, "source.txt"),
		middle = join(project, "middle.txt");
	const final = join(project, "final.txt"),
		refused = join(project, "refused.txt");
	await writeFile(source, "owned");
	const tool = fileOperations();
	const first = await tool.execute(
		{
			op: "move",
			path: source,
			to: middle,
			expected_hash: sha256Hex("owned"),
		},
		context,
	);
	expect(first.isError).not.toBe(true);
	const move = workspace.fs.move.bind(workspace.fs);
	const hook = spyOn(workspace.fs, "move").mockImplementation(async (...args) => {
		await move(...args);
		if (args[1] === final) await writeFile(final, "external");
	});
	try {
		const second = await tool.execute({ op: "move", path: middle, to: final }, context);
		expect(second.isError).not.toBe(true);
		const stale = await tool.execute({ op: "move", path: final, to: refused }, context);
		expect(stale.isError).toBe(true);
		expect(await Bun.file(final).text()).toBe("external");
		expect(await Bun.file(refused).exists()).toBe(false);
	} finally {
		hook.mockRestore();
	}
});
