import { afterEach, expect, jest, test } from "bun:test";
import { parseLoopInput, TaskLoops } from "../src/runtime/loops.ts";

/** Lets the scheduler's own awaits settle without touching the (faked) clock. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
	jest.useRealTimers();
});

test("a busy session defers due loops without stacking or overlapping them", async () => {
	jest.useFakeTimers();
	const started: string[] = [];
	const release: (() => void)[] = [];
	let inFlight = 0;
	let peak = 0;
	let busy = true;
	const loops = new TaskLoops(
		(loop, signal) => {
			started.push(loop.id);
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			const { promise, resolve } = Promise.withResolvers<void>();
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				inFlight -= 1;
				resolve();
			};
			release.push(finish);
			signal.addEventListener("abort", finish, { once: true });
			return promise;
		},
		() => !busy,
	);
	try {
		const alpha = loops.start("alpha", 1_000);
		const beta = loops.start("beta", 1_000);

		// Three intervals go by with the session busy the whole time.
		jest.advanceTimersByTime(3_000);
		await flush();
		expect(started).toEqual([]);

		// Freed: exactly one catch-up run, never one per missed tick.
		busy = false;
		jest.advanceTimersByTime(250);
		await flush();
		expect(started).toEqual([alpha.id]);

		// The second loop is overdue too, but it waits out the first run.
		jest.advanceTimersByTime(10_000);
		await flush();
		expect(started).toEqual([alpha.id]);
		expect(peak).toBe(1);

		const finishedAt = Date.now();
		release[0]();
		await flush();
		// The next attempt is a full interval from the finish: no backfill.
		expect(loops.list().find((loop) => loop.id === alpha.id)?.nextRunAt).toBe(finishedAt + 1_000);

		jest.advanceTimersByTime(1);
		await flush();
		expect(started).toEqual([alpha.id, beta.id]);
		expect(peak).toBe(1);
	} finally {
		await loops.close();
	}
});

test("a failed run reports itself and keeps the ordinary cadence", async () => {
	jest.useFakeTimers();
	let attempts = 0;
	const loops = new TaskLoops(
		async () => {
			attempts += 1;
			throw new Error("prompt blew up");
		},
		() => true,
	);
	try {
		loops.start("flaky", 1_000);
		jest.advanceTimersByTime(1_000);
		await flush();
		const failedAt = Date.now();
		const [loop] = loops.list();
		expect(attempts).toBe(1);
		expect(loop.lastError).toBe("prompt blew up");
		expect(loop.running).toBe(false);
		// A full interval, not a fast retry.
		expect(loop.nextRunAt).toBe(failedAt + 1_000);

		jest.advanceTimersByTime(999);
		await flush();
		expect(attempts).toBe(1);
		jest.advanceTimersByTime(1);
		await flush();
		expect(attempts).toBe(2);
	} finally {
		await loops.close();
	}
});

test("stop and close abort the run in flight and leave no timer behind", async () => {
	jest.useFakeTimers();
	let runs = 0;
	let aborted = 0;
	const loops = new TaskLoops(
		(_loop, signal) => {
			runs += 1;
			const { promise, resolve } = Promise.withResolvers<void>();
			signal.addEventListener(
				"abort",
				() => {
					aborted += 1;
					resolve();
				},
				{ once: true },
			);
			return promise;
		},
		() => true,
	);
	try {
		const watch = loops.start("watch", 1_000);
		// Snapshots are copies: scribbling on one must not reach the engine.
		const [snapshot] = loops.list();
		snapshot.prompt = "hijacked";
		snapshot.nextRunAt = 0;
		expect(loops.list()[0].prompt).toBe("watch");

		jest.advanceTimersByTime(1_000);
		await flush();
		expect(runs).toBe(1);
		expect(loops.list()[0].running).toBe(true);

		// Resolves only because the abort released the run.
		await loops.stop(watch.id);
		expect(aborted).toBe(1);
		expect(loops.list()).toEqual([]);
		await expect(loops.stop(watch.id)).rejects.toThrow();

		jest.advanceTimersByTime(60_000);
		await flush();
		expect(runs).toBe(1);
		expect(jest.getTimerCount()).toBe(0);

		loops.start("second", 1_000);
		jest.advanceTimersByTime(1_000);
		await flush();
		expect(runs).toBe(2);

		await loops.close();
		expect(aborted).toBe(2);
		expect(loops.list()).toEqual([]);
		expect(jest.getTimerCount()).toBe(0);
		expect(() => loops.start("after close", 1_000)).toThrow();

		jest.advanceTimersByTime(60_000);
		await flush();
		expect(runs).toBe(2);
	} finally {
		await loops.close();
	}
});

test("loop input parsing covers the default, the unit boundaries and malformed intervals", async () => {
	expect(parseLoopInput("  check the build  ")).toEqual({ intervalMs: 600_000, prompt: "check the build" });
	expect(parseLoopInput("30s  run tests")).toEqual({ intervalMs: 30_000, prompt: "run tests" });
	expect(parseLoopInput("2h ship it")).toEqual({ intervalMs: 7_200_000, prompt: "ship it" });
	expect(parseLoopInput("1s go")).toEqual({ intervalMs: 1_000, prompt: "go" });
	expect(parseLoopInput("24d go")).toEqual({ intervalMs: 2_073_600_000, prompt: "go" });
	expect(parseLoopInput("1.5m go")).toEqual({ intervalMs: 90_000, prompt: "go" });

	expect(() => parseLoopInput("   ")).toThrow();
	expect(() => parseLoopInput("5m")).toThrow();
	// Interval-shaped leading tokens are rejected, never demoted to prompt text.
	expect(() => parseLoopInput("5x do it")).toThrow();
	expect(() => parseLoopInput("500ms do it")).toThrow();
	expect(() => parseLoopInput("90 do it")).toThrow();
	expect(() => parseLoopInput("0.5s do it")).toThrow();
	expect(() => parseLoopInput("-1m do it")).toThrow();
	expect(() => parseLoopInput("30d do it")).toThrow();

	const loops = new TaskLoops(
		async () => {},
		() => true,
	);
	expect(() => loops.start("   ", 60_000)).toThrow();
	expect(() => loops.start("go", 999)).toThrow();
	expect(() => loops.start("go", 1_500.5)).toThrow();
	expect(() => loops.start("go", 2_147_483_648)).toThrow();
	await loops.close();
});
