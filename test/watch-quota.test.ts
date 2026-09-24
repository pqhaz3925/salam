import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { AppSnapshot, ProviderUsage } from "../src/contracts.ts";
import { quotaView } from "../src/runtime/usage.ts";
import { ArtifactStore } from "../src/tools/artifacts.ts";
import { LocalExecutor } from "../src/tools/exec.ts";
import { type ProcessInfo, ProcessRegistry, type WatchEvent } from "../src/tools/processes.ts";
import { describeWatchEvent, longestSleep, nativeEquivalent } from "../src/tools/shell.ts";
import { ToolEnvironment } from "../src/tools/workspace.ts";
import { buildFooterText } from "../src/ui/status.ts";

let directory: string | undefined;
let registry: ProcessRegistry | undefined;

afterEach(async () => {
	await registry?.close();
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
	registry = undefined;
});

async function prepare(): Promise<(command: string) => ProcessInfo> {
	directory = await mkdtemp(join(tmpdir(), "salam-watch-"));
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

/** Collects watch events and resolves waiters as they arrive (real processes: no fake clock). */
function collector() {
	const events: WatchEvent[] = [];
	const waiters: { count: number; resolve: () => void }[] = [];
	return {
		events,
		push(event: WatchEvent) {
			events.push(event);
			for (const waiter of waiters) if (events.length >= waiter.count) waiter.resolve();
		},
		until(count: number, ms = 10_000): Promise<void> {
			if (events.length >= count) return Promise.resolve();
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			waiters.push({ count, resolve });
			setTimeout(() => reject(new Error(`only ${events.length} of ${count} watch events`)), ms).unref();
			return promise;
		},
	};
}

test("longestSleep finds literal sleeps and sums coreutils operands", () => {
	expect(longestSleep("sleep 300")).toBe(300);
	expect(longestSleep("cd x && sleep 5m; echo done")).toBe(300);
	expect(longestSleep("sleep 1m 30s && make")).toBe(90);
	expect(longestSleep("until curl -fsS localhost; do sleep 2; done")).toBe(2);
	expect(longestSleep("echo $(sleep 12)")).toBe(12);
	expect(longestSleep("echo nosleep 30; ./sleepy 40")).toBe(0);
	expect(longestSleep("python -c 'x'")).toBe(0);
});

test("plain file-inspection commands map to the exact native call; real shell work does not", () => {
	expect(nativeEquivalent("sed -n '120,180p' src/app.ts")).toBe(
		'read {"path":"src/app.ts","offset":120,"limit":61}',
	);
	expect(nativeEquivalent("cat README.md")).toBe('read {"path":"README.md"}');
	expect(nativeEquivalent("cd harness && head -n 40 src/cli.ts")).toBe(
		'read {"path":"src/cli.ts","limit":40}',
	);
	expect(nativeEquivalent("head -5 'a b.txt'")).toBe('read {"path":"a b.txt","limit":5}');
	expect(nativeEquivalent("wc -l src/runtime/index.ts")).toContain(
		'read {"path":"src/runtime/index.ts","limit":1}',
	);
	expect(nativeEquivalent("tail -n 50 build.log")).toContain('read {"path":"build.log"}');
	expect(nativeEquivalent("grep -rn TODO src")).toContain('grep {"pattern":"TODO","path":"src"}');
	expect(nativeEquivalent("rg -l needle")).toContain('"mode":"files"');
	expect(nativeEquivalent('find . -name "*.test.ts" -type f')).toBe(
		'glob {"pattern":"**/*.test.ts","path":"."}',
	);
	for (const real of [
		"cat a.txt | wc -l",
		"git log -5",
		"tail -f server.log",
		"grep -A 3 foo src",
		"sed -i 's/a/b/' f",
		"head -c 100 f",
		"cat > out.txt",
		"find . -name '*.log' -delete",
		"cat",
		"ls -la",
		"wc -l a b",
	])
		expect(nativeEquivalent(real)).toBeUndefined();
});

test("a log watch fires once on the first matching line, then reports the exit", async () => {
	const start = await prepare();
	const job = start(
		"echo booting; sleep 0.3; echo 'server READY on 8080'; echo READY again; sleep 0.3; exit 3",
	);
	const seen = collector();
	registry!.watch(job.id, { log: "READY", exit: true, repeat: false, cursor: 0 }, (event) =>
		seen.push(event),
	);
	await seen.until(2);
	expect(seen.events.map((event) => event.kind)).toEqual(["log", "exit"]);
	expect(seen.events[0]!.lines).toEqual(["server READY on 8080"]);
	expect(seen.events[0]!.pattern).toBe("READY");
	const exit = seen.events[1]!;
	expect(exit.job.state).toBe("exited");
	expect(exit.job.exitCode).toBe(3);
	expect(exit.unmatched).toBeUndefined();
	expect(exit.lines.at(-1)).toBe("READY again");
	const text = describeWatchEvent(exit);
	expect(text).toContain("exited 3");
	expect(text).toContain(`command_output ${job.id} cursor ${exit.cursor}`);
});

test("a log watch whose pattern never matched reports the exit as unmatched", async () => {
	const start = await prepare();
	const job = start("echo compiling; echo failed");
	const seen = collector();
	registry!.watch(job.id, { log: "^done$", exit: false, repeat: false, cursor: 0 }, (event) =>
		seen.push(event),
	);
	await seen.until(1);
	expect(seen.events[0]!.kind).toBe("exit");
	expect(seen.events[0]!.unmatched).toBe(true);
	expect(describeWatchEvent(seen.events[0]!)).toContain("never matched");
});

test("an explicit stop reports nothing and a cancelled watch goes quiet", async () => {
	const start = await prepare();
	const stopped = start("sleep 30");
	const quiet = start("sleep 0.3; echo hit");
	const seen = collector();
	registry!.watch(stopped.id, { exit: true, repeat: false, cursor: 0 }, (event) => seen.push(event));
	const handle = registry!.watch(quiet.id, { log: "hit", exit: true, repeat: false, cursor: 0 }, (event) =>
		seen.push(event),
	);
	handle.cancel();
	await registry!.stop(stopped.id);
	await registry!.wait(quiet.id, 10_000);
	// One more poll interval for any stray event to have surfaced.
	await Bun.sleep(1_200);
	expect(seen.events).toEqual([]);
});

test("a watch saved before its owner crashed is re-armed by the host that recovers the job", async () => {
	directory = await mkdtemp(join(tmpdir(), "salam-watch-"));
	const home = join(directory, "home");
	const source = `
		import { join } from "node:path";
		import { ProcessRegistry } from ${JSON.stringify(new URL("../src/tools/processes.ts", import.meta.url).href)};
		import { ArtifactStore } from ${JSON.stringify(new URL("../src/tools/artifacts.ts", import.meta.url).href)};
		import { LocalExecutor } from ${JSON.stringify(new URL("../src/tools/exec.ts", import.meta.url).href)};
		const home = ${JSON.stringify(home)};
		const registry = new ProcessRegistry(new ArtifactStore(home), join(home, "processes"));
		const command = "echo started; sleep 1; echo 'build DONE'; sleep 0.3";
		const job = registry.start({executor:new LocalExecutor(${JSON.stringify(directory)}),argv:["/bin/sh","-c",command],command,cwd:${JSON.stringify(directory)},target:"this machine",sessionId:"s1",agentId:"main",timeoutMs:0});
		registry.saveWatch(job.id, { log: "DONE", exit: true, repeat: false, cursor: 0 });
		await registry.waitReady(job.id, { log: "started" }, 10000);
		console.log(job.id);
	`;
	const owner = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "inherit" });
	const reader = owner.stdout.getReader();
	let announced = "";
	while (!announced.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error("owner exited before starting the job");
		announced += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	owner.kill("SIGKILL");
	await owner.exited;
	const id = announced.trim();

	const environment = new ToolEnvironment(await loadConfig({ cwd: directory, home }));
	try {
		expect((await environment.processes.recover()).map((job) => job.id)).toContain(id);
		const seen = collector();
		environment.setWatchSink((event) => seen.push(event));
		await seen.until(2);
		expect(seen.events.map((event) => [event.job.id, event.kind])).toEqual([
			[id, "log"],
			[id, "exit"],
		]);
		expect(seen.events[0]!.lines).toEqual(["build DONE"]);
		// Reported and finished: nothing is left to re-arm.
		expect(environment.processes.savedWatches()).toEqual([]);
	} finally {
		await environment.close();
	}
}, 30_000);

