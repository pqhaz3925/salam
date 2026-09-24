import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { ToolContext } from "../src/contracts.ts";
import { createEvalTools } from "../src/tools/eval.ts";
import { createFileTools } from "../src/tools/files.ts";
import { ToolEnvironment } from "../src/tools/workspace.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const cwd = await mkdtemp(join(tmpdir(), "salam-eval-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const environment = new ToolEnvironment(await loadConfig({ cwd, home: join(cwd, "state") }));
	cleanups.push(() => environment.close());
	const service = createEvalTools(environment);
	cleanups.push(() => service.close());
	const files = createFileTools(environment);
	service.setInvoker(async (name, args, context) => {
		const tool = files.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`Unknown tool: ${name}`);
		return tool.execute(args, context);
	});
	const context: ToolContext = {
		cwd,
		sessionId: "session",
		agentId: "main",
		signal: new AbortController().signal,
		emit: () => {},
	};
	return { cwd, environment, service, tool: service.tools[0]!, context };
}

test("JS lexical bindings survive top-level await and errors without crossing agent, session or workspace", async () => {
	const { cwd, tool, context } = await setup();
	expect(
		(
			await tool.execute(
				{ language: "js", code: "const answer = await Promise.resolve(41); let changed = 0" },
				context,
			)
		).isError,
	).not.toBe(true);
	expect(
		(
			await tool.execute(
				{ language: "js", code: "changed = answer + 1; throw new Error('intentional')" },
				context,
			)
		).isError,
	).toBe(true);
	const result = await tool.execute({ language: "js", code: "display({answer, changed})" }, context);
	expect(result.text).toContain("answer: 41");
	expect(result.text).toContain("changed: 42");
	await mkdir(join(cwd, "other"));
	for (const isolated of [
		{ ...context, agentId: "child" },
		{ ...context, sessionId: "other" },
		{ ...context, cwd: join(cwd, "other") },
	]) {
		const absent = await tool.execute({ language: "js", code: "display(typeof answer)" }, isolated);
		expect(absent.text).toContain("undefined");
	}
	await tool.execute({ language: "js", reset: true }, context);
	expect((await tool.execute({ language: "js", code: "answer" }, context)).isError).toBe(true);
}, 30_000);

test("Python persistent async globals invoke real file tools and reject recursive eval without losing state", async () => {
	const { cwd, tool, context } = await setup();
	await Bun.write(join(cwd, "input.txt"), "kernel bridge proof");
	const first = await tool.execute(
		{ language: "py", code: "result = await tool.read(path='input.txt')\nvalue = 41\nresult['text']" },
		context,
	);
	expect(first.isError).not.toBe(true);
	expect(first.text).toContain("kernel bridge proof");
	expect(
		(await tool.execute({ language: "py", code: "await asyncio.sleep(0)\nvalue += 1\nvalue" }, context)).text,
	).toContain("42");
	const recursive = await tool.execute(
		{ language: "py", code: "await tool.eval(language='py', code='value')" },
		context,
	);
	expect(recursive.isError).toBe(true);
	expect((await tool.execute({ language: "py", code: "value" }, context)).text).toContain("42");
}, 20_000);

test("timed out JS cells report state loss and bounded Unicode output remains recoverable", async () => {
	const { environment, tool, context } = await setup();
	const text = "a".repeat(8191) + "𝄞" + "b".repeat(80_000);
	const output = await tool.execute(
		{ language: "js", code: `console.log(${JSON.stringify(text)})` },
		context,
	);
	expect(output.text.length).toBeLessThan(50_000);
	const details = output.details as { artifact: string };
	const journal = await Bun.file(environment.artifacts.resolve(details.artifact)!).text();
	expect(journal).toContain(text);
	const timedOut = await tool.execute(
		{ language: "js", code: "const doomed = 7; while (true) {}", timeout: 1 },
		context,
	);
	expect(timedOut.isError).toBe(true);
	expect(timedOut.details).toMatchObject({ stateLost: true });
	const fresh = await tool.execute({ language: "js", code: "typeof doomed" }, context);
	expect(fresh.isError).not.toBe(true);
	expect(fresh.text).toContain("undefined");
}, 30_000);

