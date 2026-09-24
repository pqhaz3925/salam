import { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "bun:test";
import { DapClient } from "../src/tools/dap-client.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "salam-dap-state-"));
	const child = new ChildProcess();
	const stdout = new PassThrough(),
		stdin = new PassThrough(),
		stderr = new PassThrough();
	Object.defineProperties(child, {
		stdout: { value: stdout },
		stdin: { value: stdin },
		stderr: { value: stderr },
	});
	const client = new DapClient(
		{ child, terminate: async () => true },
		"artifact://fixture",
		join(root, "events"),
	);
	return {
		client,
		child,
		publish(event: string, body?: unknown) {
			const packet = JSON.stringify({ type: "event", event, body });
			stdout.write(`Content-Length: ${Buffer.byteLength(packet)}\r\n\r\n${packet}`);
		},
		async close() {
			await client.stop();
			stdout.destroy();
			stdin.destroy();
			stderr.destroy();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("terminated session state persists across cursors while the adapter remains connected", async () => {
	const f = await fixture();
	try {
		f.publish("process", { name: "program" });
		expect(f.client.readEvents(0).sessionState).toBe("running");
		f.publish("stopped", { reason: "breakpoint", threadId: 1 });
		expect(f.client.readEvents(0).sessionState).toBe("stopped");
		f.publish("continued", { threadId: 1 });
		expect(f.client.readEvents(0).sessionState).toBe("running");
		f.publish("exited", { exitCode: 0 });
		expect(f.client.readEvents(0).sessionState).toBe("exited");
		f.publish("terminated");
		const end = f.client.readEvents(0);
		expect(end.sessionState).toBe("terminated");
		expect(end.adapterAlive).toBe(true);
		const next = f.client.readEvents(end.cursor);
		expect(next.events).toEqual([]);
		expect(next.sessionState).toBe("terminated");
		f.child.emit("close", 0, null);
		expect(f.client.readEvents(end.cursor).adapterAlive).toBe(false);
		expect(f.client.readEvents(end.cursor).sessionState).toBe("terminated");
	} finally {
		await f.close();
	}
});

test("adapter disconnection alone does not claim that the target terminated", async () => {
	const f = await fixture();
	try {
		f.publish("process", { name: "attached-target" });
		f.child.emit("close", 1, null);
		const state = f.client.readEvents(0);
		expect(state.adapterAlive).toBe(false);
		expect(state.sessionState).toBe("disconnected");
	} finally {
		await f.close();
	}
});
