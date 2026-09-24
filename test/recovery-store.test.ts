import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	heldEntries,
	listRecovery,
	parseAge,
	pruneRecovery,
	recoveryRoots,
} from "../src/tools/recovery-store.ts";

let directory = "";
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = "";
});

async function entry(root: string, name: string, createdAt: string, body = "old contents\n") {
	const path = join(root, name);
	await mkdir(path, { recursive: true, mode: 0o700 });
	await writeFile(join(path, "displaced"), body);
	await writeFile(
		join(path, "manifest.json"),
		JSON.stringify({ path: `/work/${name}.ts`, operation: "write", createdAt }),
	);
	return path;
}

test("ages parse with units and default to days", () => {
	expect(parseAge("30m")).toBe(30 * 60_000);
	expect(parseAge("12h")).toBe(12 * 3_600_000);
	expect(parseAge("14")).toBe(14 * 86_400_000);
	expect(parseAge("2w")).toBe(14 * 86_400_000);
	expect(() => parseAge("soon")).toThrow("Invalid age");
});

test("the cache root and a repository's root are found from inside the worktree", async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "salam-recovery-")));
	const uid = process.getuid!();
	const gitRoot = join(directory, "repo", ".git", `salam-recovery-${uid}`);
	await mkdir(gitRoot, { recursive: true });
	await mkdir(join(directory, "repo", "src"), { recursive: true });
	// test/setup.ts points XDG_CACHE_HOME at a private temporary directory.
	const cacheRoot = join(process.env.XDG_CACHE_HOME!, "salam", "recovery");
	await mkdir(cacheRoot, { recursive: true });
	const roots = await recoveryRoots(join(directory, "repo", "src"));
	expect(roots.slice(0, 2)).toEqual([cacheRoot, gitRoot]);
});

test("entries list oldest first; pruning removes the selection but keeps one a process holds open", async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "salam-recovery-")));
	const root = join(directory, "root");
	const old = await entry(root, "entry-0", "2020-01-01T00:00:00.000Z");
	const held = await entry(root, "entry-1", "2020-06-01T00:00:00.000Z");
	const fresh = await entry(root, "entry-2", new Date().toISOString());
	await mkdir(join(root, "not-an-entry"));

	const entries = await listRecovery([root]);
	expect(entries.map((item) => item.directory)).toEqual([old, held, fresh]);
	expect(entries[0]!.path).toBe("/work/entry-0.ts");
	expect(entries[0]!.bytes).toBeGreaterThan(0);

	const handle = await open(join(held, "displaced"), "r");
	try {
		const holders = await heldEntries([root]);
		expect(holders).toBeDefined();
		expect([...holders!]).toEqual([held]);

		const cutoff = Date.now() - parseAge("30d");
		const selected = entries.filter((item) => (item.createdAt ?? 0) < cutoff);
		const result = await pruneRecovery(selected, holders);
		expect(result.removed.map((item) => item.directory)).toEqual([old]);
		expect(result.held.map((item) => item.directory)).toEqual([held]);
		expect((await readdir(root)).sort()).toEqual(["entry-1", "entry-2", "not-an-entry"]);
	} finally {
		await handle.close();
	}
});

test("without open-file information nothing is removed unless forced", async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "salam-recovery-")));
	const root = join(directory, "root");
	await entry(root, "entry-0", "2020-01-01T00:00:00.000Z");
	const entries = await listRecovery([root]);
	await expect(pruneRecovery(entries, undefined)).rejects.toThrow("nothing was removed");
	expect(await readdir(root)).toEqual(["entry-0"]);
	expect((await pruneRecovery(entries, undefined, true)).removed).toHaveLength(1);
	expect(await readdir(root)).toEqual([]);
});
