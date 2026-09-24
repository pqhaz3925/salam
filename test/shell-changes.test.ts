import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { ToolContext } from "../src/contracts.ts";
import { createFileTools, createViewImageTool } from "../src/tools/files.ts";
import { createProcessTools, createShellTool } from "../src/tools/shell.ts";
import { ToolEnvironment } from "../src/tools/workspace.ts";

const fixtures: { directory: string; environment: ToolEnvironment }[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.environment.close();
		await rm(fixture.directory, { recursive: true, force: true });
	}
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "salam-shell-changes-"));
	const environment = new ToolEnvironment(
		await loadConfig({ cwd: directory, home: join(directory, "state") }),
	);
	fixtures.push({ directory, environment });
	const context: ToolContext = {
		cwd: directory,
		sessionId: "shell-changes",
		agentId: "main",
		signal: new AbortController().signal,
		emit: () => {},
	};
	const tools = createFileTools(environment);
	const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
	return { directory, context, read: tool("read"), edit: tool("edit"), shell: createShellTool(environment) };
}

test("a shell rewrite of a file the agent read is reported as a diff, and edit trusts it", async () => {
	const { directory, context, read, edit, shell } = await fixture();
	const path = join(directory, "a.py");
	await writeFile(path, "def f():\n    return 1\n");
	await read.execute({ path }, context);
	const result = await shell.execute(
		{
			command: `python3 -c "import pathlib; p = pathlib.Path('a.py'); p.write_text(p.read_text().replace('1', '2'))"`,
		},
		context,
	);
	expect(result.isError).not.toBe(true);
	expect(result.text).toContain("changed on disk while this command ran: a.py");
	expect(result.diff).toContain("-    return 1");
	expect(result.diff).toContain("+    return 2");
	expect(result.text).toContain("+    return 2");
	// The diff was shown in full, so the shell's write counts as observed.
	const edited = await edit.execute({ path, old_string: "return 2", new_string: "return 3" }, context);
	expect(edited.isError).not.toBe(true);
	expect(await readFile(path, "utf8")).toContain("return 3");
});

test("no-op rewrites, unseen files and deletions are reported accurately", async () => {
	const { directory, context, read, shell } = await fixture();
	await writeFile(join(directory, "seen.txt"), "one\n");
	await writeFile(join(directory, "unseen.txt"), "one\n");
	await read.execute({ path: join(directory, "seen.txt") }, context);
	// sed -i rewrites the file (new mtime) with identical content.
	const noop = await shell.execute(
		{ command: "sed -i.bak 's/zzz/yyy/' seen.txt && echo two > unseen.txt" },
		context,
	);
	expect(noop.text).not.toContain("changed on disk");
	expect(noop.diff).toBeUndefined();
	const removed = await shell.execute({ command: "rm seen.txt" }, context);
	expect(removed.text).toContain("seen.txt (deleted)");
	expect(removed.diff).toContain("-one");
});

test("the lean shell runs background jobs readable through command_output, and view_image refuses text", async () => {
	const { directory, context, read } = await fixture();
	const environment = fixtures.at(-1)!.environment;
	const shell = createShellTool(environment, { bare: true, background: true });
	const output = createProcessTools(environment).find((tool) => tool.name === "command_output")!;
	const stop = createProcessTools(environment).find((tool) => tool.name === "command_stop")!;
	expect(JSON.stringify(shell.parameters)).toContain('"background"');
	expect(shell.description).not.toMatch(/command_wait|command_watch|`(read|grep|glob|edit)`/);
	const started = await shell.execute({ command: "echo serving; sleep 30", background: true }, context);
	const id = (started.details as { id: string }).id;
	expect(started.text).toContain(`command_output ${id}`);
	expect(started.text).not.toContain("command_wait");
	let text = "";
	for (let attempt = 0; attempt < 100 && !text.includes("serving"); attempt++) {
		text = (await output.execute({ id }, context)).text;
		await Bun.sleep(20);
	}
	expect(text).toContain("serving");
	await stop.execute({ id }, context);
	await writeFile(join(directory, "note.txt"), "hi\n");
	const view = createViewImageTool(read);
	expect((await view.execute({ path: "note.txt" }, context)).isError).toBe(true);
});

test("in the lean shell a command outliving its timeout moves to the background with its output", async () => {
	const { context } = await fixture();
	const environment = fixtures.at(-1)!.environment;
	const shell = createShellTool(environment, { bare: true, background: true });
	const output = createProcessTools(environment).find((tool) => tool.name === "command_output")!;
	const stop = createProcessTools(environment).find((tool) => tool.name === "command_stop")!;
	const result = await shell.execute({ command: "echo round-1; sleep 3; echo round-2", timeout: 1 }, context);
	const id = (result.details as { id: string }).id;
	expect(result.text).toContain("round-1");
	expect(result.text).toContain("after its 1s timeout, instead of being stopped");
	let text = "";
	for (let attempt = 0; attempt < 100 && !text.includes("round-2"); attempt++) {
		text = (await output.execute({ id }, context)).text;
		await Bun.sleep(50);
	}
	expect(text).toContain("round-2");
	await stop.execute({ id }, context);
});

test("the lean shell refuses to change a file that changed underneath it until it is read again", async () => {
	const { directory, context } = await fixture();
	const environment = fixtures.at(-1)!.environment;
	const shell = createShellTool(environment, { bare: true, background: true });
	const path = join(directory, "store.ts");
	await writeFile(path, "export const a = 1;\n");
	await shell.execute({ command: "cat store.ts" }, context);
	await Bun.sleep(20);
	await writeFile(path, "export const a = 1;\nexport const b = 2;\n");
	const rewrite = `python3 -c "import pathlib; p = pathlib.Path('store.ts'); p.write_text(p.read_text().replace('1', '9'))"`;
	const refused = await shell.execute({ command: rewrite }, context);
	expect(refused.isError).toBe(true);
	expect(refused.text).toContain("store.ts changed on disk since your last command");
	expect(await Bun.file(path).text()).toContain("export const a = 1;");
	// Reading is always allowed, and it is what clears the refusal.
	expect((await shell.execute({ command: "sed -n 1,5p store.ts" }, context)).text).toContain("const b = 2");
	const retried = await shell.execute({ command: rewrite }, context);
	expect(retried.isError).not.toBe(true);
	expect(await Bun.file(path).text()).toContain("export const a = 9;");
});

test("a shell write that breaks a file's syntax says so, but pre-existing parse errors are not blamed on it", async () => {
	const { directory, context } = await fixture();
	const environment = fixtures.at(-1)!.environment;
	const shell = createShellTool(environment, { bare: true, background: true });
	await writeFile(join(directory, "a.ts"), "const a = `x`;\n");
	await shell.execute({ command: "cat a.ts" }, context);
	const broken = await shell.execute(
		{
			command: `python3 -c "import pathlib; p = pathlib.Path('a.ts'); p.write_text('const a = \\\`x;\\nconst b = 1;\\n')"`,
		},
		context,
	);
	expect(broken.text).toContain("[syntax errors this command introduced");
	expect(broken.text).toMatch(/a\.ts: 1:\d+/);
	const created = await shell.execute({ command: "printf 'def f(:\\n    return 1\\n' > b.py" }, context);
	expect(created.text).toContain("b.py: 1:");
	// Still broken the same way: not reported again.
	const unrelated = await shell.execute({ command: "printf 'x\\n' >> b.py" }, context);
	expect(unrelated.text).not.toContain("syntax errors");
});
