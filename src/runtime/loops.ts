import { errorText, randomToken } from "../tools/util.ts";

/** Shortest cadence a loop may ask for: anything faster is a busy-wait, not a task. */
const MIN_INTERVAL_MS = 1_000;
/** Longest delay a real timer holds without wrapping around to "fire immediately". */
const MAX_INTERVAL_MS = 2_147_483_647;
/** Cadence for a bare prompt with no interval in front of it. */
const DEFAULT_INTERVAL_MS = 10 * 60_000;
/**
 * How often an overdue loop re-checks a busy session. The engine only wakes on
 * this cadence while a loop is already due and `canRun()` is refusing, so an
 * idle session keeps exactly one timer armed at the next due time.
 */
const BUSY_RECHECK_MS = 250;

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** One periodic prompt: what to run, how often, and how the last attempt went. */
export interface TaskLoop {
	id: string;
	prompt: string;
	intervalMs: number;
	/** Epoch ms of the next attempt; already in the past while a run waits for a free session. */
	nextRunAt: number;
	running: boolean;
	/** Epoch ms the most recent run started. */
	lastRunAt?: number;
	/** Why the most recent run failed. Cleared by the next run that succeeds. */
	lastError?: string;
}

/** The single run the engine allows at a time, plus the handle that cancels it. */
interface ActiveRun {
	id: string;
	controller: AbortController;
	/** Settles once the run has finished and released the engine. Never rejects. */
	done: Promise<void>;
}

/**
 * Periodic prompts for the running salam process.
 *
 * Deliberately small: one timer, one run at a time, no persistence. A loop's
 * first run is one interval away, two loops never run at once, and no loop runs
 * while `canRun()` is false. A loop that came due during a busy stretch runs
 * once when the session frees up — missed ticks are dropped, never replayed —
 * and a failed run waits a full interval like any other, so a broken prompt
 * cannot turn into a hidden fast retry.
 *
 * Loops live only in this process. Nothing here is written to the store, so a
 * restart starts with none.
 */
export class TaskLoops {
	private readonly loops = new Map<string, TaskLoop>();
	private timer: Timer | undefined;
	private active: ActiveRun | undefined;
	private closed = false;

	constructor(
		private readonly run: (loop: TaskLoop, signal: AbortSignal) => Promise<void>,
		private readonly canRun: () => boolean,
		private readonly onChange?: () => void,
	) {}

	/**
	 * Registers a loop whose first run is `intervalMs` away. Throws on an
	 * empty prompt or an interval a real timer cannot hold.
	 */
	start(prompt: string, intervalMs: number): TaskLoop {
		if (this.closed) throw new Error("Task loops are no longer running.");
		const text = prompt.trim();
		if (!text) throw new Error("A loop needs a prompt to run.");
		const interval = checkInterval(intervalMs, `${intervalMs}ms`);
		let id = randomToken(6);
		while (this.loops.has(id)) id = randomToken(6);
		const loop: TaskLoop = {
			id,
			prompt: text,
			intervalMs: interval,
			nextRunAt: Date.now() + interval,
			running: false,
		};
		this.loops.set(id, loop);
		this.changed();
		this.schedule();
		return { ...loop };
	}

	/** Copies, in creation order. Mutating one changes nothing the engine reads. */
	list(): TaskLoop[] {
		return [...this.loops.values()].map((loop) => ({ ...loop }));
	}

	/**
	 * Removes one loop and, if it is mid-run, aborts that run and waits for it
	 * to unwind. The loop is gone before the wait starts, so nothing reschedules
	 * it. Throws when `id` names no loop.
	 */
	async stop(id: string): Promise<void> {
		// Ids are lowercase tokens a user reads off `list` and types back, so the
		// engine matches them the way they are typed.
		const key = id.trim().toLowerCase();
		if (!this.loops.delete(key)) throw new Error(`No task loop \`${id.trim()}\`.`);
		this.changed();
		this.schedule();
		await this.cancel(key);
	}

	/** Removes every loop and waits out whichever one was running. */
	async clear(): Promise<void> {
		if (this.loops.size === 0 && !this.active) return;
		this.loops.clear();
		this.changed();
		this.schedule();
		await this.cancel();
	}

	/**
	 * Permanent shutdown: drops every loop, releases the timer and waits for an
	 * in-flight run to unwind. Silent by design — a teardown is no time to call
	 * back into a view that is also going away — and idempotent. `start` throws
	 * afterwards.
	 */
	async close(): Promise<void> {
		this.closed = true;
		this.loops.clear();
		this.disarm();
		await this.cancel();
	}

