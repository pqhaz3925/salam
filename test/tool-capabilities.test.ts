import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Json, ToolContext, ToolOutput } from "../src/contracts.ts";
import { createFileTools } from "../src/tools/files.ts";
import { createSearchTools } from "../src/tools/search.ts";
import { pathToUri } from "../src/tools/lsp/manager.ts";
import { commitEditPlan, planWorkspaceEdit } from "../src/tools/lsp/transaction.ts";
import { unifiedDiff } from "../src/tools/text.ts";
import { ToolEnvironment } from "../src/tools/workspace.ts";
import { ToolFailure } from "../src/tools/util.ts";

function details(output: ToolOutput): Record<string, Json> {
	if (!output.details || typeof output.details !== "object" || Array.isArray(output.details))
		throw new Error(`Missing result details: ${output.text}`);
	return output.details;
}
const fixtures: { directory: string; environment: ToolEnvironment }[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.environment.close();
		await rm(fixture.directory, { recursive: true, force: true });
	}
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "salam-capabilities-"));
	const environment = new ToolEnvironment(
		await loadConfig({ cwd: directory, home: join(directory, "state") }),
	);
	fixtures.push({ directory, environment });
	const context: ToolContext = {
		cwd: directory,
		sessionId: "capabilities",
		agentId: "main",
		signal: new AbortController().signal,
		emit: () => {},
	};
	return { directory, environment, context, workspace: environment.workspace(context) };
}

test("unified diff treats absolute source and destination paths as prefixed patch paths", () => {
	const headers = unifiedDiff("before\n", "after\n", "/tmp/hw/b.ts", "/tmp/hw/c.ts").split("\n", 2);
	expect(headers).toEqual(["--- a/tmp/hw/b.ts", "+++ b/tmp/hw/c.ts"]);
});

test("read reaches lines beyond the former 2 MiB prefix and returns a usable continuation", async () => {
	const { directory, environment, context } = await fixture();
	const path = join(directory, "large.txt");
	await writeFile(path, "prefix content\n".repeat(180000) + "BEYOND_PREFIX\nSECOND_PAGE\n");
	const reader = createFileTools(environment).find((tool) => tool.name === "read")!;
	const first = await reader.execute({ path, offset: 180001, limit: 1 }, context);
	expect(first.isError).not.toBe(true);
	expect(first.text).toContain("180001\tBEYOND_PREFIX");
	expect(details(first).nextOffset).toBe(180002);
	const second = await reader.execute({ path, offset: details(first).nextOffset, limit: 1 }, context);
	expect(second.text).toContain("180002\tSECOND_PAGE");
});

test("AST no-match is success, malformed patterns fail, and staged rewrites cannot overwrite changed files", async () => {
	const { directory, environment, context } = await fixture();
	const path = join(directory, "code.ts");
	await writeFile(path, "const a = oldCall(1);\nconst b = oldCall(2);\n");
	const tools = createSearchTools(environment);
	const call = (name: string, args: Record<string, unknown>) =>
		tools.find((tool) => tool.name === name)!.execute(args, context);
	const absent = await call("ast_grep", { path, lang: "ts", pattern: "missingCall($ARG)" });
	expect(absent.isError).not.toBe(true);
	expect(details(absent).matched).toBe(0);
	const malformed = await call("ast_grep", { path, lang: "ts", pattern: "const = ;" });
	expect(malformed.isError).toBe(true);
	const staged = await call("ast_edit", {
		path,
		lang: "ts",
		pattern: "oldCall($ARG)",
		replacement: "newCall($ARG)",
	});
	expect(staged.isError).not.toBe(true);
	expect(staged.diff).toContain("newCall(1)");
	expect(await Bun.file(path).text()).toContain("oldCall(1)");
	await writeFile(path, "external editor\n");
	const stale = await call("ast_apply", { proposal: details(staged).proposal });
	expect(stale.isError).toBe(true);
	expect(await Bun.file(path).text()).toBe("external editor\n");
	await call("ast_reject", { proposal: details(staged).proposal });
	const rejected = await call("ast_apply", { proposal: details(staged).proposal });
	expect(rejected.isError).toBe(true);
	await writeFile(path, "oldCall(3);\n");
	const fresh = await call("ast_edit", {
		path,
		lang: "ts",
		pattern: "oldCall($ARG)",
		replacement: "newCall($ARG)",
	});
	const applied = await call("ast_apply", { proposal: details(fresh).proposal });
	expect(applied.isError).not.toBe(true);
	expect(await Bun.file(path).text()).toBe("newCall(3);\n");
});