test("native and inherited stdout cannot spoof protocol frames or discard lexical state", async () => {
	const { environment, tool, context } = await setup();
	for (const language of ["js", "py"]) {
		const raw = 'native {"type":"done","cell":1}\n{"type":"ready"}\npartial-Ж';
		// Real subprocess stdout crosses a second OS pipe; fake timers cannot flush that bridge.
		const code =
			language === "js"
				? `const savedNative = 37; require('node:fs').writeSync(1, ${JSON.stringify(raw)}); require('node:child_process').execFileSync('printf', ['inherited-output'], {stdio:'inherit'}); await new Promise(r => setTimeout(r, 100));`
				: `import os, subprocess\nsaved_native = 37\nos.write(1, ${JSON.stringify(raw)}.encode())\nsubprocess.run(['printf', 'inherited-output'])\nawait asyncio.sleep(0.1)`;
		const result = await tool.execute({ language, code }, context);
		expect(result.isError).not.toBe(true);
		const details = result.details;
		if (
			!details ||
			typeof details !== "object" ||
			!("artifact" in details) ||
			typeof details.artifact !== "string"
		)
			throw new Error("Missing kernel output artifact.");
		const artifact = details.artifact;
		const journal = await Bun.file(environment.artifacts.resolve(artifact)!).text();
		expect(journal).toContain(raw);
		expect(journal).toContain("inherited-output");
		const next = await tool.execute(
			{ language, code: language === "js" ? "savedNative + 5" : "saved_native + 5" },
			context,
		);
		expect(next.isError).not.toBe(true);
		expect(next.text).toContain("42");
	}
}, 30_000);

test("unserializable and nonfinite Python tool arguments fail without orphaning futures or losing globals", async () => {
	const { tool, context } = await setup();
	await tool.execute({ language: "py", code: "import pathlib\nserialization_survivor = 42" }, context);
	for (const argument of ["pathlib.Path('missing')", "b'bytes'", "float('nan')", "float('inf')"]) {
		const result = await tool.execute(
			{ language: "py", code: `await tool.read(path=${argument})`, timeout: 2 },
			context,
		);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ stateLost: false });
	}
	expect((await tool.execute({ language: "py", code: "serialization_survivor" }, context)).text).toContain(
		"42",
	);
}, 20_000);

test("nested tool failures raise catchable exceptions with their original details in both languages", async () => {
	const { service, tool, context } = await setup();
	service.setInvoker(async () => ({
		text: "Concurrent write rejected",
		isError: true,
		details: { reason: "stale-hash" },
	}));
	const js = await tool.execute(
		{
			language: "js",
			code: "try { await tool.write({path:'file'}); display('unexpected-success'); } catch (e) { display(e.message); display(e.details.reason); }",
		},
		context,
	);
	const py = await tool.execute(
		{
			language: "py",
			code: "try:\n    await tool.write(path='file')\n    print('unexpected-success')\nexcept RuntimeError as e:\n    print(str(e))\n    print(e.details['reason'])",
		},
		context,
	);
	for (const result of [js, py]) {
		expect(result.isError).not.toBe(true);
		expect(result.text).toContain("Concurrent write rejected");
		expect(result.text).toContain("stale-hash");
		expect(result.text).not.toContain("unexpected-success");
	}
}, 20_000);

