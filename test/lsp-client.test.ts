import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { expect, test } from "bun:test";
import { LspClient } from "../src/tools/lsp/client.ts";
import { pathToUri } from "../src/tools/lsp/manager.ts";

test("differently escaped diagnostic URIs wake readers and still reject stale document versions", async () => {
	const child = new ChildProcess(),
		stdout = new PassThrough(),
		stdin = new PassThrough(),
		stderr = new PassThrough();
	Object.defineProperties(child, {
		stdout: { value: stdout },
		stdin: { value: stdin },
		stderr: { value: stderr },
	});
	const client = new LspClient(child, "fixture");
	const path = "/project/app/(auth)/page !'*%#é.ts",
		uri = pathToUri(path);
	const encoded = uri.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	const diagnostics = [
		{
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
			message: "current diagnostic",
			severity: 1,
		},
	];
	const publish = (version: number) => {
		const body = JSON.stringify({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri: encoded, version, diagnostics },
		});
		stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	};
	try {
		client.syncDocument(uri, "typescript", "const first = 1;\n");
		publish(1);
		expect(client.diagnosticsFor(uri)).toEqual(diagnostics);
		expect(client.readiness(uri).diagnosticsReceived).toBe(true);
		client.syncDocument(encoded, "typescript", "const second = 2;\n");
		publish(1);
		expect(client.hasDiagnostics(uri)).toBe(false);
		const waiting = client.awaitDiagnostics(uri, 1000);
		publish(2);
		expect(await waiting).toEqual(diagnostics);
		client.closeDocument(encoded);
		expect(client.openDocuments()).toEqual([]);
		expect(client.hasDiagnostics(uri)).toBe(false);
	} finally {
		stdout.destroy();
		stdin.destroy();
		stderr.destroy();
	}
});

/** A scripted server: answers each client request from `handlers` and records its params. */
function scriptedServer(handlers: Record<string, (params: unknown) => unknown>) {
	const child = new ChildProcess(),
		stdout = new PassThrough(),
		stdin = new PassThrough(),
		stderr = new PassThrough();
	Object.defineProperties(child, {
		stdout: { value: stdout },
		stdin: { value: stdin },
		stderr: { value: stderr },
	});
	const received: { method: string; params: unknown }[] = [];
	let buffer = Buffer.alloc(0);
	stdin.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())![1]);
			if (buffer.length < headerEnd + 4 + length) return;
			const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
			buffer = buffer.subarray(headerEnd + 4 + length);
			const handler = handlers[message.method];
			if (message.id === undefined || !handler) continue;
			received.push({ method: message.method, params: message.params });
			const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handler(message.params) });
			stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		}
	});
	return {
		client: new LspClient(child, "fixture"),
		received,
		close() {
			stdout.destroy();
			stdin.destroy();
			stderr.destroy();
		},
	};
}

const RANGE = { start: { line: 3, character: 16 }, end: { line: 3, character: 22 } };

test("call hierarchy round-trips opaque server item data and keeps only well-formed callers/callees", async () => {
	const prepared = {
		name: "middle",
		kind: 12,
		uri: "file:///project/calls.ts",
		range: RANGE,
		selectionRange: RANGE,
		data: { token: [7, { nested: "server-private" }], version: 3 },
	};
	const caller = { ...prepared, name: "top", data: { other: true } };
	const server = scriptedServer({
		"textDocument/prepareCallHierarchy": () => [prepared],
		"callHierarchy/incomingCalls": () => [
			{ from: caller, fromRanges: [RANGE] },
			{ from: { name: "broken" } },
		],
		"callHierarchy/outgoingCalls": () => [{ to: caller }],
	});
	try {
		server.client.capabilities = { callHierarchyProvider: true };
		const [item] = await server.client.prepareCallHierarchy(prepared.uri, { line: 3, character: 17 });
		expect(await server.client.callHierarchyCalls(item!, "incoming")).toEqual([
			{ item: caller, fromRanges: [RANGE] },
		]);
		expect(await server.client.callHierarchyCalls(item!, "outgoing")).toEqual([
			{ item: caller, fromRanges: [] },
		]);
		const sent = server.received.filter((entry) => entry.method.startsWith("callHierarchy/"));
		expect(sent.map((entry) => entry.params)).toEqual([{ item: prepared }, { item: prepared }]);

		server.client.capabilities = {};
		await expect(server.client.prepareCallHierarchy(prepared.uri, { line: 0, character: 0 })).rejects.toThrow(
			"does not advertise call hierarchy",
		);
	} finally {
		server.close();
	}
});

test("native workspace diagnostics count only full, current reports", async () => {
	const current = "/project/current.ts",
		stale = "/project/stale.ts",
		closed = "/project/closed.ts",
		unchanged = "/project/unchanged.ts";
	const diagnostic = { range: RANGE, message: "boom", severity: 1 };
	const server = scriptedServer({
		"workspace/diagnostic": () => ({
			items: [
				{ uri: pathToUri(current), kind: "full", version: 1, items: [diagnostic] },
				{ uri: pathToUri(stale), kind: "full", version: 1, items: [] },
				{ uri: pathToUri(closed), kind: "full", version: null, items: [diagnostic] },
				{ uri: pathToUri(unchanged), kind: "unchanged", resultId: "r1" },
			],
		}),
	});
	try {
		server.client.capabilities = { diagnosticProvider: { workspaceDiagnostics: false } };
		expect(server.client.supportsWorkspaceDiagnostics).toBe(false);
		await expect(server.client.workspaceDiagnostics(1000)).rejects.toThrow(
			"does not advertise workspace diagnostics",
		);

		server.client.capabilities = { diagnosticProvider: { workspaceDiagnostics: true, identifier: "fx" } };
		server.client.syncDocument(pathToUri(current), "typescript", "a");
		server.client.syncDocument(pathToUri(stale), "typescript", "b");
		server.client.syncDocument(pathToUri(stale), "typescript", "b2");
		const reports = await server.client.workspaceDiagnostics(1000);
		expect([...reports.keys()].sort()).toEqual([closed, current]);
		expect(reports.get(current)).toEqual([diagnostic]);
		expect(server.received.at(-1)).toEqual({
			method: "workspace/diagnostic",
			params: { previousResultIds: [], identifier: "fx" },
		});
	} finally {
		server.close();
	}
});