test("workspace edits preserve create-edit-rename-edit order and preflight later failures", async () => {
	const { directory, environment, context, workspace } = await fixture();
	const from = join(directory, "from.ts"),
		to = join(directory, "to.ts");
	const edit = {
		documentChanges: [
			{ kind: "create" as const, uri: pathToUri(from) },
			{
				textDocument: { uri: pathToUri(from), version: null },
				edits: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "alpha\n" },
				],
			},
			{ kind: "rename" as const, oldUri: pathToUri(from), newUri: pathToUri(to) },
			{
				textDocument: { uri: pathToUri(to), version: null },
				edits: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "beta" },
				],
			},
		],
	};
	const plan = await planWorkspaceEdit(workspace, edit, context.signal);
	await commitEditPlan(environment, workspace, context, plan);
	expect(await Bun.file(from).exists()).toBe(false);
	expect(await Bun.file(to).text()).toBe("beta\n");
	await expect(
		planWorkspaceEdit(
			workspace,
			{
				documentChanges: [
					...edit.documentChanges,
					{ kind: "delete", uri: pathToUri(join(directory, "missing")) },
				],
			},
			context.signal,
		),
	).rejects.toThrow();
	expect(await Bun.file(from).exists()).toBe(false);
	expect(await Bun.file(to).text()).toBe("beta\n");
});

test("failed multi-file edits conditionally roll back and preserve external writes with recovery artifacts", async () => {
	const { directory, environment, context, workspace } = await fixture();
	const a = join(directory, "a.ts"),
		b = join(directory, "b.ts");
	await writeFile(a, "original a\n");
	await writeFile(b, "original b\n");
	const edit = {
		changes: Object.fromEntries(
			[a, b].map((path) => [
				pathToUri(path),
				[{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "tool " }],
			]),
		),
	};
	const plan = await planWorkspaceEdit(workspace, edit, context.signal);
	const originalWrite = workspace.fs.write.bind(workspace.fs);
	workspace.fs.write = async (path, data, signal, expectedHash) => {
		if (path === b) {
			await writeFile(a, "external a\n");
			throw new Error("injected later failure");
		}
		return originalWrite(path, data, signal, expectedHash);
	};
	try {
		await commitEditPlan(environment, workspace, context, plan);
		throw new Error("Expected transaction failure");
	} catch (error) {
		if (!(error instanceof ToolFailure)) throw error;
		const failure = details({ text: error.message, details: error.details });
		expect(failure.rollbackComplete).toBe(false);
		const reader = createFileTools(environment).find((tool) => tool.name === "read")!;
		const recovery = await reader.execute({ path: failure.recovery }, context);
		expect(recovery.isError).not.toBe(true);
		expect(recovery.text).toContain("original a");
	}
	expect(await Bun.file(a).text()).toBe("external a\n");
	expect(await Bun.file(b).text()).toBe("original b\n");
});

