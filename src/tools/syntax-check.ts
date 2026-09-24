import { dirname, extname } from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";

/**
 * After-the-fact syntax check for files a shell command rewrote. A `python -c` replace
 * with a mis-escaped `\n`, or a heredoc whose backticks broke a template literal, writes
 * broken code silently; this parses the result with the bundled tree-sitter grammars so
 * the command's own result says so, instead of a compiler run much later.
 *
 * Only errors the command introduced are reported: a grammar may lag the language, so a
 * file that already failed to parse the same way before is not flagged.
 */

/** Grammar wasm by extension, as `package/file.wasm`. */
const GRAMMARS: Record<string, string> = {
	".ts": "tree-sitter-typescript/tree-sitter-typescript.wasm",
	".mts": "tree-sitter-typescript/tree-sitter-typescript.wasm",
	".cts": "tree-sitter-typescript/tree-sitter-typescript.wasm",
	".tsx": "tree-sitter-typescript/tree-sitter-tsx.wasm",
	".js": "tree-sitter-javascript/tree-sitter-javascript.wasm",
	".mjs": "tree-sitter-javascript/tree-sitter-javascript.wasm",
	".cjs": "tree-sitter-javascript/tree-sitter-javascript.wasm",
	".jsx": "tree-sitter-javascript/tree-sitter-javascript.wasm",
	".py": "tree-sitter-python/tree-sitter-python.wasm",
	".json": "tree-sitter-json/tree-sitter-json.wasm",
	".sh": "tree-sitter-bash/tree-sitter-bash.wasm",
	".bash": "tree-sitter-bash/tree-sitter-bash.wasm",
	".go": "tree-sitter-go/tree-sitter-go.wasm",
	".rs": "tree-sitter-rust/tree-sitter-rust.wasm",
	".c": "tree-sitter-c/tree-sitter-c.wasm",
	".h": "tree-sitter-c/tree-sitter-c.wasm",
	".cc": "tree-sitter-cpp/tree-sitter-cpp.wasm",
	".cpp": "tree-sitter-cpp/tree-sitter-cpp.wasm",
	".hpp": "tree-sitter-cpp/tree-sitter-cpp.wasm",
	".java": "tree-sitter-java/tree-sitter-java.wasm",
	".css": "tree-sitter-css/tree-sitter-css.wasm",
	".html": "tree-sitter-html/tree-sitter-html.wasm",
	".yaml": "@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm",
	".yml": "@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm",
	".toml": "@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm",
};
/** How the shell opens its report of broken files; the UI keys on it too. */
export const SYNTAX_ERRORS = "[syntax errors this command introduced (line:column), fix before moving on:";
/** Errors listed per file; the rest are counted. */
const MAX_REPORTED = 3;
/** Larger files are not parsed after every command. */
const MAX_CHARS = 512 * 1024;

let ready: Promise<void> | undefined;
const languages = new Map<string, Promise<Language | undefined>>();
const HERE = dirname(Bun.fileURLToPath(import.meta.url));

function language(extension: string): Promise<Language | undefined> {
	const asset = GRAMMARS[extension];
	if (!asset) return Promise.resolve(undefined);
	let loading = languages.get(asset);
	if (!loading) {
		ready ??= Parser.init();
		loading = ready
			.then(() => Language.load(Bun.resolveSync(asset, HERE)))
			// A missing grammar only means that file type goes unchecked.
			.catch(() => undefined);
		languages.set(asset, loading);
	}
	return loading;
}

/** `line:column` of each ERROR or MISSING node, outermost first. */
function problems(root: Node): { line: number; column: number; missing?: string }[] {
	const found: { line: number; column: number; missing?: string }[] = [];
	const visit = (node: Node) => {
		if (!node.hasError && !node.isMissing) return;
		if (node.isError || node.isMissing) {
			found.push({
				line: node.startPosition.row + 1,
				column: node.startPosition.column + 1,
				...(node.isMissing ? { missing: node.type } : {}),
			});
			return;
		}
		for (const child of node.children) if (child) visit(child);
	};
	visit(root);
	return found;
}

async function parse(text: string, extension: string) {
	const grammar = await language(extension);
	if (!grammar) return undefined;
	const parser = new Parser();
	try {
		parser.setLanguage(grammar);
		const tree = parser.parse(text);
		if (!tree) return undefined;
		try {
			return problems(tree.rootNode);
		} finally {
			tree.delete();
		}
	} finally {
		parser.delete();
	}
}

/**
 * One line per file that now has syntax errors it did not have before, or nothing.
 * `before` is undefined for a file the command created.
 */
export async function syntaxRegressions(
	files: { shown: string; before?: string; after: string }[],
): Promise<string[]> {
	const lines: string[] = [];
	for (const file of files) {
		const extension = extname(file.shown).toLowerCase();
		if (!GRAMMARS[extension] || file.after.length > MAX_CHARS) continue;
		try {
			const after = await parse(file.after, extension);
			if (!after?.length) continue;
			const before = file.before === undefined ? [] : ((await parse(file.before, extension)) ?? []);
			if (after.length <= before.length) continue;
			const listed = after
				.slice(0, MAX_REPORTED)
				.map(
					(problem) =>
						`${problem.line}:${problem.column}${problem.missing ? ` (missing ${problem.missing})` : ""}`,
				);
			const more = after.length > MAX_REPORTED ? ` and ${after.length - MAX_REPORTED} more` : "";
			lines.push(`${file.shown}: ${listed.join(", ")}${more}`);
		} catch {
			// A parser failure is not a syntax error in the file.
		}
	}
	return lines;
}
