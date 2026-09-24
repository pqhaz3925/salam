import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/tools/artifacts.ts";
import { LocalExecutor } from "../src/tools/exec.ts";
import { type ForegroundRequest, type ProcessInfo, ProcessRegistry } from "../src/tools/processes.ts";
import { shellQuote } from "../src/tools/util.ts";

let directory: string | undefined;
let registry: ProcessRegistry | undefined;

afterEach(async () => {
	await registry?.close();
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
	registry = undefined;
});

async function prepare(): Promise<(command: string) => ProcessInfo> {
	directory = await mkdtemp(join(tmpdir(), "salam-jobs-"));
	const executor = new LocalExecutor(directory);
	const jobs = new ProcessRegistry(new ArtifactStore(join(directory, "state")));
	registry = jobs;
	return (command: string) =>
		jobs.start({
			executor,
			argv: ["/bin/sh", "-c", command],
			command,
			cwd: directory!,
			target: "this machine",
			sessionId: "jobs",
			agentId: "main",
			timeoutMs: 0,
		});
}

/**
 * These tests drive real child processes, whose output and death arrive on the
 * platform clock — there is no timer to fake. Polling awaits the condition
 * itself and returns the instant it holds, so nothing pays a guessed delay.
 */
async function eventually(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (await condition()) return;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting until ${what}.`);
}

test("a cancelled wait leaves the command running and cursors never replay output", async () => {
	const start = await prepare();
	const jobs = registry!;
	const job = start("echo one; sleep 0.2; echo two; sleep 30");

	const controller = new AbortController();
	const pending = jobs.wait(job.id, 10_000, controller.signal);
	controller.abort();
	const interrupted = await pending;
	expect(interrupted.job.state).toBe("running");

	let seen = interrupted.text;
	let cursor = interrupted.cursor;
	await eventually(async () => {
		const output = await jobs.read(job.id, cursor);
		seen += output.text;
		cursor = output.cursor;
		return seen.includes("two");
	}, "the interrupted command produced its later output");
	// Aborting the wait cost the job nothing: both lines arrive, each exactly once.
	expect(seen.match(/one/g)).toHaveLength(1);
	expect(seen.match(/two/g)).toHaveLength(1);
	expect((await jobs.read(job.id, cursor)).text).toBe("");

	const stopped = await jobs.stop(job.id);
	expect(stopped.job.state).toBe("cancelled");
	expect(stopped.job.endedAt).toBeGreaterThanOrEqual(stopped.job.startedAt);
});

test("stopping a command escalates for a TERM-resistant descendant after its leader exits", async () => {
	const start = await prepare();
	const jobs = registry!;
	// A real child must keep its own event loop alive until a kernel signal; fake timers cannot drive it.
	const script = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)";
	const job = start(`${shellQuote(process.execPath)} -e ${shellQuote(script)} & wait`);
	let grandchild = 0;
	let alive = true;
	try {
		await eventually(async () => {
			const match = /^\d+/.exec((await jobs.read(job.id)).text);
			if (match) grandchild = Number(match[0]);
			return grandchild > 0;
		}, "the command reported its TERM-resistant grandchild");
		const stopped = await jobs.stop(job.id);
		expect(stopped.job.state).toBe("cancelled");
		await eventually(() => {
			try {
				process.kill(grandchild, 0);
				return false;
			} catch {
				alive = false;
				return true;
			}
		}, "the resistant grandchild was reaped");
		expect(alive).toBe(false);
	} finally {
		if (alive && grandchild > 0) {
			try {
				process.kill(grandchild, "SIGKILL");
			} catch {
				/* Already reaped. */
			}
		}
	}
}, 10000);

test("a flood of output stays bounded, says what it dropped and keeps the tail readable", async () => {
	const start = await prepare();
	const jobs = registry!;
	const job = start("yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 3000000; echo END");

	const finished = await jobs.wait(job.id, 30_000);
	expect(finished.job.state).toBe("exited");
	expect(finished.job.exitCode).toBe(0);
	expect(finished.truncated).toBe(true);
	expect(finished.artifact).toBeDefined();
	expect(finished.text).toContain("of earlier output dropped");
	expect(finished.cursor).toBeGreaterThan(2_900_000);

	const tail = await jobs.read(job.id, finished.cursor - 4096);
	expect(tail.text).toContain("END");
	expect(tail.text.length).toBeLessThan(8192);
});

function foreground(
	command: string,
	options: Pick<ForegroundRequest, "signal" | "timeoutMs" | "keepDeadline" | "onOutput">,
): ForegroundRequest {
	return {
		executor: new LocalExecutor(directory!),
		argv: ["/bin/sh", "-c", command],
		command,
		cwd: directory!,
		target: "this machine",
		sessionId: "jobs",
		agentId: "main",
		...options,
	};
}

test("a promoted foreground command keeps its process and output and outlives its caller", async () => {
	await prepare();
	const jobs = registry!;
	const controller = new AbortController();
	let streamed = "";
	// `two` is printed only after the default foreground deadline has passed:
	// it arrives only if promotion really lifted that deadline.
	const running = jobs.run(
		// The deadline leaves room for promotion under a loaded (parallel) run.
		foreground("echo $$; sleep 3; echo two; sleep 30", {
			signal: controller.signal,
			timeoutMs: 2_000,
			keepDeadline: false,
			onOutput: (chunk) => {
				streamed += chunk;
			},
		}),
	);
	await eventually(() => /^\d+\n/.test(streamed), "the foreground shell printed its pid");
	const pid = Number(/^\d+/.exec(streamed)![0]);

	expect(jobs.promote({ sessionId: "other", agentId: "main" })).toEqual([]);
	expect(jobs.promote({ sessionId: "jobs", agentId: "child" })).toEqual([]);
	const promoted = jobs.promote({ sessionId: "jobs", agentId: "main" });
	expect(promoted.map((job) => job.state)).toEqual(["running"]);
	const outcome = await running;
	expect(outcome.promoted ? outcome.job.id : "not promoted").toBe(promoted[0]!.id);
	// The caller's interrupt no longer reaches the command it gave away.
	controller.abort();

	const id = promoted[0]!.id;
	const before = await jobs.read(id);
	expect(before.text).toBe(`${pid}\n`);
	let later = "";
	let cursor = before.cursor;
	await eventually(async () => {
		const output = await jobs.read(id, cursor);
		later += output.text;
		cursor = output.cursor;
		return later.includes("two");
	}, "the promoted command printed past its old deadline");
	// Nothing repeats across the move, and nothing streams to the old caller after it.
	expect(later).toBe("two\n");
	expect(streamed).toBe(`${pid}\n`);

	const stopped = await jobs.stop(id);
	expect(stopped.job.state).toBe("cancelled");
	await eventually(() => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}, "the stopped command's shell was reaped");
}, 10000);

test("an interrupt or exit before promotion keeps the command in the foreground", async () => {
	await prepare();
	const jobs = registry!;
	const controller = new AbortController();
	let streamed = "";
	const interrupted = jobs.run(
		foreground("echo ready; sleep 30", {
			signal: controller.signal,
			timeoutMs: 30_000,
			keepDeadline: true,
			onOutput: (chunk) => {
				streamed += chunk;
			},
		}),
	);
	await eventually(() => streamed.includes("ready"), "the foreground command started");
	controller.abort();
	expect(jobs.promote({ sessionId: "jobs", agentId: "main" })).toEqual([]);
	const cancelled = await interrupted;
	expect(cancelled.promoted ? "promoted" : cancelled.result.aborted).toBe(true);

	const exited = await jobs.run(
		foreground("echo done", {
			signal: new AbortController().signal,
			timeoutMs: 30_000,
			keepDeadline: false,
			onOutput: () => {},
		}),
	);
	expect(exited.promoted ? "promoted" : exited.result.stdout).toBe("done\n");
	expect(jobs.promote({ sessionId: "jobs", agentId: "main" })).toEqual([]);
	expect(jobs.list()).toEqual([]);
});

test("PTY input follows an observed prompt, resize changes the terminal, and Unicode cursors do not replay", async () => {
	await prepare();
	const jobs = registry!;
	const job = jobs.start({
		executor: new LocalExecutor(directory!),
		argv: ["python3", "-q"],
		command: "python3 -q",
		cwd: directory!,
		target: "this machine",
		sessionId: "jobs",
		agentId: "main",
		timeoutMs: 0,
		pty: true,
		cols: 80,
		rows: 24,
	});
	const prompt = await jobs.waitReady(job.id, { log: ">>> " }, 10_000);
	const sent = await jobs.send(
		job.id,
		{ text: "print(chr(65)+chr(0x1f600)+chr(0x754c))", keys: ["ENTER"], cols: 91, rows: 17 },
		prompt.cursor,
	);
	let text = sent.text;
	let cursor = sent.cursor;
	await eventually(async () => {
		const output = await jobs.read(job.id, cursor);
		text += output.text;
		cursor = output.cursor;
		return text.includes("A😀界") && text.includes(">>> ");
	}, "the REPL evaluates Unicode input");
	expect(text.match(/A😀界/g)).toHaveLength(1);
	expect((await jobs.read(job.id, cursor)).text).toBe("");
	const screen = await jobs.screen(job.id);
	expect(screen.cols).toBe(91);
	expect(screen.rows).toBe(17);
	expect(screen.text).toContain("A😀界");
	await jobs.send(job.id, { eof: true }, cursor);
	expect((await jobs.wait(job.id, 10_000)).job.exitCode).toBe(0);
}, 20_000);

test("terminal snapshots model alternate-screen cursor addressing, erase, CR, backspace and wide cells", async () => {
	await prepare();
	const jobs = registry!;
	const script =
		"import sys,time;sys.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[Hobsolete\\rALT\\x1b[K\\x1b[3;4H界XY\\bZ');sys.stdout.flush();time.sleep(30)";
	const job = jobs.start({
		executor: new LocalExecutor(directory!),
		argv: ["python3", "-u", "-c", script],
		command: "terminal fixture",
		cwd: directory!,
		target: "this machine",
		sessionId: "jobs",
		agentId: "main",
		timeoutMs: 0,
		pty: true,
		cols: 30,
		rows: 6,
	});
	await jobs.waitReady(job.id, { log: "ALT" }, 10_000);
	const screen = await jobs.screen(job.id);
	expect(screen.alternate).toBe(true);
	expect(screen.text.split("\n")[0]).toBe("ALT");
	expect(screen.text.split("\n")[2]).toBe("   界XZ");
	expect(screen.text).not.toContain("obsolete");
	expect(screen.text).not.toContain("\x1b");
	await jobs.stop(job.id);
}, 20_000);

test("another live registry cannot recover or stop an instance's commands", async () => {
	const start = await prepare();
	const original = registry!;
	const job = start("printf READY; sleep 30");
	await original.waitReady(job.id, { log: "READY" }, 10_000);
	const other = new ProcessRegistry(new ArtifactStore(join(directory!, "state")));
	try {
		expect(await other.recover()).toEqual([]);
		await other.close();
		expect((await original.read(job.id)).job.state).toBe("running");
		await expect(other.stop(job.id)).rejects.toThrow();
		expect((await original.stop(job.id)).job.terminationConfirmed).toBe(true);
	} finally {
		await other.close();
	}
}, 20_000);

test("a crashed registry releases its lease and an orphan is recovered exactly once", async () => {
	await prepare();
	const source = `
		import { ProcessRegistry } from ${JSON.stringify(new URL("../src/tools/processes.ts", import.meta.url).href)};
		import { ArtifactStore } from ${JSON.stringify(new URL("../src/tools/artifacts.ts", import.meta.url).href)};
		import { LocalExecutor } from ${JSON.stringify(new URL("../src/tools/exec.ts", import.meta.url).href)};
		const cwd = ${JSON.stringify(directory)};
		const registry = new ProcessRegistry(new ArtifactStore(cwd + "/state"));
		const job = registry.start({executor:new LocalExecutor(cwd),argv:["python3","-u","-c","print('PROMPT',flush=True);print(input(),flush=True)"],command:"echo",cwd,target:"this machine",sessionId:"jobs",agentId:"main",timeoutMs:0,interactive:true});
		const first = await registry.waitReady(job.id,{log:"PROMPT"},10000);
		console.log(JSON.stringify({id:job.id,cursor:first.cursor}));
	`;
	const owner = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "inherit" });
	const reader = owner.stdout.getReader();
	let announcement = "";
	try {
		while (!announcement.includes("\n")) {
			const { value, done } = await reader.read();
			if (done) throw new Error("Registry owner exited before readiness");
			announcement += new TextDecoder().decode(value);
		}
		const first = JSON.parse(announcement.trim()) as { id: string; cursor: number };
		owner.kill("SIGKILL");
		await owner.exited;
		const recovered = registry!;
		expect((await recovered.recover()).map((entry) => entry.id)).toContain(first.id);
		const rival = new ProcessRegistry(new ArtifactStore(join(directory!, "state")));
		try {
			expect(await rival.recover()).toEqual([]);
		} finally {
			await rival.close();
		}
		expect((await recovered.read(first.id, first.cursor)).text).toBe("");
		await recovered.send(first.id, { text: "recovered😀", keys: ["ENTER"] }, first.cursor);
		const final = await recovered.wait(first.id, 10_000, undefined, first.cursor);
		expect(final.text).toBe("recovered😀\n");
		expect((await recovered.read(first.id, final.cursor)).text).toBe("");
		expect(final.job.exitCode).toBe(0);
	} finally {
		reader.releaseLock();
		if (owner.exitCode === null) owner.kill("SIGKILL");
		await owner.exited;
	}
}, 30_000);

test("readiness refuses an early exit instead of mistaking spawn for readiness", async () => {
	const start = await prepare();
	const job = start("printf not-ready");
	await expect(registry!.waitReady(job.id, { log: "^READY$" }, 10_000)).rejects.toThrow();
});

test("readiness ignores an old prompt and pipe ENTER submits a new line", async () => {
	await prepare();
	const jobs = registry!;
	const job = jobs.start({
		executor: new LocalExecutor(directory!),
		argv: [
			"python3",
			"-u",
			"-c",
			"import sys;print('PROMPT',flush=True);line=input();print('RESULT:'+line,flush=True);print('PROMPT',flush=True);input()",
		],
		command: "prompt fixture",
		cwd: directory!,
		target: "this machine",
		sessionId: "jobs",
		agentId: "main",
		timeoutMs: 0,
		interactive: true,
	});
	const first = await jobs.waitReady(job.id, { log: "PROMPT" }, 10_000);
	await expect(jobs.waitReady(job.id, { log: "PROMPT" }, 150, undefined, first.cursor)).rejects.toThrow();
	await jobs.send(job.id, { text: "next😀", keys: ["ENTER"] }, first.cursor);
	const next = await jobs.waitReady(job.id, { log: "PROMPT" }, 10_000, undefined, first.cursor);
	expect(next.text).toContain("RESULT:next😀\nPROMPT");
	await jobs.stop(job.id);
}, 20_000);

test("restoring a saved cursor after PTY shrink preserves control and screen bounds", async () => {
	await prepare();
	const jobs = registry!;
	const script =
		"import sys;sys.stdout.write('\\x1b[29;70H\\x1b7READY');sys.stdout.flush();input();sys.stdout.write('\\x1b8X');sys.stdout.flush();input()";
	const job = jobs.start({
		executor: new LocalExecutor(directory!),
		argv: ["python3", "-u", "-c", script],
		command: "saved cursor fixture",
		cwd: directory!,
		target: "this machine",
		sessionId: "jobs",
		agentId: "main",
		timeoutMs: 0,
		pty: true,
		cols: 80,
		rows: 30,
	});
	const ready = await jobs.waitReady(job.id, { log: "READY" }, 10_000);
	await jobs.send(job.id, { cols: 20, rows: 10, keys: ["ENTER"] }, ready.cursor);
	await jobs.waitReady(job.id, { log: "X" }, 10_000, undefined, ready.cursor);
	const screen = await jobs.screen(job.id);
	expect(screen.cursorX).toBeLessThan(20);
	expect(screen.cursorY).toBeLessThan(10);
	expect(screen.text).toContain("X");
	expect((await jobs.stop(job.id)).job.terminationConfirmed).toBe(true);
}, 20_000);

test("protocol floods backpressure without losing bytes or killing the interpreter", async () => {
	await prepare();
	const child = new LocalExecutor(directory!).startProtocolProcess([
		"python3",
		"-u",
		"-c",
		"import sys;sys.stdout.write('x'*4000000+'\\n');sys.stdout.flush();print(input(),flush=True)",
	]);
	let bytes = 0;
	let tail = "";
	child.child.stdout!.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		tail = (tail + chunk.toString()).slice(-40);
	});
	try {
		await eventually(() => bytes >= 4_000_001, "all flood bytes were consumed");
		child.child.stdin!.write("still-alive\n");
		await eventually(
			() => tail.includes("still-alive\n"),
			"the same protocol child accepted follow-up input",
		);
		expect(bytes).toBe(4_000_013);
		expect(await child.terminate()).toBe(true);
	} finally {
		await child.terminate();
	}
}, 30_000);

test("PTY teardown includes TERM-resistant job-control groups in its owned session", async () => {
	await prepare();
	const jobs = registry!;
	const script =
		"import os,signal,time\nif os.fork()==0:\n os.setpgid(0,0)\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n signal.signal(signal.SIGHUP,signal.SIG_IGN)\n print('CHILD_READY',flush=True)\n while True: time.sleep(1)\nelse:\n while True: time.sleep(1)";
	const job = jobs.start({
		executor: new LocalExecutor(directory!),
		argv: ["python3", "-u", "-c", script],
		command: "job-control fixture",
		cwd: directory!,
		target: "this machine",
		sessionId: "jobs",
		agentId: "main",
		timeoutMs: 0,
		pty: true,
	});
	await jobs.waitReady(job.id, { log: "CHILD_READY" }, 10_000);
	const stopped = await jobs.stop(job.id);
	expect(stopped.job.state).toBe("cancelled");
	expect(stopped.job.terminationConfirmed).toBe(true);
}, 20_000);

test("reads racing a command's completion never fail as the supervisor retires", async () => {
	const start = await prepare();
	// Reads in flight while the finished command's supervisor is forgotten (or
	// briefly refusing connections) must return the final output, not an error:
	// a command_watch that hit such an error used to lose the exit event.
	const jobs = [start("sleep 0.3; echo done-a"), start("sleep 0.35; echo done-b")];
	const failures: string[] = [];
	const reads: Promise<unknown>[] = [];
	const end = Date.now() + 1_500;
	while (Date.now() < end) {
		for (const job of jobs)
			reads.push(registry!.read(job.id).catch((error: unknown) => failures.push(String(error))));
		await Bun.sleep(10);
	}
	await Promise.all(reads);
	expect(failures).toEqual([]);
	for (const [index, job] of jobs.entries()) {
		const output = await registry!.read(job.id);
		expect(output.text).toContain(`done-${"ab"[index]}`);
	}
});