test("structured readers inspect compressed text, archive members, DOCX and read-only SQLite without extraction", async () => {
	const { directory, environment, context, workspace } = await fixture();
	const python = await workspace.requireBinary("python3", "reader fixtures");
	const created = await workspace.executor.exec(
		[
			python,
			"-c",
			`
import sys,zipfile,gzip,sqlite3,os
p=sys.argv[1]
with gzip.open(os.path.join(p,'message.txt.gz'),'wb') as f: f.write(b'compressed message\\n')
with zipfile.ZipFile(os.path.join(p,'archive.zip'),'w') as z: z.writestr('../member.txt','member content\\n')
with zipfile.ZipFile(os.path.join(p,'document.docx'),'w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Document words</w:t></w:r></w:p></w:body></w:document>')
db=sqlite3.connect(os.path.join(p,'data.sqlite'))
db.execute('CREATE TABLE items (name TEXT)')
db.execute("INSERT INTO items VALUES ('kept')")
db.commit()
db.close()
`,
			directory,
		],
		{ signal: context.signal },
	);
	expect(created.code).toBe(0);
	const reader = createFileTools(environment).find((tool) => tool.name === "read")!;
	const compressed = await reader.execute({ path: "message.txt.gz" }, context);
	expect(compressed.isError).not.toBe(true);
	expect(compressed.text).toContain("compressed message");
	const listing = await reader.execute({ path: "archive.zip" }, context);
	expect(listing.text).toContain("../member.txt");
	const member = await reader.execute({ path: "archive.zip", member: "../member.txt" }, context);
	expect(member.text).toContain("member content");
	const doc = await reader.execute({ path: "document.docx" }, context);
	expect(doc.text).toContain("Document words");
	const destructive = await reader.execute(
		{ path: "data.sqlite", query: "DELETE FROM items RETURNING name" },
		context,
	);
	expect(destructive.isError).toBe(true);
	const rows = await reader.execute({ path: "data.sqlite", table: "items" }, context);
	expect(rows.isError).not.toBe(true);
	expect(rows.text).toContain('["name"]');
	expect(rows.text).toContain('["kept"]');
});

test("SQLite preserves duplicate columns and refuses oversized values before serialization", async () => {
	const { directory, environment, context, workspace } = await fixture();
	const python = await workspace.requireBinary("python3", "SQLite fixtures");
	const created = await workspace.executor.exec(
		[
			python,
			"-c",
			`
import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE blobs (payload BLOB)')
db.execute('INSERT INTO blobs VALUES (zeroblob(2000000))')
db.commit()
db.close()
`,
			join(directory, "cells.sqlite"),
		],
		{ signal: context.signal },
	);
	expect(created.code).toBe(0);
	const reader = createFileTools(environment).find((tool) => tool.name === "read")!;
	const duplicate = await reader.execute(
		{ path: "cells.sqlite", query: "SELECT 1 AS id, 2 AS id, x'00ff' AS id" },
		context,
	);
	expect(duplicate.isError ? duplicate.text : "ok").toBe("ok");
	expect(duplicate.text).toContain('["id", "id", "id"]');
	expect(duplicate.text).toContain('[1, 2, {"hex": "00ff"}]');
	const huge = await reader.execute({ path: "cells.sqlite", query: "SELECT randomblob(300000000)" }, context);
	expect(huge.isError).toBe(true);
	expect(huge.text).toMatch(/substr.*length/);
	const stored = await reader.execute({ path: "cells.sqlite", table: "blobs" }, context);
	expect(stored.isError).toBe(true);
	const bounded = await reader.execute(
		{ path: "cells.sqlite", query: "SELECT length(payload) FROM blobs" },
		context,
	);
	expect(bounded.isError ? bounded.text : "ok").toBe("ok");
	expect(bounded.text).toContain("[2000000]");
	const schema = await reader.execute({ path: "cells.sqlite" }, context);
	expect(schema.isError ? schema.text : "ok").toBe("ok");
	expect(schema.text).toContain("CREATE TABLE blobs");
	const exec = workspace.executor.exec.bind(workspace.executor);
	workspace.executor.exec = (argv, options) =>
		exec(
			argv[0] === python && argv[1] === "-c"
				? [
						...argv.slice(0, 2),
						`import sqlite3
_connect=sqlite3.connect
class LegacyConnection(sqlite3.Connection):
 setlimit=None
 getlimit=None
sqlite3.connect=lambda *args,**kwargs: _connect(*args,factory=LegacyConnection,**kwargs)
` + argv[2],
						...argv.slice(3),
					]
				: argv,
			options,
		);
	try {
		const unavailable = await reader.execute({ path: "cells.sqlite", query: "SELECT 1" }, context);
		expect(unavailable.isError).toBe(true);
		expect(unavailable.text).toMatch(/requires Python 3\.11.*setlimit/);
	} finally {
		workspace.executor.exec = exec;
	}
});