test("a watch rejects an invalid pattern and an empty spec", async () => {
	const start = await prepare();
	const job = start("sleep 5");
	expect(() =>
		registry!.watch(job.id, { log: "(", exit: false, repeat: false, cursor: 0 }, () => {}),
	).toThrow(/Invalid watch regex/);
	expect(() => registry!.watch(job.id, { exit: false, repeat: false, cursor: 0 }, () => {})).toThrow(
		/log pattern and\/or exit/,
	);
});

const HOUR = 3_600_000;
function usage(limits: Array<{ id: string; windowId: string; hours: number; used: number; tier?: string }>) {
	return {
		provider: "anthropic",
		fetchedAt: 1,
		report: {
			provider: "anthropic",
			fetchedAt: 1,
			limits: limits.map((limit) => ({
				id: limit.id,
				label: limit.id,
				scope: {
					provider: "anthropic",
					windowId: limit.windowId,
					...(limit.tier ? { tier: limit.tier } : { shared: true }),
				},
				window: {
					id: limit.windowId,
					label: limit.windowId,
					durationMs: limit.hours * HOUR,
					resetsAt: 10 * HOUR,
				},
				amount: { usedFraction: limit.used, unit: "percent" },
			})),
		},
	} as unknown as ProviderUsage;
}

test("quotaView keeps the 5h/day/week windows binding the active model", () => {
	const report = usage([
		{ id: "anthropic:5h", windowId: "5h", hours: 5, used: 0.25 },
		{ id: "anthropic:7d", windowId: "7d", hours: 168, used: 0.4 },
		{ id: "anthropic:7d:opus", windowId: "7d", hours: 168, used: 0.9, tier: "opus" },
		{ id: "anthropic:7d:sonnet", windowId: "7d", hours: 168, used: 0.99, tier: "sonnet" },
		{ id: "anthropic:month", windowId: "30d", hours: 720, used: 0.5 },
	]);
	const opus = quotaView(report, "claude-opus-4-1")!;
	expect(opus.windows.map((window) => [window.label, Math.round(window.remaining * 100)])).toEqual([
		["5h", 75],
		["week", 10],
	]);
	const other = quotaView(report, "claude-haiku-4-5")!;
	expect(other.windows.map((window) => Math.round(window.remaining * 100))).toEqual([75, 60]);
	const devin = usage([
		{ id: "devin:quota:daily", windowId: "1d", hours: 24, used: 0.3 },
		{ id: "devin:quota:weekly", windowId: "7d", hours: 168, used: 0.1 },
	]);
	expect(quotaView(devin, "swe-1")!.windows.map((window) => window.label)).toEqual(["day", "week"]);
	expect(quotaView({ provider: "x", fetchedAt: 1, unavailable: "no" }, "m")).toBeUndefined();
});