test("Python future cancellation waits for the host tool's cancellation cleanup before completing", async () => {
	const { service, tool, context } = await setup();
	let cleaned = false;
	service.setInvoker(async (_name, _args, nested) => {
		const cancelled = Promise.withResolvers<void>();
		if (nested.signal.aborted) cancelled.resolve();
		else nested.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
		await cancelled.promise;
		const cleanup = Promise.withResolvers<void>();
		setImmediate(cleanup.resolve);
		await cleanup.promise;
		cleaned = true;
		return { text: "cancelled", isError: true };
	});
	const result = await tool.execute(
		{
			language: "py",
			code: "cancelled = tool.shell(command='delayed write')\ncancelled.cancel()\n42",
			timeout: 3,
		},
		context,
	);
	expect(result.isError).not.toBe(true);
	expect(result.details).toMatchObject({ stateLost: false });
	expect(cleaned).toBe(true);
}, 15_000);

test("prior JS callbacks cannot finish a later cell or borrow its tool invocation context", async () => {
	const { service, tool, context } = await setup();
	let staleCalls = 0;
	service.setInvoker(async () => {
		staleCalls++;
		return { text: "unexpected" };
	});
	const first = await tool.execute(
		{
			language: "js",
			code: "const priorGate = Promise.withResolvers(); const oldWork = priorGate.promise.then(() => { display('prior-cell-output'); setImmediate(() => { throw new Error('prior-cell-error'); }); return tool.read({path:'wrong-cell'}).catch(e => display(e.message)); }); undefined",
		},
		context,
	);
	expect(first.isError).not.toBe(true);
	const next = await tool.execute(
		{
			language: "js",
			code: "priorGate.resolve(); await oldWork; const nextTurn = Promise.withResolvers(); setImmediate(nextTurn.resolve); await nextTurn.promise; const laterCompleted = 42; display(laterCompleted)",
		},
		context,
	);
	expect(next.isError).not.toBe(true);
	expect(next.text).toContain("42");
	expect(next.text).not.toContain("prior-cell-error");
	expect(next.text).not.toContain("prior-cell-output");
	expect(staleCalls).toBe(0);
	expect((await tool.execute({ language: "js", code: "laterCompleted" }, context)).text).toContain("42");
}, 15_000);

test("Python background tasks retain their origin when another cell is active", async () => {
	const { service, tool, context } = await setup();
	let staleCalls = 0;
	service.setInvoker(async () => {
		staleCalls++;
		return { text: "unexpected" };
	});
	const first = await tool.execute(
		{
			language: "py",
			code: "prior_gate = asyncio.Event()\nasync def old_task():\n    await prior_gate.wait()\n    print('prior-python-output')\n    try:\n        await tool.read(path='wrong-cell')\n    except RuntimeError as error:\n        print(str(error))\nprior_task = asyncio.create_task(old_task())",
		},
		context,
	);
	expect(first.isError).not.toBe(true);
	const next = await tool.execute(
		{ language: "py", code: "prior_gate.set()\nawait prior_task\n42" },
		context,
	);
	expect(next.isError).not.toBe(true);
	expect(next.text).toContain("42");
	expect(next.text).not.toContain("prior-python-output");
	expect(staleCalls).toBe(0);
}, 15_000);

test("split UTF-8 Buffer writes preserve exact output in preview and full journal", async () => {
	const { environment, tool, context } = await setup();
	const result = await tool.execute(
		{
			language: "js",
			code: "const utf8 = Buffer.from('𝄞Ж'); process.stdout.write(utf8.subarray(0,2)); process.stdout.write(utf8.subarray(2,5)); process.stdout.write(utf8.subarray(5)); undefined",
		},
		context,
	);
	expect(result.isError).not.toBe(true);
	expect(result.text).toContain("𝄞Ж");
	expect(result.text).not.toContain("�");
	const details = result.details;
	if (
		!details ||
		typeof details !== "object" ||
		!("artifact" in details) ||
		typeof details.artifact !== "string"
	)
		throw new Error("Missing kernel output artifact.");
	const artifact = details.artifact;
	expect(await Bun.file(environment.artifacts.resolve(artifact)!).text()).toContain("𝄞Ж");
}, 15_000);