	/** Fires the earliest due loop, or re-arms when nothing may run yet. */
	private tick(): void {
		if (this.closed || this.active) return;
		const now = Date.now();
		let due: TaskLoop | undefined;
		for (const loop of this.loops.values()) {
			if (loop.nextRunAt <= now && (!due || loop.nextRunAt < due.nextRunAt)) due = loop;
		}
		if (!due) {
			this.schedule();
			return;
		}
		// Overdue but the session is busy: leave `nextRunAt` in the past and look
		// again shortly. One run happens when the session frees up, however many
		// intervals went by in the meantime. A gate that throws counts as busy —
		// an exception escaping a timer callback would take the process with it.
		let permitted = false;
		try {
			permitted = this.canRun();
		} catch {
			permitted = false;
		}
		if (!permitted) {
			this.arm(BUSY_RECHECK_MS);
			return;
		}
		this.begin(due);
	}

	private begin(loop: TaskLoop): void {
		const controller = new AbortController();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.active = { id: loop.id, controller, done: promise };
		loop.running = true;
		loop.lastRunAt = Date.now();
		this.changed();
		// `execute` swallows everything, but settle the waiter either way: a stop
		// that never returns would be far worse than a lost error.
		void this.execute(loop, controller.signal).then(
			() => resolve(),
			() => resolve(),
		);
	}

	private async execute(loop: TaskLoop, signal: AbortSignal): Promise<void> {
		let failure: string | undefined;
		try {
			await this.run({ ...loop }, signal);
		} catch (error) {
			// An abort is this engine cancelling the run, not the prompt failing.
			if (!signal.aborted) failure = errorText(error);
		}
		this.active = undefined;
		loop.running = false;
		// A loop removed mid-run stays removed: no rescheduling, no resurrection.
		if (this.loops.get(loop.id) === loop) {
			loop.lastError = failure;
			loop.nextRunAt = Date.now() + loop.intervalMs;
		}
		this.changed();
		this.schedule();
	}

	/** Arms the single timer at the earliest due time, or leaves it disarmed. */
	private schedule(): void {
		this.disarm();
		if (this.closed || this.active || this.loops.size === 0) return;
		let earliest = Number.POSITIVE_INFINITY;
		for (const loop of this.loops.values()) earliest = Math.min(earliest, loop.nextRunAt);
		this.arm(earliest - Date.now());
	}

	private arm(delay: number): void {
		this.disarm();
		// Clamped against a clock that jumped: a negative or out-of-range delay
		// would otherwise fire instantly and spin.
		const timer = setTimeout(
			() => {
				this.timer = undefined;
				this.tick();
			},
			Math.min(Math.max(delay, 0), MAX_INTERVAL_MS),
		);
		// A pending loop must not be the reason the process refuses to exit.
		timer.unref();
		this.timer = timer;
	}

	private disarm(): void {
		if (this.timer === undefined) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** Cancels the active run — optionally only when it belongs to `id` — and waits. */
	private cancel(id?: string): Promise<void> {
		const active = this.active;
		if (!active || (id !== undefined && active.id !== id)) return Promise.resolve();
		active.controller.abort();
		return active.done;
	}

	private changed(): void {
		try {
			this.onChange?.();
		} catch {
			// A failing listener must never take the scheduler down with it.
		}
	}
}

/**
 * Splits `[interval] prompt`. The leading token is read as an interval whenever
 * it starts with a number, so a malformed one (`5x`, `-1m`, `1.5.2m`) is an error
 * rather than the first word of a prompt that would then run every ten minutes.
 */
export function parseLoopInput(text: string): { intervalMs: number; prompt: string } {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("A loop needs a prompt, optionally prefixed with an interval like `5m`.");
	const gap = trimmed.search(/\s/);
	const head = gap === -1 ? trimmed : trimmed.slice(0, gap);
	if (!/^[+-]?(?:\d|\.\d)/.test(head)) return { intervalMs: DEFAULT_INTERVAL_MS, prompt: trimmed };
	const intervalMs = parseInterval(head);
	const prompt = gap === -1 ? "" : trimmed.slice(gap + 1).trim();
	if (!prompt) throw new Error("A loop needs a prompt after the interval.");
	return { intervalMs, prompt };
}

function parseInterval(token: string): number {
	const match = /^(\d+(?:\.\d+)?)([smhd])$/i.exec(token);
	if (!match)
		throw new Error(
			`\`${token}\` is not an interval. Use a number with s, m, h or d — for example 30s, 5m or 2h.`,
		);
	return checkInterval(Math.round(Number(match[1]) * UNITS[match[2].toLowerCase()]), token);
}

/** Shared gate so a parsed `5m` and a caller-supplied number fail the same way. */
function checkInterval(value: number, shown: string): number {
	if (!Number.isInteger(value))
		throw new Error(`Interval \`${shown}\` must be a whole number of milliseconds.`);
	if (value < MIN_INTERVAL_MS) throw new Error(`Interval \`${shown}\` is too short; 1s is the minimum.`);
	if (value > MAX_INTERVAL_MS) throw new Error(`Interval \`${shown}\` is too long; 24d is the maximum.`);
	return value;
}
