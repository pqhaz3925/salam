import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "../../contracts.ts";
import { readTextFile } from "../fs.ts";
import { sha256Hex, ToolFailure } from "../util.ts";
import { HARNESS_ROOT, type ToolEnvironment, type Workspace } from "../workspace.ts";
import { LspClient } from "./client.ts";

export interface ServerSpec {
	id: string;
	command: string;
	args: string[];
}

/** LSP language identifiers keyed by file extension. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascriptreact",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hh": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".m": "objective-c",
	".rb": "ruby",
	".php": "php",
	".lua": "lua",
	".sh": "shellscript",
	".bash": "shellscript",
	".zsh": "shellscript",
	".json": "json",
	".jsonc": "json",
	".css": "css",
	".scss": "scss",
	".less": "less",
	".html": "html",
	".htm": "html",
	".yaml": "yaml",
	".yml": "yaml",
	".zig": "zig",
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
	".svelte": "svelte",
	".vue": "vue",
	".tf": "terraform",
	".tfvars": "terraform",
	".ex": "elixir",
	".exs": "elixir",
	".ml": "ocaml",
	".mli": "ocaml",
	".hs": "haskell",
	".swift": "swift",
	".dart": "dart",
};

/**
 * Candidate servers per language, in preference order. The first one actually
 * installed on the execution site wins; nothing is bundled or auto-installed,
 * and a language with no server present produces an explicit message naming the
 * binaries that were looked for.
 */
const SERVERS_BY_LANGUAGE: Record<string, ServerSpec[]> = {
	typescript: [
		{ id: "typescript-language-server", command: "typescript-language-server", args: ["--stdio"] },
		{ id: "vtsls", command: "vtsls", args: ["--stdio"] },
	],
	python: [
		{ id: "pyright", command: "pyright-langserver", args: ["--stdio"] },
		{ id: "basedpyright", command: "basedpyright-langserver", args: ["--stdio"] },
		{ id: "pylsp", command: "pylsp", args: [] },
		{ id: "jedi-language-server", command: "jedi-language-server", args: [] },
	],
	go: [{ id: "gopls", command: "gopls", args: [] }],
	rust: [{ id: "rust-analyzer", command: "rust-analyzer", args: [] }],
	c: [{ id: "clangd", command: "clangd", args: ["--background-index"] }],
	ruby: [
		{ id: "ruby-lsp", command: "ruby-lsp", args: [] },
		{ id: "solargraph", command: "solargraph", args: ["stdio"] },
	],
	php: [
		{ id: "intelephense", command: "intelephense", args: ["--stdio"] },
		{ id: "phpactor", command: "phpactor", args: ["language-server"] },
	],
	lua: [{ id: "lua-language-server", command: "lua-language-server", args: [] }],
	shellscript: [{ id: "bash-language-server", command: "bash-language-server", args: ["start"] }],
	json: [{ id: "vscode-json-language-server", command: "vscode-json-language-server", args: ["--stdio"] }],
	css: [{ id: "vscode-css-language-server", command: "vscode-css-language-server", args: ["--stdio"] }],
	html: [{ id: "vscode-html-language-server", command: "vscode-html-language-server", args: ["--stdio"] }],
	yaml: [{ id: "yaml-language-server", command: "yaml-language-server", args: ["--stdio"] }],
	zig: [{ id: "zls", command: "zls", args: [] }],
	java: [{ id: "jdtls", command: "jdtls", args: [] }],
	kotlin: [{ id: "kotlin-language-server", command: "kotlin-language-server", args: [] }],
	svelte: [{ id: "svelteserver", command: "svelteserver", args: ["--stdio"] }],
	vue: [{ id: "vue-language-server", command: "vue-language-server", args: ["--stdio"] }],
	terraform: [{ id: "terraform-ls", command: "terraform-ls", args: ["serve"] }],
	elixir: [{ id: "elixir-ls", command: "elixir-ls", args: [] }],
	ocaml: [{ id: "ocamllsp", command: "ocamllsp", args: [] }],
	haskell: [{ id: "haskell-language-server", command: "haskell-language-server-wrapper", args: ["--lsp"] }],
	swift: [{ id: "sourcekit-lsp", command: "sourcekit-lsp", args: [] }],
	dart: [{ id: "dart", command: "dart", args: ["language-server", "--protocol=lsp"] }],
};

