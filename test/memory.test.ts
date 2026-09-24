import { afterEach, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Json, RemoteTarget, ToolContext, ToolOutput } from "../src/contracts.ts";
import { AutoMemory } from "../src/integrations/memory.ts";
import type { Executor } from "../src/tools/exec.ts";
import { observeMutations, type WorkspaceFs } from "../src/tools/fs.ts";
import { ToolEnvironment, Workspace } from "../src/tools/workspace.ts";

const fixtures: { root: string; environment: ToolEnvironment }[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.environment.close();
		await rm(fixture.root, { recursive: true, force: true });
	}
});

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "salam-memory-")));
	const cwd = join(root, "project"),
		home = join(root, "state");
	await mkdir(cwd);
	const config = await loadConfig({ cwd, home });
	const environment = new ToolEnvironment(config);
	fixtures.push({ root, environment });
	const context: ToolContext = {
		cwd,
		sessionId: "first",
		agentId: "main",
		signal: new AbortController().signal,
		emit: () => {},
	};
	const workspaceFor = (ctx: ToolContext) => environment.workspace(ctx);
	const memory = new AutoMemory(config, workspaceFor);
	return { root, cwd, home, config, context, environment, workspaceFor, memory };
}

function details(output: ToolOutput): Record<string, Json> {
	if (!output.details || typeof output.details !== "object" || Array.isArray(output.details))
		throw new Error(`Missing result details: ${output.text}`);
	return output.details;
}

