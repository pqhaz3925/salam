import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { McpHub } from "../src/integrations/mcp.ts";
import { createMcpTools } from "../src/integrations/mcp-tools.ts";

test("MCP server discovery lists an empty registry but rejects an unknown named server", async () => {
	const root = await mkdtemp(join(tmpdir(), "salam-mcp-status-"));
	const config = await loadConfig({ cwd: root, home: root });
	const hub = await McpHub.create(config);
	try {
		const status = createMcpTools(hub).find((tool) => tool.name === "mcp_list");
		if (!status) throw new Error("MCP discovery tool is unavailable");
		const context = {
			cwd: root,
			sessionId: "fixture",
			agentId: "main",
			signal: AbortSignal.timeout(10000),
			emit: () => {},
		};
		expect((await status.execute({ kind: "servers" }, context)).isError).not.toBe(true);
		expect((await status.execute({ kind: "servers", server: "missing" }, context)).isError).toBe(true);
	} finally {
		await hub.close();
		await rm(root, { recursive: true, force: true });
	}
});
