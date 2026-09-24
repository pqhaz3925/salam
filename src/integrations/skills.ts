import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SalamConfig } from "../contracts.ts";
import { convertMcpContent, convertResourceContents } from "./content.ts";
import {
	displayPath,
	firstParagraph,
	isDirectory,
	listDirectory,
	parseFrontmatter,
	readTextCached,
	realpathOr,
} from "./fsutil.ts";
import type { McpHub } from "./mcp.ts";

const HEAD_BYTES = 16 * 1024;
const BODY_BYTES = 512 * 1024;
const MAX_SKILLS_PER_ROOT = 200;
const MAX_GROUP_DEPTH = 2;
const MAX_BUNDLED = 64;
const MCP_CACHE_MS = 30_000;
const SKILL_FILES = ["SKILL.md", "skill.md"];
const PACKAGE_SKILL_DIRS = ["skills", ".claude/skills", ".salam/skills"];
const SKILL_PACKAGE_PATTERN = /^(@[^/]+\/)?salam-skills?(-|$)/;
const SKILL_PROMPT_PREFIX = /^skills?[:/._-]/i;
const SKILL_META_KEYS = ["skill", "salam/skill", "salam.skill", "io.modelcontextprotocol/skill"];

export type SkillOrigin = "project" | "user" | "package" | "mcp";

export interface FileSkillLocation {
	kind: "file";
	/** Absolute path to SKILL.md. */
	file: string;
	/** Skill directory holding SKILL.md and any bundled assets. */
	directory: string;
}

export interface McpSkillLocation {
	kind: "prompt" | "resource";
	server: string;
	/** Prompt name or resource URI. */
	id: string;
}

export interface SkillEntry {
	name: string;
	description: string;
	/** `<origin>:<location>` — unique and human-readable. */
	source: string;
	origin: SkillOrigin;
	location: FileSkillLocation | McpSkillLocation;
}

interface RootSpec {
	path: string;
	origin: SkillOrigin;
	label: string;
}

interface PackageManifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	salam?: { skills?: string[]; skillPackages?: string[] };
}

const ORIGIN_RANK: Record<SkillOrigin, number> = { project: 0, user: 1, package: 2, mcp: 3 };

function metaFlag(meta: Record<string, unknown> | undefined): boolean {
	if (!meta) return false;
	for (const key of SKILL_META_KEYS) {
		const value = meta[key];
		if (value === true || value === "true" || (typeof value === "object" && value !== null)) return true;
	}
	return false;
}

function normalizeName(raw: string): string {
	const trimmed = raw.trim().replace(/^skills?[:/._-]+/i, "");
	const cleaned = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned.toLowerCase() : "";
}

/**
 * Discovers skills from local project directories, user directories, explicitly
 * declared skill packages and skill-like MCP prompts/resources. Discovery only ever
 * reads file headers — bodies load on demand, and nothing is executed.
 */
export class SkillRegistry {
	private mcpCache: { at: number; entries: SkillEntry[] } | null = null;
	private packageRoots: RootSpec[] | null = null;

	constructor(
		private readonly config: SalamConfig,
		private readonly hub: McpHub,
	) {}