async function git(environment: ToolEnvironment, context: ToolContext, args: string[]): Promise<void> {
	const result = await environment
		.workspace(context)
		.executor.exec(["git", ...args], { cwd: context.cwd, signal: context.signal });
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git failed: ${args.join(" ")}`);
}

test("durable files are recalled by new sessions, while topic bodies load only on demand", async () => {
	const { config, memory, workspaceFor, context } = await fixture();
	const index = "- [Testing preference](feedback_testing.md): agree on test scope first.\n";
	expect(
		(
			await memory.tool.execute(
				{
					op: "write",
					path: "feedback_testing.md",
					content: "---\ntype: feedback\n---\nAsk which suites are appropriate before spending CI minutes.\n",
				},
				context,
			)
		).isError,
	).not.toBe(true);
	expect((await memory.tool.execute({ op: "write", content: index }, context)).isError).not.toBe(true);
	const next = new AutoMemory(config, workspaceFor);
	const nextContext = { ...context, sessionId: "second" };
	const recalled = await next.context(nextContext);
	expect(recalled.content).toBe(index);
	expect(recalled.content).not.toContain("spending CI minutes");
	const listing = await next.tool.execute({ op: "list" }, nextContext);
	expect((details(listing).files as Record<string, Json>[]).map((entry) => entry.path)).toEqual([
		"MEMORY.md",
		"feedback_testing.md",
	]);
	expect(listing.text).not.toContain("spending CI minutes");
	expect((await next.tool.execute({ op: "read", path: "feedback_testing.md" }, nextContext)).text).toContain(
		"spending CI minutes",
	);
	// A human can edit or delete these plain files without any database synchronization.
	await writeFile(join(recalled.directory, "MEMORY.md"), "User-maintained replacement\n");
	expect(
		(await new AutoMemory(config, workspaceFor).context({ ...context, sessionId: "third" })).content,
	).toBe("User-maintained replacement\n");
	await unlink(join(recalled.directory, "MEMORY.md"));
	expect(
		(await new AutoMemory(config, workspaceFor).context({ ...context, sessionId: "fourth" })).content,
	).toBe("");
});

test("git worktrees and subdirectories share memory, while distinct repositories do not", async () => {
	const { root, cwd, memory, context, environment } = await fixture();
	await git(environment, context, ["init", "-q"]);
	await git(environment, context, [
		"-c",
		"user.name=Memory Test",
		"-c",
		"user.email=memory@example.invalid",
		"commit",
		"--allow-empty",
		"-qm",
		"initial",
	]);
	const worktree = join(root, "worktree"),
		nested = join(cwd, "src", "deep"),
		other = join(root, "other");
	await git(environment, context, ["worktree", "add", "--detach", worktree]);
	await mkdir(nested, { recursive: true });
	await mkdir(other);
	await git(environment, { ...context, cwd: other }, ["init", "-q"]);
	await memory.tool.execute({ op: "write", content: "Repository-specific deadline\n" }, context);
	const original = await memory.context(context);
	for (const path of [worktree, nested]) {
		const shared = await memory.context({ ...context, cwd: path, sessionId: path });
		expect(shared.directory).toBe(original.directory);
		expect(shared.content).toBe("Repository-specific deadline\n");
	}
	const isolated = await memory.context({ ...context, cwd: other });
	expect(isolated.project).not.toBe(original.project);
	expect(isolated.content).toBe("");
});

test("non-git children keep their startup root but unrelated roots remain isolated", async () => {
	const { root, cwd, memory, context } = await fixture();
	const child = join(cwd, "nested"),
		other = join(root, "unrelated");
	await mkdir(child);
	await mkdir(other);
	await memory.tool.execute({ op: "write", content: "Loose project preference\n" }, context);
	const original = await memory.context(context);
	expect((await memory.context({ ...context, cwd: child })).directory).toBe(original.directory);
	expect((await memory.context({ ...context, cwd: other })).content).toBe("");
	expect((await memory.context({ ...context, cwd: other })).directory).not.toBe(original.directory);
});

test("remote project identities isolate hosts and ports but all note bytes stay local", async () => {
	const { config, context, home } = await fixture();
	const remoteWorkspace = (target: RemoteTarget) => {
		const executor = {
			defaultCwd: "/srv/project",
			exec: async (argv: readonly string[], options: { cwd: string }) => {
				let stdout: string;
				if (argv[0] === "git") stdout = "/srv/project/.git\n";
				else if (argv[0] === "pwd") stdout = `${options.cwd}\n`;
				else throw new Error(`Memory attempted remote file I/O: ${argv.join(" ")}`);
				return {
					code: 0,
					signal: null,
					stdout,
					stderr: "",
					droppedStdoutBytes: 0,
					timedOut: false,
					aborted: false,
				};
			},
		} as unknown as Executor;
		const fs = new Proxy({} as WorkspaceFs, {
			get() {
				throw new Error("Memory touched the remote filesystem");
			},
		});
		return new Workspace(`ssh:${target.host}:${target.port ?? 22}`, target.host, executor, fs, true);
	};
	const memory = new AutoMemory(config, (ctx) => remoteWorkspace(ctx.remote!));
	const a = { ...context, cwd: "/srv/project", remote: { host: "alice@host-a", cwd: "/srv/project" } };
	const b = { ...a, remote: { ...a.remote, host: "alice@host-b" } };
	const port = { ...a, remote: { ...a.remote, port: 2222 } };
	const saved = await memory.tool.execute({ op: "write", content: "Remote deployment preference\n" }, a);
	expect(saved.isError).not.toBe(true);
	const first = await memory.context(a);
	expect(first.directory.startsWith(`${home}/projects/`)).toBe(true);
	expect(await readFile(join(first.directory, "MEMORY.md"), "utf8")).toBe("Remote deployment preference\n");
	expect((await memory.context({ ...a, cwd: "/srv/project/subdir" })).directory).toBe(first.directory);
	for (const isolated of [b, port]) {
		const result = await memory.context(isolated);
		expect(result.directory).not.toBe(first.directory);
		expect(result.content).toBe("");
	}
});

test("unread and stale memory mutations preserve human edits; explicit observed hashes permit updates", async () => {
	const { memory, context, config, workspaceFor } = await fixture();
	const saved = await memory.tool.execute({ op: "write", content: "Original\n" }, context);
	const path = details(saved).path as string;
	const newcomer = new AutoMemory(config, workspaceFor);
	const nextContext = { ...context, sessionId: "new" };
	const unread = await newcomer.tool.execute({ op: "write", content: "Would clobber\n" }, nextContext);
	expect(details(unread).reason).toBe("unread");
	expect(await readFile(path, "utf8")).toBe("Original\n");
	await newcomer.tool.execute({ op: "read" }, nextContext);
	await writeFile(path, "Human revision\n");
	const stale = await newcomer.tool.execute(
		{ op: "edit", old_text: "Human revision", new_text: "Would clobber" },
		nextContext,
	);
	expect(details(stale).reason).toBe("stale");
	expect(await readFile(path, "utf8")).toBe("Human revision\n");
	const read = await newcomer.tool.execute({ op: "read" }, nextContext);
	const explicit = await memory.tool.execute(
		{
			op: "edit",
			old_text: "Human revision",
			new_text: "Reviewed revision",
			expected_hash: details(read).hash,
		},
		context,
	);
	expect(explicit.isError).not.toBe(true);
	expect(await readFile(path, "utf8")).toBe("Reviewed revision\n");
	const staleDelete = await newcomer.tool.execute({ op: "remove" }, nextContext);
	expect(details(staleDelete).reason).toBe("stale");
	expect(await readFile(path, "utf8")).toBe("Reviewed revision\n");
});

test("external deletion is not silently resurrected and explicit create-only never overwrites a file", async () => {
	const { memory, context } = await fixture();
	const saved = await memory.tool.execute({ op: "write", content: "Original\n" }, context);
	const path = details(saved).path as string;
	await unlink(path);
	const stale = await memory.tool.execute({ op: "write", content: "Resurrected\n" }, context);
	expect(details(stale).reason).toBe("stale");
	expect(await Bun.file(path).exists()).toBe(false);
	expect(
		(
			await memory.tool.execute(
				{ op: "write", content: "Explicit recreation\n", expected_hash: null },
				context,
			)
		).isError,
	).not.toBe(true);
	expect(
		(await memory.tool.execute({ op: "write", content: "Clobber\n", expected_hash: null }, context)).isError,
	).toBe(true);
	expect(await readFile(path, "utf8")).toBe("Explicit recreation\n");
	expect((await memory.tool.execute({ op: "remove" }, context)).isError).not.toBe(true);
	expect((await memory.context({ ...context, sessionId: "after-remove" })).content).toBe("");
});

test("memory paths cannot escape through traversal, symlinks, or hardlinks", async () => {
	const { root, memory, context } = await fixture();
	await memory.tool.execute({ op: "write", content: "Index\n" }, context);
	const { directory } = await memory.context(context);
	const outside = join(root, "outside.md");
	await writeFile(outside, "Outside private content\n");
	await symlink(outside, join(directory, "link.md"));
	await symlink(root, join(directory, "escape"));
	await link(outside, join(directory, "hard.md"));
	for (const path of ["../../../outside.md", outside, "link.md", "escape/outside.md", "hard.md"]) {
		const read = await memory.tool.execute({ op: "read", path }, context);
		expect(read.isError).toBe(true);
		expect(read.text).not.toContain("Outside private content");
		const write = await memory.tool.execute({ op: "write", path, content: "Clobber\n" }, context);
		expect(write.isError).toBe(true);
	}
	expect(await readFile(outside, "utf8")).toBe("Outside private content\n");
	const list = await memory.tool.execute({ op: "list" }, context);
	expect((details(list).files as Record<string, Json>[]).map((entry) => entry.path)).toEqual(["MEMORY.md"]);
});

test("a symlinked memory root is not followed, and memory mutations are not project checkpoint effects", async () => {
	const { root, memory, context } = await fixture();
	const isolatedContext = {
		...context,
		checkMutationPaths: async () => {
			throw new Error("Project scope was incorrectly applied to memory");
		},
	};
	const saved = await observeMutations(
		{
			observe: async () => {
				throw new Error("Memory was incorrectly checkpointed");
			},
		},
		() =>
			memory.tool.execute(
				{ op: "write", path: "topics/preference.md", content: "Durable preference\n" },
				isolatedContext,
			),
	);
	expect(saved.isError).not.toBe(true);
	const { directory } = await memory.context(context);
	await rm(directory, { recursive: true });
	const outside = join(root, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "MEMORY.md"), "Do not import\n");
	await symlink(outside, directory);
	await expect(memory.context(context)).rejects.toThrow("symlink");
	expect((await memory.tool.execute({ op: "write", content: "Clobber\n" }, context)).isError).toBe(true);
	expect(await readFile(join(outside, "MEMORY.md"), "utf8")).toBe("Do not import\n");
});

test("index line limits are honest after saving and truncated startup context does not authorize overwrites", async () => {
	const { memory, context, config, workspaceFor } = await fixture();
	const lines = (count: number) => Array.from({ length: count }, (_, i) => `Entry ${i + 1}\n`).join("");
	const near = await memory.tool.execute({ op: "write", content: lines(180) }, context);
	expect(near.isError).not.toBe(true);
	expect(details(near).nearLimit).toBe(true);
	expect(details(near).overLimit).toBe(false);
	await memory.tool.execute({ op: "write", content: lines(200) }, context);
	expect((await memory.context(context)).truncated).toBe(false);
	const over = await memory.tool.execute({ op: "write", content: lines(201) }, context);
	expect(over.isError).toBe(true);
	expect(details(over).saved).toBe(true);
	expect(details(over).overLimit).toBe(true);
	expect(await readFile(details(over).path as string, "utf8")).toBe(lines(201));
	const next = new AutoMemory(config, workspaceFor),
		nextContext = { ...context, sessionId: "after-limit" };
	const startup = await next.context(nextContext);
	expect(startup.truncated).toBe(true);
	expect(startup.content).toBe(lines(200));
	const unread = await next.tool.execute({ op: "write", content: "Short index\n" }, nextContext);
	expect(details(unread).reason).toBe("unread");
	await next.tool.execute({ op: "read" }, nextContext);
	expect((await next.tool.execute({ op: "write", content: "Short index\n" }, nextContext)).isError).not.toBe(
		true,
	);
	expect((await next.context(nextContext)).content).toBe("Short index\n");
});

test("byte limits use UTF-8 bytes without splitting characters, and apply only to the index", async () => {
	const { memory, context } = await fixture();
	const exact = "a".repeat(25 * 1024);
	const full = await memory.tool.execute({ op: "write", content: exact }, context);
	expect(full.isError).not.toBe(true);
	expect((await memory.context(context)).content).toBe(exact);
	expect((await memory.context(context)).truncated).toBe(false);
	const content = "a" + "🙂".repeat(6400);
	const over = await memory.tool.execute({ op: "write", content }, context);
	expect(over.isError).toBe(true);
	expect(details(over).indexBytes).toBe(25 * 1024 + 1);
	const bounded = await memory.context({ ...context, sessionId: "unicode" });
	expect(bounded.truncated).toBe(true);
	expect(bounded.content).toBe("a" + "🙂".repeat(6399));
	expect(bounded.content).not.toContain("\uFFFD");
	const topic = await memory.tool.execute({ op: "write", path: "reference.md", content }, context);
	expect(topic.isError).not.toBe(true);
	expect(
		(await memory.tool.execute({ op: "read", path: "reference.md" }, context)).text.endsWith(content),
	).toBe(true);
});

test("existing frontmatter gets one modified timestamp while plain Markdown and CRLF stay intact", async () => {
	const { memory, context } = await fixture();
	const source =
		"\uFEFF---\r\nname: Feedback\r\ntype: feedback\r\nmodified: |\r\n  old timestamp\r\n---\r\nPreserve the body.\r\n";
	const saved = await memory.tool.execute({ op: "write", path: "feedback.md", content: source }, context);
	expect(saved.isError).not.toBe(true);
	const written = await readFile(details(saved).path as string, "utf8");
	expect(written).toMatch(
		/^\uFEFF---\r\nname: Feedback\r\ntype: feedback\r\nmodified: "\d{4}-\d\d-\d\dT[^"\r\n]+Z"\r\n---\r\nPreserve the body\.\r\n$/,
	);
	const edited = await memory.tool.execute(
		{
			op: "edit",
			path: "feedback.md",
			old_text: "Preserve the body.",
			new_text: "Updated durable feedback.",
		},
		context,
	);
	expect(edited.isError).not.toBe(true);
	const after = await readFile(details(saved).path as string, "utf8");
	expect(after.match(/^modified:/gm)?.length).toBe(1);
	expect(after.endsWith("Updated durable feedback.\r\n")).toBe(true);
	const plain = await memory.tool.execute(
		{ op: "write", path: "plain.md", content: "Plain note\n" },
		context,
	);
	expect(await readFile(details(plain).path as string, "utf8")).toBe("Plain note\n");
	const empty = await memory.tool.execute(
		{ op: "write", path: "empty-frontmatter.md", content: "---\n---\nNote\n" },
		context,
	);
	expect(await readFile(details(empty).path as string, "utf8")).toMatch(
		/^---\nmodified: "[^"\n]+"\n---\nNote\n$/,
	);
});

test("persistent toggles preserve settings and notes, disable automatic recall and writes, and allow inspection", async () => {
	const { memory, context, home, cwd, workspaceFor } = await fixture();
	await writeFile(join(home, "config.json"), JSON.stringify({ maxTurns: 17 }));
	await memory.tool.execute({ op: "write", content: "Remember this preference\n" }, context);
	const off = await memory.setEnabled(false);
	expect(off.path).toBe(join(home, "config.json"));
	expect(await Bun.file(off.path).json()).toEqual({ maxTurns: 17, autoMemoryEnabled: false });
	const reloadedConfig = await loadConfig({ cwd, home });
	const restarted = new AutoMemory(reloadedConfig, workspaceFor);
	const disabled = await restarted.context({ ...context, sessionId: "disabled" });
	expect(disabled.enabled).toBe(false);
	expect(disabled.content).toBe("");
	expect((await restarted.tool.execute({ op: "read" }, context)).text).toContain("Remember this preference");
	expect((await restarted.tool.execute({ op: "write", content: "Must not save\n" }, context)).isError).toBe(
		true,
	);
	expect(await readFile(join(disabled.directory, "MEMORY.md"), "utf8")).toBe("Remember this preference\n");
	await restarted.setEnabled(true);
	expect((await loadConfig({ cwd, home })).autoMemoryEnabled).toBe(true);
	expect((await restarted.context(context)).content).toBe("Remember this preference\n");
	// A failure to persist never changes the running setting or discards the user's malformed file.
	await writeFile(off.path, "{unfinished human edit");
	await expect(restarted.setEnabled(false)).rejects.toThrow();
	expect((await restarted.context(context)).enabled).toBe(true);
	expect(await readFile(off.path, "utf8")).toBe("{unfinished human edit");
});

test("toggles persist to the effective project or explicit settings source instead of being lost to precedence", async () => {
	const { cwd, home, workspaceFor, context } = await fixture();
	await writeFile(join(home, "config.json"), JSON.stringify({ autoMemoryEnabled: false }));
	const projectSettings = join(cwd, ".salam", "config.json");
	await mkdir(join(cwd, ".salam"));
	await writeFile(projectSettings, JSON.stringify({ autoMemoryEnabled: false, maxTurns: 23 }));
	const config = await loadConfig({ cwd, home });
	const memory = new AutoMemory(config, workspaceFor);
	const enabled = await memory.setEnabled(true);
	expect(enabled.path).toBe(projectSettings);
	expect(await Bun.file(projectSettings).json()).toEqual({ autoMemoryEnabled: true, maxTurns: 23 });
	expect((await Bun.file(join(home, "config.json")).json()).autoMemoryEnabled).toBe(false);
	expect((await new AutoMemory(await loadConfig({ cwd, home }), workspaceFor).context(context)).enabled).toBe(
		true,
	);
	const explicit = join(cwd, "chosen-settings.json");
	await writeFile(explicit, JSON.stringify({ autoMemoryEnabled: true }));
	const selected = new AutoMemory(await loadConfig({ cwd, home, file: explicit }), workspaceFor);
	expect((await selected.setEnabled(false)).path).toBe(explicit);
	expect((await loadConfig({ cwd, home, file: explicit })).autoMemoryEnabled).toBe(false);
	expect((await Bun.file(projectSettings).json()).autoMemoryEnabled).toBe(true);
});

test("an explicit memory directory is honored but checked-in project settings cannot redirect local writes", async () => {
	const { root, home, cwd, context, workspaceFor } = await fixture();
	const directory = join(root, "my-notes");
	await writeFile(join(home, "config.json"), JSON.stringify({ autoMemoryDirectory: directory }));
	const memory = new AutoMemory(await loadConfig({ cwd, home }), workspaceFor);
	expect((await memory.context(context)).directory).toBe(directory);
	expect(
		(await memory.tool.execute({ op: "write", content: "Explicit storage\n" }, context)).isError,
	).not.toBe(true);
	expect(await readFile(join(directory, "MEMORY.md"), "utf8")).toBe("Explicit storage\n");
	await mkdir(join(cwd, ".salam"));
	const projectSettings = join(cwd, ".salam", "config.json");
	await writeFile(projectSettings, JSON.stringify({ autoMemoryDirectory: join(root, "repo-controlled") }));
	await expect(loadConfig({ cwd, home })).rejects.toThrow("autoMemoryDirectory");
	const explicit = await loadConfig({ cwd, home, file: projectSettings });
	expect(explicit.autoMemoryDirectory).toBe(join(root, "repo-controlled"));
});

test("ambiguous edits require an explicit all option and replacement text is literal", async () => {
	const { memory, context } = await fixture();
	const saved = await memory.tool.execute(
		{ op: "write", path: "feedback.md", content: "Prefer small steps.\r\nPrefer small steps.\r\n" },
		context,
	);
	const path = details(saved).path as string;
	const ambiguous = await memory.tool.execute(
		{ op: "edit", path: "feedback.md", old_text: "small", new_text: "$&" },
		context,
	);
	expect(ambiguous.isError).toBe(true);
	expect(await readFile(path, "utf8")).toBe("Prefer small steps.\r\nPrefer small steps.\r\n");
	const edited = await memory.tool.execute(
		{ op: "edit", path: "feedback.md", old_text: "small", new_text: "$&", all: true },
		context,
	);
	expect(edited.isError).not.toBe(true);
	expect(await readFile(path, "utf8")).toBe("Prefer $& steps.\r\nPrefer $& steps.\r\n");
});

test("an environment disable cannot be overridden by a persisted enable claim", async () => {
	const { memory, context, home } = await fixture();
	await memory.tool.execute({ op: "write", content: "Durable preference\n" }, context);
	const previous = process.env.SALAM_DISABLE_AUTO_MEMORY;
	process.env.SALAM_DISABLE_AUTO_MEMORY = "1";
	try {
		expect((await memory.context(context)).enabled).toBe(false);
		expect((await memory.context(context)).content).toBe("");
		await expect(memory.setEnabled(true)).rejects.toThrow("SALAM_DISABLE_AUTO_MEMORY");
		expect(await Bun.file(join(home, "config.json")).exists()).toBe(false);
	} finally {
		if (previous === undefined) delete process.env.SALAM_DISABLE_AUTO_MEMORY;
		else process.env.SALAM_DISABLE_AUTO_MEMORY = previous;
	}
});
