import type { IntegrationServices, SalamConfig } from "../contracts.ts";
import { InstructionLoader } from "./instructions.ts";
import { McpHub } from "./mcp.ts";
import { createMcpTools } from "./mcp-tools.ts";
import { SkillRegistry } from "./skills.ts";

const SKILL_LOAD_TIMEOUT = 60_000;

/**
 * Builds the integration layer: MCP servers (stdio and streamable HTTP) with their
 * tools, resources and prompts; the skill registry spanning project, user, declared
 * package and MCP sources; and the scoped CLAUDE.md instruction chain.
 *
 * Server connection failures never abort startup — they are recorded and reported
 * through `mcp_list` (kind: servers) / `mcp_call` (action: reconnect), so a configured server is never
 * silently dropped.
 */
export async function createIntegrations(config: SalamConfig): Promise<IntegrationServices> {
	const hub = await McpHub.create(config);
	const skills = new SkillRegistry(config, hub);
	const instructions = new InstructionLoader(config, hub);
	const tools = createMcpTools(hub);
	let shutdown: Promise<void> | null = null;

	return {
		tools,
		async instructions(cwd: string): Promise<string[]> {
			return instructions.load(cwd);
		},
		async skills(): Promise<{ name: string; description: string; source: string }[]> {
			const entries = await skills.list();
			return entries.map((entry) => ({
				name: entry.name,
				description: entry.description,
				source: entry.source,
			}));
		},
		async loadSkill(name: string): Promise<string> {
			return skills.load(name, AbortSignal.timeout(SKILL_LOAD_TIMEOUT));
		},
		async close(): Promise<void> {
			shutdown ??= hub.close();
			return shutdown;
		},
	};
}