	async list(): Promise<SkillEntry[]> {
		const collected: SkillEntry[] = [];
		for (const root of await this.roots()) collected.push(...(await this.scanRoot(root)));
		collected.push(...(await this.mcpSkills()));

		const byName = new Map<string, SkillEntry>();
		for (const entry of collected) {
			const existing = byName.get(entry.name);
			if (!existing || ORIGIN_RANK[entry.origin] < ORIGIN_RANK[existing.origin])
				byName.set(entry.name, entry);
		}
		return [...byName.values()].sort((a, b) => {
			const rank = ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin];
			return rank !== 0 ? rank : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
		});
	}

	async load(name: string, signal: AbortSignal): Promise<string> {
		const wanted = name.trim();
		const entries = await this.list();
		const entry =
			entries.find((candidate) => candidate.name === wanted) ??
			entries.find((candidate) => candidate.name === normalizeName(wanted)) ??
			entries.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase()) ??
			entries.find((candidate) => candidate.source === wanted);
		if (!entry) {
			const available = entries.map((candidate) => candidate.name).join(", ") || "none";
			throw new Error(`Unknown skill '${name}'. Available skills: ${available}`);
		}
		if (entry.location.kind === "file")
			return this.loadFileSkill(entry, entry.location.file, entry.location.directory);
		return this.loadMcpSkill(entry, entry.location, signal);
	}

	private async loadFileSkill(entry: SkillEntry, file: string, directory: string): Promise<string> {
		const cached = await readTextCached(file, BODY_BYTES);
		if (!cached) throw new Error(`Skill '${entry.name}' is no longer readable at ${file}`);
		const frontmatter = parseFrontmatter(cached.text);
		const body = cached.text.slice(frontmatter.bodyOffset).trim();
		const bundled = await this.bundledFiles(directory);
		const parts = [`<skill name="${entry.name}" source="${entry.source}" dir="${directory}">`, body];
		if (cached.truncated) parts.push(`[skill body truncated at ${BODY_BYTES} bytes]`);
		if (bundled.length > 0) {
			parts.push("", `Bundled files (relative to ${directory}):`, ...bundled.map((path) => `- ${path}`));
		}
		parts.push("</skill>");
		return parts.join("\n");
	}

	private async loadMcpSkill(
		entry: SkillEntry,
		location: McpSkillLocation,
		signal: AbortSignal,
	): Promise<string> {
		if (location.kind === "prompt") {
			const prompt = await this.hub.getPrompt(location.server, location.id, {}, signal);
			const rendered = prompt.messages.map(
				(message) => `${message.role}: ${convertMcpContent([message.content]).text}`,
			);
			const description = prompt.description ? `${prompt.description}\n` : "";
			return `<skill name="${entry.name}" source="${entry.source}">\n${description}${rendered.join("\n\n")}\n</skill>`;
		}
		const contents = await this.hub.readResource(location.server, location.id, signal);
		const converted = convertResourceContents(contents);
		return `<skill name="${entry.name}" source="${entry.source}">\n${converted.text}\n</skill>`;
	}

	private async bundledFiles(directory: string): Promise<string[]> {
		const out: string[] = [];
		const queue: { path: string; prefix: string; depth: number }[] = [
			{ path: directory, prefix: "", depth: 0 },
		];
		const seen = new Set<string>();
		while (queue.length > 0 && out.length < MAX_BUNDLED) {
			const current = queue.shift();
			if (!current) break;
			const real = await realpathOr(current.path);
			if (seen.has(real)) continue;
			seen.add(real);
			for (const child of await listDirectory(current.path)) {
				if (out.length >= MAX_BUNDLED) break;
				const relative = current.prefix + child.name;
				if (child.directory) {
					if (current.depth + 1 < 3)
						queue.push({ path: child.path, prefix: `${relative}/`, depth: current.depth + 1 });
					continue;
				}
				if (current.depth === 0 && SKILL_FILES.includes(child.name)) continue;
				out.push(relative);
			}
		}
		return out;
	}

	private async roots(): Promise<RootSpec[]> {
		const home = homedir();
		const specs: RootSpec[] = [
			{ path: resolve(this.config.cwd, ".salam/skills"), origin: "project", label: ".salam/skills" },
			{ path: resolve(this.config.cwd, ".claude/skills"), origin: "project", label: ".claude/skills" },
			{ path: resolve(this.config.home, "skills"), origin: "user", label: "home/skills" },
			{ path: join(home, ".salam/skills"), origin: "user", label: "~/.salam/skills" },
			{ path: join(home, ".claude/skills"), origin: "user", label: "~/.claude/skills" },
		];
		specs.push(...(await this.declaredRoots()));
		const seen = new Set<string>();
		const unique: RootSpec[] = [];
		for (const spec of specs) {
			if (seen.has(spec.path)) continue;
			seen.add(spec.path);
			unique.push(spec);
		}
		return unique;
	}

	/**
	 * Package skills come from explicit declarations only: `salam.skills` /
	 * `salam.skillPackages` in the project manifest, plus dependencies named
	 * `salam-skill(s)-*`. node_modules is never scanned.
	 */
	private async declaredRoots(): Promise<RootSpec[]> {
		if (this.packageRoots) return this.packageRoots;
		const roots: RootSpec[] = [];
		const manifest = await this.readManifest(resolve(this.config.cwd, "package.json"));
		if (manifest) {
			for (const relative of manifest.salam?.skills ?? []) {
				if (typeof relative !== "string") continue;
				roots.push({ path: resolve(this.config.cwd, relative), origin: "project", label: relative });
			}
			const packages = new Set<string>();
			for (const name of manifest.salam?.skillPackages ?? [])
				if (typeof name === "string") packages.add(name);
			for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
				if (SKILL_PACKAGE_PATTERN.test(name)) packages.add(name);
			}
			for (const name of [...packages].sort()) {
				const directory = await this.resolvePackage(name);
				if (!directory) continue;
				const packageManifest = await this.readManifest(join(directory, "package.json"));
				const declared = packageManifest?.salam?.skills;
				const candidates = Array.isArray(declared) && declared.length > 0 ? declared : PACKAGE_SKILL_DIRS;
				for (const relative of candidates) {
					if (typeof relative !== "string") continue;
					roots.push({ path: resolve(directory, relative), origin: "package", label: `${name}/${relative}` });
				}
			}
		}
		this.packageRoots = roots;
		return roots;
	}

	private async readManifest(path: string): Promise<PackageManifest | null> {
		const cached = await readTextCached(path, 512 * 1024);
		if (!cached) return null;
		try {
			const parsed = JSON.parse(cached.text) as PackageManifest;
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	}

	private async resolvePackage(name: string): Promise<string | null> {
		let directory = resolve(this.config.cwd);
		for (let depth = 0; depth < 8; depth += 1) {
			const candidate = join(directory, "node_modules", name);
			if (await isDirectory(candidate)) return candidate;
			const parent = resolve(directory, "..");
			if (parent === directory) break;
			directory = parent;
		}
		return null;
	}

	private async scanRoot(root: RootSpec): Promise<SkillEntry[]> {
		if (!(await isDirectory(root.path))) return [];
		const entries: SkillEntry[] = [];
		const seen = new Set<string>();
		const queue: { path: string; depth: number }[] = [{ path: root.path, depth: 0 }];
		while (queue.length > 0 && entries.length < MAX_SKILLS_PER_ROOT) {
			const current = queue.shift();
			if (!current) break;
			const real = await realpathOr(current.path);
			if (seen.has(real)) continue; // symlink loop guard
			seen.add(real);
			for (const child of await listDirectory(current.path)) {
				if (!child.directory) continue;
				const skill = await this.readSkillHead(child.path, root);
				if (skill) {
					entries.push(skill);
					if (entries.length >= MAX_SKILLS_PER_ROOT) break;
					continue;
				}
				if (current.depth + 1 < MAX_GROUP_DEPTH) queue.push({ path: child.path, depth: current.depth + 1 });
			}
		}
		return entries;
	}

	private async readSkillHead(directory: string, root: RootSpec): Promise<SkillEntry | null> {
		for (const candidate of SKILL_FILES) {
			const file = join(directory, candidate);
			const head = await readTextCached(file, HEAD_BYTES);
			if (!head) continue;
			const frontmatter = parseFrontmatter(head.text);
			const declared = frontmatter.fields.get("name") ?? "";
			const fallback = directory.slice(directory.lastIndexOf("/") + 1);
			const name = normalizeName(declared) || normalizeName(fallback);
			if (name.length === 0) continue;
			const description =
				frontmatter.fields.get("description") ?? firstParagraph(head.text.slice(frontmatter.bodyOffset));
			return {
				name,
				description,
				source: `${root.origin}:${displayPath(file, this.config.cwd)}`,
				origin: root.origin,
				location: { kind: "file", file, directory },
			};
		}
		return null;
	}

	private async mcpSkills(): Promise<SkillEntry[]> {
		const now = Date.now();
		if (this.mcpCache && now - this.mcpCache.at < MCP_CACHE_MS) return this.mcpCache.entries;
		const entries: SkillEntry[] = [];
		const prompts = await this.hub.listPrompts().catch(() => ({ entries: [], failures: [] }));
		for (const prompt of prompts.entries) {
			const explicit =
				metaFlag(prompt.meta) ||
				SKILL_PROMPT_PREFIX.test(prompt.name) ||
				/^skill:/i.test(prompt.description ?? "");
			if (!explicit) continue;
			if (prompt.arguments.some((argument) => argument.required)) continue; // needs input: not a loadable skill
			const name = normalizeName(prompt.name);
			if (name.length === 0) continue;
			entries.push({
				name,
				description: prompt.description ?? `Prompt '${prompt.name}' from MCP server '${prompt.server}'.`,
				source: `mcp:${prompt.server}/prompt:${prompt.name}`,
				origin: "mcp",
				location: { kind: "prompt", server: prompt.server, id: prompt.name },
			});
		}
		const resources = await this.hub.listResources().catch(() => ({ entries: [], failures: [] }));
		for (const resource of resources.entries) {
			if (resource.template) continue;
			const explicit =
				resource.uri.startsWith("skill://") ||
				metaFlag(resource.meta) ||
				(resource.uri.includes("/skills/") && /(^|\/)SKILL\.md$|\.skill\.md$/i.test(resource.uri));
			if (!explicit) continue;
			const label = resource.name || resource.uri.replace(/^skill:\/\//, "").replace(/\/SKILL\.md$/i, "");
			const name = normalizeName(label.slice(label.lastIndexOf("/") + 1));
			if (name.length === 0) continue;
			entries.push({
				name,
				description:
					resource.description ?? `Resource '${resource.uri}' from MCP server '${resource.server}'.`,
				source: `mcp:${resource.server}/resource:${resource.uri}`,
				origin: "mcp",
				location: { kind: "resource", server: resource.server, id: resource.uri },
			});
		}
		this.mcpCache = { at: now, entries };
		return entries;
	}
}