test("the footer shows quota left with reset countdowns and drops them before the model", () => {
	const snapshot = {
		cwd: "",
		selection: { provider: "anthropic", model: "claude-opus" },
		reasoning: "high",
		contextTokens: 0,
		contextLimit: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		quota: {
			provider: "anthropic",
			fetchedAt: 0,
			windows: [
				{ label: "5h", remaining: 0.771, resetsAt: 2 * HOUR + 13 * 60_000 },
				{ label: "week", remaining: 0.08, resetsAt: 76 * HOUR },
			],
		},
	} as unknown as AppSnapshot;
	const plain = (width: number, now = 0) =>
		buildFooterText(snapshot, { width, home: "/", expanded: false, now })
			.chunks.map((chunk) => chunk.text)
			.join("");
	const wide = plain(200);
	expect(wide).toContain("5h left 77% (2h13m)");
	expect(wide).toContain("week left 8% (3d4h)");
	const narrow = plain(72);
	expect(narrow).toContain("anthropic/claude-opus");
	expect(narrow).toContain("5h left 77%");
	expect(narrow).not.toContain("(2h13m)");
	// The countdown follows the clock, and a window past its reset reads as full again.
	const later = plain(200, 3 * HOUR);
	expect(later).toContain("5h left 100%");
	expect(later).toContain("week left 8% (3d1h)");
});