/** Languages that share another language's server and root markers. */
const LANGUAGE_ALIAS: Record<string, string> = {
	typescriptreact: "typescript",
	javascript: "typescript",
	javascriptreact: "typescript",
	cpp: "c",
	"objective-c": "c",
	scss: "css",
	less: "css",
};

const ROOT_MARKERS_BY_LANGUAGE: Record<string, string[]> = {
	typescript: ["tsconfig.json", "jsconfig.json", "package.json"],
	python: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
	go: ["go.mod", "go.work"],
	rust: ["Cargo.toml"],
	c: ["compile_commands.json", ".clangd", "CMakeLists.txt", "Makefile"],
	ruby: ["Gemfile", ".solargraph.yml"],
	php: ["composer.json"],
	lua: [".luarc.json", "stylua.toml"],
	java: ["pom.xml", "build.gradle", "build.gradle.kts"],
	kotlin: ["build.gradle.kts", "settings.gradle.kts"],
	svelte: ["svelte.config.js", "package.json"],
	vue: ["vue.config.js", "package.json"],
	terraform: [".terraform", "main.tf"],
	elixir: ["mix.exs"],
	haskell: ["stack.yaml", "cabal.project"],
	swift: ["Package.swift"],
	dart: ["pubspec.yaml"],
	zig: ["build.zig"],
};

const FALLBACK_MARKERS = [".git", ".hg", ".svn"];

