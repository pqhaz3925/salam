import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { ToolContext } from "../src/contracts.ts";
import { FileCheckpoints } from "../src/runtime/checkpoints.ts";
import { type SessionRecord, Store } from "../src/runtime/store.ts";
import { createShellTool } from "../src/tools/shell.ts";
import { ToolEnvironment } from "../src/tools/workspace.ts";

/** Shell writes are filed after the fact, so a rewind has to treat them exactly like an edit. */
let home = "";
let project = "";
let store: Store;
let environment: ToolEnvironment;
let checkpoints: FileCheckpoints;
let session: SessionRecord;
let context: ToolContext;

beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "salam-home-")));
	project = await realpath(await mkdtemp(join(tmpdir(), "salam-project-")));
	store = new Store(home);
	environment = new ToolEnvironment(await loadConfig({ cwd: project, home: join(home, "state") }));
	checkpoints = new FileCheckpoints(store, (ctx) => environment.workspace(ctx));
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
		sessionId: id,
		agentId: "main",
		signal: AbortSignal.any([]),
		emit: () => undefined,
	};
});

afterEach(async () => {
	await environment.close();
	store.close();
	await rm(home, { recursive: true, force: true });
	await rm(project, { recursive: true, force: true });
});

test("a bare-shell rewrite of a named file and a file it creates are both rewound", async () => {
	const shell = createShellTool(environment, { bare: true });
	await writeFile(join(project, "a.py"), "x = 1\n");
	await shell.execute({ command: "cat a.py" }, context);
	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	const result = await checkpoints.run("point-1", context, () =>
		shell.execute(
			{
				command: `python3 -c "import pathlib; p = pathlib.Path('a.py'); p.write_text('x = 2\\n')" && printf 'new\\n' > made.txt`,
			},
			context,
		),
	);
	expect(result.text).toContain("a.py");
	expect(result.text).toContain("made.txt (created, 1 line)");
	// A file the command itself created is one line for the model, not a diff of its content.
	expect(result.text).not.toContain("+new");
	expect(await Bun.file(join(project, "a.py")).text()).toBe("x = 2\n");

	const restored = await checkpoints.restore(session.id, "point-1", AbortSignal.any([]));
	expect(restored.files).toBe(2);
	expect(await Bun.file(join(project, "a.py")).text()).toBe("x = 1\n");
	expect(await Bun.file(join(project, "made.txt")).exists()).toBe(false);
});

test("a shell change is not rewound over a later external edit", async () => {
	const shell = createShellTool(environment, { bare: true });
	await writeFile(join(project, "a.txt"), "one\n");
	store.captureCheckpoint(session, 0, "point-1", "first", "user");
	await checkpoints.run("point-1", context, () =>
		shell.execute({ command: "printf 'two\\n' > a.txt" }, context),
	);
	await writeFile(join(project, "a.txt"), "three\n");
	await expect(checkpoints.restore(session.id, "point-1", AbortSignal.any([]))).rejects.toThrow();
	expect(await Bun.file(join(project, "a.txt")).text()).toBe("three\n");
});

test("the full shell does not treat merely named files as seen", async () => {
	const shell = createShellTool(environment);
	await writeFile(join(project, "b.txt"), "one\n");
	const result = await shell.execute({ command: "printf 'two\\n' > b.txt" }, context);
	expect(result.text).not.toContain("changed on disk");
});
