import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SalamConfig } from "../src/contracts.ts";
import { InstructionLoader } from "../src/integrations/instructions.ts";
import type { McpHub } from "../src/integrations/mcp.ts";

const hub = { serverInstructions: () => [] } as unknown as McpHub;

function byScope(entries: string[], scope: string): string[] {
	return entries.filter((entry) => entry.includes(` scope="${scope}">`));
}

async function fixture(run: (paths: Record<string, string>) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "salam-instructions-")));
	try {
		const home = join(root, "home");
		const paths = {
			root,
			home,
			salamHome: join(home, ".salam"),
			dotfiles: join(root, "dotfiles", "claude"),
			repo: join(root, "repo"),
			loose: join(root, "loose"),
			artifacts: join(home, ".salam", "artifacts", "playwright"),
		};
		await mkdir(join(paths.dotfiles, "rules"), { recursive: true });
		await mkdir(paths.artifacts, { recursive: true });
		await mkdir(paths.loose, { recursive: true });
		await mkdir(join(paths.repo, ".git"), { recursive: true });
		await mkdir(join(paths.repo, "sub"), { recursive: true });
		// ~/.claude is a symlink; its relative import resolves through it.
		await symlink(paths.dotfiles, join(home, ".claude"));
		await writeFile(
			join(paths.dotfiles, "CLAUDE.md"),
			`User rules\n@rules/style.md\n@${join(paths.repo, "shared.md")}\n`,
		);
		await writeFile(join(paths.dotfiles, "rules", "style.md"), "Prefer tabs\n");
		await writeFile(join(paths.repo, "shared.md"), "Shared project notes\n");
		await writeFile(join(paths.repo, "CLAUDE.md"), "Project rules\n");
		await writeFile(join(paths.repo, "sub", "CLAUDE.md"), "Sub rules\n");
		await run(paths);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("unchanged user instructions keep the startup project's rendering from any directory", async () => {
	await fixture(async ({ home, salamHome, repo, artifacts, dotfiles }) => {
		const loader = new InstructionLoader({ home: salamHome, cwd: repo } as SalamConfig, hub, home);
		const fromRepo = await loader.load(repo);
		const fromArtifacts = await loader.load(artifacts);

		const userFile = join(home, ".claude", "CLAUDE.md");
		const style = join(home, ".claude", "rules", "style.md");
		const user = byScope(fromRepo, "user");
		// The user file's import into the startup project is still expanded.
		expect(user).toEqual([
			`<instructions source="${userFile}" scope="user">\nUser rules\n<!-- imported from ${style} -->\nPrefer tabs\n<!-- end ${style} -->\n<!-- imported from shared.md -->\nShared project notes\n<!-- end shared.md -->\n</instructions>`,
		]);
		expect(byScope(fromArtifacts, "user")).toEqual(user);
		// The runtime's exact-string fresh check sees nothing new outside the checkout.
		expect(fromArtifacts.filter((entry) => !fromRepo.includes(entry))).toEqual([]);

		// A genuinely new scoped instruction beside the artifact is still fresh.
		await writeFile(join(salamHome, "artifacts", "CLAUDE.md"), "Artifact rules\n");
		const fresh = (await loader.load(artifacts)).filter((entry) => !fromRepo.includes(entry));
		expect(fresh).toHaveLength(1);
		expect(fresh[0]).toContain('scope="directory"');
		expect(fresh[0]).toContain("Artifact rules");

		// Nested project guidance stays distinguishable from the session's instructions.
		const fromSub = await loader.load(join(repo, "sub"));
		expect(fromSub.filter((entry) => !fromRepo.includes(entry))).toEqual([
			'<instructions source="sub/CLAUDE.md" scope="directory">\nSub rules\n</instructions>',
		]);

		// Changing an imported user file changes the rendered user instructions.
		await writeFile(join(dotfiles, "rules", "style.md"), "Prefer spaces, never tabs\n");
		const changed = byScope(await loader.load(artifacts), "user");
		expect(changed).toHaveLength(1);
		expect(fromRepo.includes(changed[0] ?? "")).toBe(false);
		expect(changed[0]).toContain("Prefer spaces, never tabs");
	});
});

test("a session started outside git keeps its filesystem-root user wrapper from the user home", async () => {
	await fixture(async ({ home, salamHome, repo, loose, artifacts }) => {
		const loader = new InstructionLoader({ home: salamHome, cwd: loose } as SalamConfig, hub, home);
		const userFile = join(home, ".claude", "CLAUDE.md");
		const style = join(home, ".claude", "rules", "style.md");
		// The wrapper an unrooted startup has always produced: labels relative to `/`,
		// imports scoped to the working directory itself.
		const startup = `<instructions source="${userFile.slice(1)}" scope="user">\nUser rules\n<!-- imported from ${style.slice(1)} -->\nPrefer tabs\n<!-- end ${style.slice(1)} -->\n<!-- @${join(repo, "shared.md")} not expanded: outside the instruction scope -->\n</instructions>`;
		expect(byScope(await loader.load(loose), "user")).toEqual([startup]);
		expect(byScope(await loader.load(artifacts), "user")).toEqual([startup]);
	});
});