/**
 * Ceiling for a document handed to a language server, and for a file rewritten
 * by a workspace edit. Anything larger is not something a semantic tool can
 * meaningfully work with, and holding it in memory twice is not free.
 */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export function pathToUri(path: string): string {
	return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function uriToPath(uri: string): string {
	if (!uri.startsWith("file://")) return uri;
	return fileURLToPath(uri);
}

/** The LSP language id for a path, or `undefined` when no server here speaks it. */
export function languageIdForPath(path: string): string | undefined {
	const dot = path.lastIndexOf(".");
	const extension = dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
	return LANGUAGE_BY_EXTENSION[extension];
}

export interface LspSession {
	client: LspClient;
	workspace: Workspace;
	root: string;
	serverId: string;
}

export interface OpenedDocument {
	session: LspSession;
	workspace: Workspace;
	path: string;
	uri: string;
	languageId: string;
	text: string;
}

/**
 * Per-scan memo for project-wide operations: one root lookup per directory and
 * one server lookup per language/root instead of one remote command per file.
 */
export interface ScanCache {
	roots: Map<string, Promise<string>>;
	servers: Map<string, Promise<{ spec: ServerSpec; binary: string } | undefined>>;
}

export interface OpenOptions {
	/** Re-verify other open buffers first (default). A scan does this once up front instead. */
	refresh?: boolean;
	cache?: ScanCache;
}

/**
 * Finds the nearest ancestor containing a project marker with one command
 * instead of one stat per level — on an SSH target that is the difference
 * between one round trip and a dozen.
 */
async function findRoot(
	workspace: Workspace,
	directory: string,
	markers: string[],
	signal: AbortSignal,
): Promise<string> {
	const script =
		'd=$1; shift; while [ -n "$d" ] && [ "$d" != "/" ]; do for m in "$@"; do if [ -e "$d/$m" ]; then printf %s "$d"; exit 0; fi; done; d=$(dirname "$d"); done; exit 1';
	const result = await workspace.executor.exec(["/bin/sh", "-c", script, "sh", directory, ...markers], {
		signal,
		timeoutMs: 30_000,
		cwd: directory,
	});
	const found = result.stdout.trim();
	return result.code === 0 && found.startsWith("/") ? found : directory;
}

export class LspManager {
	private readonly sessions = new Map<string, Promise<LspSession>>();
	private closed = false;

	constructor(private readonly environment: ToolEnvironment) {}

	private async locateServer(
		workspace: Workspace,
		root: string,
		spec: ServerSpec,
		signal: AbortSignal,
	): Promise<string | null> {
		if (!workspace.isRemote) {
			// A project's own pinned server outranks anything global.
			for (const directory of [
				join(root, "node_modules", ".bin"),
				join(HARNESS_ROOT, "node_modules", ".bin"),
			]) {
				const candidate = join(directory, spec.command);
				if (await Bun.file(candidate).exists()) return candidate;
			}
		}
		return workspace.executor.which(spec.command, signal);
	}

	private async typescriptInitOptions(workspace: Workspace, root: string): Promise<Record<string, unknown>> {
		const options: Record<string, unknown> = {
			hostInfo: "salam",
			preferences: { includeCompletionsForModuleExports: false },
		};
		if (workspace.isRemote) return options;
		for (const base of [root, HARNESS_ROOT]) {
			const tsserver = join(base, "node_modules", "typescript", "lib", "tsserver.js");
			if (await Bun.file(tsserver).exists()) {
				options.tsserver = { path: tsserver };
				return options;
			}
		}
		return options;
	}

	/** Starts or reuses the server responsible for an absolute path without opening it. */
	async session(
		context: ToolContext,
		path: string,
		cache?: ScanCache,
	): Promise<{ session: LspSession; workspace: Workspace; languageId: string }> {
		if (this.closed) throw new ToolFailure("The tool host has been closed.");
		const workspace = this.environment.workspace(context);
		const languageId = languageIdForPath(path);
		if (!languageId) {
			const dot = path.lastIndexOf(".");
			const extension = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
			throw new ToolFailure(`No language server is configured for "${extension || path}" files.`);
		}
		const family = LANGUAGE_ALIAS[languageId] ?? languageId;
		const specs = SERVERS_BY_LANGUAGE[family];
		if (!specs) throw new ToolFailure(`No language server is configured for ${languageId} files.`);

		const markers = [...(ROOT_MARKERS_BY_LANGUAGE[family] ?? []), ...FALLBACK_MARKERS];
		const directory = path.slice(0, path.lastIndexOf("/")) || "/";
		const rootKey = `${family}\0${directory}`;
		let rootLookup = cache?.roots.get(rootKey);
		if (!rootLookup) {
			rootLookup = findRoot(workspace, directory, markers, context.signal);
			cache?.roots.set(rootKey, rootLookup);
		}
		const root = await rootLookup;

		const serverKey = `${family}\0${root}`;
		let serverLookup = cache?.servers.get(serverKey);
		if (!serverLookup) {
			serverLookup = (async () => {
				for (const spec of specs) {
					const binary = await this.locateServer(workspace, root, spec, context.signal);
					if (binary) return { spec, binary };
				}
				return undefined;
			})();
			cache?.servers.set(serverKey, serverLookup);
		}
		const chosen = await serverLookup;
		if (!chosen) {
			const names = specs.map((spec) => `\`${spec.command}\``).join(", ");
			throw new ToolFailure(
				`No ${languageId} language server found on ${workspace.label}. Looked for ${names} in the project's node_modules/.bin and on PATH. Install one of them to use the lsp_* tools for this language.`,
			);
		}

		const key = `${workspace.id}|${chosen.spec.id}|${root}`;
		let pending = this.sessions.get(key);
		const existing = pending ? await pending.catch(() => undefined) : undefined;
		if (existing && !existing.client.alive) {
			this.sessions.delete(key);
			pending = undefined;
		}
		if (!pending) {
			pending = this.start(workspace, root, chosen.spec, chosen.binary, family, context).catch(
				(error: unknown) => {
					this.sessions.delete(key);
					throw error;
				},
			);
			this.sessions.set(key, pending);
		}
		return { session: await pending, workspace, languageId };
	}

	/** Reads the file, starts or reuses the right server, and syncs the document. */
	async open(context: ToolContext, inputPath: string, options: OpenOptions = {}): Promise<OpenedDocument> {
		if (this.closed) throw new ToolFailure("The tool host has been closed.");
		const workspace = this.environment.workspace(context);
		const path = workspace.resolvePath(context.cwd, inputPath);
		// A missing file must not start a server; scan-listed files skip the extra round trip.
		if (languageIdForPath(path) && !options.cache) {
			const stat = await workspace.fs.stat(path, { hash: false, signal: context.signal });
			if (stat.kind !== "file") throw new ToolFailure(`File not found: ${path}`);
		}
		const { session, languageId } = await this.session(context, path, options.cache);

		const uri = pathToUri(path);
		const [file] = await Promise.all([
			readTextFile(workspace.fs, path, MAX_DOCUMENT_BYTES, context.signal),
			options.refresh === false
				? undefined
				: this.refreshOpenDocuments(session, workspace, uri, context.signal),
		]);
		if (file.binary || file.truncated)
			throw new ToolFailure(`${path} is not fully readable text (8 MiB document limit).`);
		session.client.syncDocument(uri, languageId, file.text);
		await session.client.ensureSemanticReady(uri);
		return { session, workspace, path, uri, languageId, text: file.text };
	}

	/** Public form of the pre-request buffer verification, run once per project scan. */
	refresh(session: LspSession, signal: AbortSignal): Promise<void> {
		return this.refreshOpenDocuments(session, session.workspace, "", signal);
	}

	/**
	 * Brings the session's *other* open documents back in line with the workspace
	 * before a request goes out.
	 *
	 * An open buffer shadows the file underneath it, and files move for reasons
	 * this process never sees: the harness's own write and edit tools, a build, a
	 * checkout, the user's editor, another agent on the same SSH target. A query
	 * answered from a shadowed buffer is answered about text that no longer
	 * exists, which is how a rename comes back having missed the usages it should
	 * have rewritten.
	 *
	 * The check is one digest stat per open document, in parallel, and the file
	 * is only read — or sent — when the digest actually moved, so an unchanged
	 * document costs no transfer even on an SSH target. A document that is gone
	 * or unreadable is closed rather than left shadowing.
	 */
	private async refreshOpenDocuments(
		session: LspSession,
		workspace: Workspace,
		skipUri: string,
		signal: AbortSignal,
	): Promise<void> {
		const documents = session.client.openDocuments();
		if (documents.length === 0) return;
		await Promise.all(
			documents.map(async (document) => {
				if (uriToPath(document.uri) === uriToPath(skipUri)) return;
				const path = uriToPath(document.uri);
				try {
					const stat = await workspace.fs.stat(path, { signal });
					if (stat.kind !== "file") {
						session.client.closeDocument(document.uri);
						return;
					}
					if (stat.hash ? stat.hash === document.hash : stat.size === document.size) return;
					const file = await readTextFile(workspace.fs, path, MAX_DOCUMENT_BYTES, signal);
					if (file.binary || file.truncated) {
						session.client.closeDocument(document.uri);
						return;
					}
					// Bytes on disk can differ from decoded text — a stripped BOM, a file
					// past the ceiling — so re-send only on a real change.
					if (sha256Hex(file.text) === document.hash) return;
					session.client.syncDocument(document.uri, document.languageId, file.text);
				} catch {
					// Unreadable for any reason: hand the file back to the server rather
					// than let a buffer we can no longer verify answer questions.
					session.client.closeDocument(document.uri);
				}
			}),
		);
	}

	private async start(
		workspace: Workspace,
		root: string,
		spec: ServerSpec,
		binary: string,
		family: string,
		context: ToolContext,
	): Promise<LspSession> {
		context.emit(`starting ${spec.id} in ${root}\n`);
		const child = workspace.executor.startProcess([binary, ...spec.args], { cwd: root });
		const client = new LspClient(child, spec.id);
		const initializationOptions =
			family === "typescript" ? await this.typescriptInitOptions(workspace, root) : undefined;
		await client.initialize(pathToUri(root), root, initializationOptions);
		const encoding = client.capabilities.positionEncoding;
		if (typeof encoding === "string" && encoding !== "utf-16") {
			await client.dispose();
			throw new ToolFailure(`${spec.id} negotiated ${encoding} positions, which this client does not speak.`);
		}
		return { client, workspace, root, serverId: spec.id };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const pending = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(
			pending.map(async (entry) => {
				const session = await entry.catch(() => undefined);
				await session?.client.dispose().catch(() => undefined);
			}),
		);
	}
}