test("versioned workspace edits identify differently escaped URIs as the same path", async () => {
	const { directory, environment, context, workspace } = await fixture();
	const path = join(directory, "(route) !'*%#é.ts");
	await writeFile(path, "before\n");
	const uri = pathToUri(path).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	const edit = {
		documentChanges: [
			{
				textDocument: { uri, version: 3 },
				edits: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "after" },
				],
			},
		],
	};
	const plan = await planWorkspaceEdit(workspace, edit, context.signal, new Map([[path, 3]]));
	await commitEditPlan(environment, workspace, context, plan);
	expect(await Bun.file(path).text()).toBe("after\n");
	await expect(planWorkspaceEdit(workspace, edit, context.signal, new Map([[path, 4]]))).rejects.toThrow(
		/unverified document version/,
	);
	expect(await Bun.file(path).text()).toBe("after\n");
});

test("an unknown failed step stays incomplete after earlier files roll back and can publish later", async () => {
	const { directory, environment, context, workspace } = await fixture();
	const a = join(directory, "first.ts"),
		b = join(directory, "second.ts");
	await writeFile(a, "first\n");
	await writeFile(b, "second\n");
	const plan = await planWorkspaceEdit(
		workspace,
		{
			changes: {
				[pathToUri(a)]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "changed" },
				],
				[pathToUri(b)]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "changed" },
				],
			},
		},
		context.signal,
	);
	const originalWrite = workspace.fs.write.bind(workspace.fs);
	const release = Promise.withResolvers<void>();
	let lateWrite: Promise<string> | undefined;
	const retained = join(directory, "pending-recovery");
	await writeFile(retained, "second\n");
	workspace.fs.write = async (path, data, signal, expectedHash) => {
		if (path === b) {
			lateWrite = release.promise.then(() => originalWrite(path, data, signal, expectedHash));
			throw new ToolFailure("SSH reply lost before publication could be confirmed", {
				publication: "unknown",
				recoveryPaths: [retained],
			});
		}
		return originalWrite(path, data, signal, expectedHash);
	};
	try {
		try {
			await commitEditPlan(environment, workspace, context, plan);
			throw new Error("Expected transaction failure");
		} catch (error) {
			if (!(error instanceof ToolFailure)) throw error;
			const failure = details({ text: error.message, details: error.details });
			expect(failure.rollbackComplete).toBe(false);
			expect(failure.publication).toBe("unknown");
			expect(failure.uncertainPaths).toEqual([b]);
			expect(failure.recoveryPaths).toContain(retained);
		}
		expect(await Bun.file(a).text()).toBe("first\n");
		expect(await Bun.file(b).text()).toBe("second\n");
	} finally {
		release.resolve();
		await lateWrite;
	}
	expect(await Bun.file(b).text()).toBe("changed\n");
});

test("grep falls back to PCRE2 and pages results past the previous match cap", async () => {
	const { directory, environment, context } = await fixture();
	await writeFile(
		join(directory, "matches.txt"),
		Array.from({ length: 2205 }, (_, index) => `prefix_${index}`).join("\n"),
	);
	const grep = createSearchTools(environment).find((tool) => tool.name === "grep")!;
	const page = await grep.execute(
		{ path: "matches.txt", pattern: "(?<=prefix_)\\d+", skip: 2100, limit: 2 },
		context,
	);
	expect(page.isError).not.toBe(true);
	expect(page.text).toContain("prefix_2100");
	expect(page.text).toContain("prefix_2101");
	expect(details(page).nextSkip).toBe(2102);
	const reader = createFileTools(environment).find((tool) => tool.name === "read")!;
	const recovered = await reader.execute({ path: details(page).artifact, offset: 2205, limit: 1 }, context);
	expect(recovered.isError).not.toBe(true);
	expect(recovered.text).toContain("prefix_2204");
});
