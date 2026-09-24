import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Json, ToolContext, ToolOutput } from "../src/contracts.ts";
import { createFileTools } from "../src/tools/files.ts";
import { type FsMutation, observeMutations } from "../src/tools/fs.ts";
import { ToolEnvironment } from "../src/tools/workspace.ts";

const fixtures: { directory: string; environment: ToolEnvironment }[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.environment.close();
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "salam-batch-edit-"));
	const environment = new ToolEnvironment(
		await loadConfig({ cwd: directory, home: join(directory, "state") }),
	);
	fixtures.push({ directory, environment });
	const context: ToolContext = {
		cwd: directory,
		sessionId: "batch",
		agentId: "main",
		signal: new AbortController().signal,
		emit: () => {},
	};
	const tools = createFileTools(environment);
	const mutations: FsMutation[] = [];
	const observer = {
		observe<T>(_fs: unknown, mutation: FsMutation, apply: () => Promise<T>) {
			mutations.push(mutation);
			return apply();
		},
	};
	const run = (name: string, args: Record<string, Json>) =>
		observeMutations(observer, () =>
			tools.find((candidate) => candidate.name === name)!.execute(args, context),
		);
	return { directory, environment, context, workspace: environment.workspace(context), run, mutations };
}

function details(output: ToolOutput): Record<string, Json> {
	if (!output.details || typeof output.details !== "object" || Array.isArray(output.details))
		throw new Error(`Missing result details: ${output.text}`);
	return output.details;
}

test("a failing second file rejects the batch before the first file is written", async () => {
	const { directory, run, mutations } = await fixture();
	const a = join(directory, "a.ts"),
		b = join(directory, "b.ts"),
		c = join(directory, "c.ts");
	await writeFile(a, "alpha\n");
	await writeFile(b, "beta beta\n");
	await writeFile(c, "gamma\n");
	for (const path of [a, b]) await run("read", { path });
	const result = await run("batch_edit", {
		files: [
			{ path: "a.ts", edits: [{ old_text: "alpha", new_text: "ALPHA" }] },
			{ path: "b.ts", edits: [{ old_text: "beta", new_text: "BETA" }] },
			{ path: "c.ts", edits: [{ old_text: "gamma", new_text: "GAMMA" }] },
			{ path: "a.ts", edits: [{ old_text: "x", new_text: "y" }] },
		],
	});
	expect(result.isError).toBe(true);
	const failures = details(result).failures as Record<string, Json>[];
	// Every problem is reported at once: ambiguous b, unread c, duplicate a.
	expect(failures.map((failure) => failure.file)).toEqual([1, 2, 3]);
	expect(mutations).toEqual([]);
	expect(await readFile(a, "utf8")).toBe("alpha\n");
	expect(await readFile(b, "utf8")).toBe("beta beta\n");
});

test("a multi-file batch applies ordered edits, preserves BOM/CRLF and every write is observed", async () => {
	const { directory, run, mutations } = await fixture();
	const a = join(directory, "a.ts"),
		b = join(directory, "b.txt");
	await writeFile(a, "\uFEFFconst one = 1;\r\nconst two = 2;\r\n");
	await writeFile(b, "x $ x\n");
	for (const path of [a, b]) await run("read", { path });
	const result = await run("batch_edit", {
		files: [
			{
				path: a,
				edits: [
					{ old_text: "const one = 1;\nconst two", new_text: "const one = 10;\nconst second" },
					{ old_text: "second = 2", new_text: "second = 20" },
				],
			},
			{ path: "b.txt", edits: [{ old_text: "x", new_text: "$&y", all: true }] },
		],
	});
	expect(result.isError).not.toBe(true);
	expect(await readFile(a, "utf8")).toBe("\uFEFFconst one = 10;\r\nconst second = 20;\r\n");
	expect(await readFile(b, "utf8")).toBe("$&y $ $&y\n");
	expect(details(result).changedPaths).toEqual([a, b]);
	expect(result.diff).toContain("+const second = 20;");
	expect(result.diff).toContain("+$&y $ $&y");
	expect(mutations.map((mutation) => [mutation.kind, mutation.path])).toEqual([
		["write", a],
		["write", b],
	]);
	// Freshness follows the committed bytes, so a follow-up edit needs no re-read.
	const again = await run("batch_edit", {
		files: [{ path: b, edits: [{ old_text: " $ ", new_text: " - " }] }],
	});
	expect(again.isError).not.toBe(true);
	expect(await readFile(b, "utf8")).toBe("$&y - $&y\n");
});

test("an external change during commit rolls back earlier files and keeps the external bytes", async () => {
	const { directory, workspace, run } = await fixture();
	const a = join(directory, "a.ts"),
		b = join(directory, "b.ts");
	await writeFile(a, "original a\n");
	await writeFile(b, "original b\n");
	for (const path of [a, b]) await run("read", { path });
	const originalWrite = workspace.fs.write.bind(workspace.fs);
	workspace.fs.write = async (path, data, signal, expectedHash) => {
		const hash = await originalWrite(path, data, signal, expectedHash);
		if (path === a) await writeFile(b, "external b\n");
		return hash;
	};
	try {
		const result = await run("batch_edit", {
			files: [
				{ path: a, edits: [{ old_text: "original", new_text: "tool" }] },
				{ path: b, edits: [{ old_text: "original", new_text: "tool" }] },
			],
		});
		expect(result.isError).toBe(true);
		const failure = details(result);
		expect(failure.rollbackComplete).toBe(true);
		expect(failure.paths).toEqual([a, b]);
		const recovery = await run("read", { path: failure.recovery as string });
		expect(recovery.text).toContain("original a");
	} finally {
		workspace.fs.write = originalWrite;
	}
	expect(await readFile(a, "utf8")).toBe("original a\n");
	expect(await readFile(b, "utf8")).toBe("external b\n");
});
