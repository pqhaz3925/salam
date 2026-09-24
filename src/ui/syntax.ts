import { dirname } from "node:path";
import type { FiletypeParserOptions } from "@opentui/core";

/**
 * Tree-sitter grammars for fenced code beyond the JavaScript, TypeScript,
 * Markdown and Zig parsers OpenTUI bundles. Each official grammar package
 * ships its compiled `.wasm` and the highlight queries written for it.
 *
 * Paths are resolved through normal package resolution, so the same lookup
 * works from `src/` under `bin/salam` and from the `dist/` bundle built with
 * external packages. Queries a grammar inherits (C for C++, JavaScript for
 * TSX) are resolved from the inheriting package's own directory, so they
 * always match the grammar version it was generated against.
 */
interface Grammar {
	filetype: string;
	/** Fence info strings that OpenTUI does not already map to `filetype`. */
	aliases?: string[];
	package: string;
	wasm: string;
	/** Query files in highlight order; `from` names a dependency of `package`. */
	highlights: { path: string; from?: string }[];
}

const OWN_HIGHLIGHTS = [{ path: "queries/highlights.scm" }];

const GRAMMARS: readonly Grammar[] = [
	{
		filetype: "python",
		aliases: ["python3", "py3"],
		package: "tree-sitter-python",
		wasm: "tree-sitter-python.wasm",
		highlights: OWN_HIGHLIGHTS,
	},
	{
		filetype: "bash",
		aliases: ["shell", "shellscript", "sh", "zsh"],
		package: "tree-sitter-bash",
		wasm: "tree-sitter-bash.wasm",
		highlights: OWN_HIGHLIGHTS,
	},
	{
		filetype: "json",
		aliases: ["jsonc", "json5"],
		package: "tree-sitter-json",
		wasm: "tree-sitter-json.wasm",
		highlights: OWN_HIGHLIGHTS,
	},
	{
		filetype: "go",
		aliases: ["golang"],
		package: "tree-sitter-go",
		wasm: "tree-sitter-go.wasm",
		highlights: OWN_HIGHLIGHTS,
	},
	{
		filetype: "rust",
		package: "tree-sitter-rust",
		wasm: "tree-sitter-rust.wasm",
		highlights: OWN_HIGHLIGHTS,
	},
	{ filetype: "css", package: "tree-sitter-css", wasm: "tree-sitter-css.wasm", highlights: OWN_HIGHLIGHTS },
	{
		filetype: "html",
		package: "tree-sitter-html",
		wasm: "tree-sitter-html.wasm",
		highlights: OWN_HIGHLIGHTS,
	},
	{ filetype: "c", package: "tree-sitter-c", wasm: "tree-sitter-c.wasm", highlights: OWN_HIGHLIGHTS },
	{
		filetype: "cpp",
		package: "tree-sitter-cpp",
		wasm: "tree-sitter-cpp.wasm",
		highlights: [{ path: "queries/highlights.scm", from: "tree-sitter-c" }, ...OWN_HIGHLIGHTS],
	},
	{
		filetype: "java",
		package: "tree-sitter-java",
		wasm: "tree-sitter-java.wasm",
		highlights: OWN_HIGHLIGHTS,
	},
	{
		// Replaces OpenTUI's alias of TSX to the plain TypeScript grammar, which cannot parse JSX.
		filetype: "typescriptreact",
		package: "tree-sitter-typescript",
		wasm: "tree-sitter-tsx.wasm",
		highlights: [
			...OWN_HIGHLIGHTS,
			{ path: "queries/highlights-jsx.scm", from: "tree-sitter-javascript" },
			{ path: "queries/highlights.scm", from: "tree-sitter-javascript" },
		],
	},
	{
		filetype: "yaml",
		package: "@tree-sitter-grammars/tree-sitter-yaml",
		wasm: "tree-sitter-yaml.wasm",
		highlights: OWN_HIGHLIGHTS,
	},
	{
		filetype: "toml",
		package: "@tree-sitter-grammars/tree-sitter-toml",
		wasm: "tree-sitter-toml.wasm",
		highlights: OWN_HIGHLIGHTS,
	},
];

export interface SyntaxAssets {
	parsers: FiletypeParserOptions[];
	/** Absolute directories of every package an asset was read from, for license notices. */
	packages: string[];
	/** Grammars whose assets could not be resolved, with the resolution error. */
	missing: string[];
}

/** Resolves every grammar's wasm and highlight queries to absolute file paths. */
export function resolveSyntaxAssets(from: string = import.meta.dir): SyntaxAssets {
	const parsers: FiletypeParserOptions[] = [];
	const packages = new Set<string>();
	const missing: string[] = [];
	for (const grammar of GRAMMARS) {
		try {
			const root = dirname(Bun.resolveSync(`${grammar.package}/package.json`, from));
			const used = new Set([root]);
			const highlights = grammar.highlights.map((query) => {
				if (!query.from) return Bun.resolveSync(`./${query.path}`, root);
				used.add(dirname(Bun.resolveSync(`${query.from}/package.json`, root)));
				return Bun.resolveSync(`${query.from}/${query.path}`, root);
			});
			parsers.push({
				filetype: grammar.filetype,
				...(grammar.aliases ? { aliases: [...grammar.aliases] } : {}),
				wasm: Bun.resolveSync(`./${grammar.wasm}`, root),
				queries: { highlights },
			});
			for (const directory of used) packages.add(directory);
		} catch (error) {
			missing.push(`${grammar.filetype} (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	return { parsers, packages: [...packages], missing };
}
