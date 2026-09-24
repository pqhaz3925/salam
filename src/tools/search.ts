import { Buffer } from "node:buffer";
import { join } from "node:path";
import type { Arguments, HarnessTool, ToolContext, ToolOutput } from "../contracts.ts";
import { runAst } from "./ast-run.ts";
import { createAstEditTools } from "./staged-ast.ts";
import { argBool, argInt, argOptionalString, argString, ToolFailure } from "./util.ts";
import { defineTool, displayPath, HARNESS_ROOT, type ToolEnvironment, type Workspace } from "./workspace.ts";

const AST_GREP_PACKAGE: Record<string, string> = {
	"darwin-arm64": "@ast-grep/cli-darwin-arm64",
	"darwin-x64": "@ast-grep/cli-darwin-x64",
	"linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
	"linux-x64": "@ast-grep/cli-linux-x64-gnu",
};
export const SEARCH_PAGE_PROPERTIES = {
	skip: { type: "integer", minimum: 0, description: "Number of results to skip; use nextSkip to continue." },
	limit: { type: "integer", minimum: 1, maximum: 2000, description: "Results per page, default 100." },
};

export async function searchPage(
	environment: ToolEnvironment,
	context: ToolContext,
	args: Arguments,
	label: string,
	rows: string[],
): Promise<ToolOutput> {
	const skip = argInt(args, "skip", 0, 0, Number.MAX_SAFE_INTEGER),
		limit = argInt(args, "limit", 100, 1, 2000);
	const page = rows.slice(skip, skip + limit);
	const nextSkip = skip + page.length;
	const more = nextSkip < rows.length;
	const bounded = await environment.artifacts.bound(page.join("\n") || "(no results in this page)", {
		sessionId: context.sessionId,
		label,
	});
	const full =
		more || skip > 0
			? await environment.artifacts.store(context.sessionId, `${label}-complete`, rows.join("\n"))
			: undefined;
	return {
		text: `${rows.length} results; showing ${page.length} from skip=${skip}.\n${bounded.text}${more ? `\n[continue with skip=${nextSkip}]` : ""}${full ? `\n[complete results: ${full.uri}]` : ""}`,
		details: {
			matched: rows.length,
			shown: page.length,
			skip,
			...(more ? { nextSkip } : {}),
			...(full ? { artifact: full.uri } : bounded.artifact ? { artifact: bounded.artifact } : {}),
		},
	};
}

export function createSearchTools(environment: ToolEnvironment): HarnessTool[] {
	const binaries = new Map<string, Promise<string>>();
	const resolveAstGrep = (workspace: Workspace, signal: AbortSignal): Promise<string> => {
		const cached = binaries.get(workspace.id);
		if (cached) return cached;
		const lookup = (async () => {
			if (!workspace.isRemote) {
				const pkg = AST_GREP_PACKAGE[`${process.platform}-${process.arch}`];
				if (pkg) {
					const path = join(HARNESS_ROOT, "node_modules", pkg, "ast-grep");
					if (await Bun.file(path).exists()) return path;
				}
			}
			return (
				(await workspace.executor.which("ast-grep", signal)) ??
				(await workspace.requireBinary("sg", "structural search", signal))
			);
		})().catch((error) => {
			binaries.delete(workspace.id);
			throw error;
		});
		binaries.set(workspace.id, lookup);
		return lookup;
	};
	const common = {
		path: { type: "string", description: "File or directory in the active workspace." },
		hidden: { type: "boolean" },
		gitignore: { type: "boolean" },
		...SEARCH_PAGE_PROPERTIES,
	};
	const glob = defineTool({
		name: "glob",
		description:
			"Find matching files newest-first in the active workspace. Page with skip/limit; complete results are recoverable via artifact://.",
		parameters: {
			type: "object",
			properties: { ...common, pattern: { type: "string" } },
			required: ["pattern"],
			additionalProperties: false,
		},
		async run(args, context) {
			const workspace = environment.workspace(context),
				root = workspace.resolvePath(context.cwd, argOptionalString(args, "path") ?? ".");
			const binary = await workspace.requireBinary("rg", "file globbing", context.signal);
			const argv = [
				binary,
				"--files",
				"--no-config",
				"--sortr=modified",
				`--glob=${argString(args, "pattern")}`,
				"--glob=!.git/",
			];
			if (argBool(args, "hidden", false)) argv.push("--hidden");
			if (!argBool(args, "gitignore", true)) argv.push("--no-ignore");
			argv.push(root);
			const result = await workspace.executor.exec(argv, {
				signal: context.signal,
				cwd: workspace.base(context.cwd),
				timeoutMs: 120_000,
				maxCaptureBytes: 64 * 1024 * 1024,
			});
			if (result.code > 1 || result.timedOut || result.aborted || result.droppedStdoutBytes)
				throw new ToolFailure(`glob failed: ${result.stderr || "incomplete output; narrow the search"}`);
			return searchPage(
				environment,
				context,
				args,
				"glob",
				result.stdout
					.split("\n")
					.filter(Boolean)
					.map((path) => displayPath(workspace.base(context.cwd), path)),
			);
		},
	});
	const grep = defineTool({
		name: "grep",
		description:
			"Search with Rust regex and automatic PCRE2 fallback for unsupported constructs. Modes content/files/count. Page with skip/limit; complete unabridged matches spill to artifacts. Runs on the SSH target for remote sessions.",
		parameters: {
			type: "object",
			properties: {
				...common,
				pattern: { type: "string" },
				glob: { type: "string" },
				mode: { type: "string", enum: ["content", "files", "count"] },
				case_sensitive: { type: "boolean" },
				context: { type: "integer", minimum: 0, maximum: 20 },
				multiline: { type: "boolean" },
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		async run(args, context) {
			const workspace = environment.workspace(context),
				root = workspace.resolvePath(context.cwd, argOptionalString(args, "path") ?? "."),
				base = workspace.base(context.cwd);
			const mode = argOptionalString(args, "mode") ?? "content";
			if (!["content", "files", "count"].includes(mode)) throw new ToolFailure("Invalid grep mode.");
			const binary = await workspace.requireBinary("rg", "content search", context.signal);
			const argv = [
				binary,
				"--no-config",
				"--sort=path",
				`--regexp=${argString(args, "pattern")}`,
				args.case_sensitive === undefined
					? "--smart-case"
					: argBool(args, "case_sensitive", true)
						? "--case-sensitive"
						: "--ignore-case",
			];
			if (argBool(args, "hidden", false)) argv.push("--hidden");
			if (!argBool(args, "gitignore", true)) argv.push("--no-ignore");
			if (argBool(args, "multiline", false)) argv.push("--multiline", "--multiline-dotall");
			const filter = argOptionalString(args, "glob");
			if (filter) argv.push(`--glob=${filter}`);
			if (mode === "content") argv.push("--json", `--context=${argInt(args, "context", 0, 0, 20)}`);
			else
				argv.push(...(mode === "files" ? ["--files-with-matches"] : ["--count-matches", "--with-filename"]));
			argv.push(root);
			const options = {
				signal: context.signal,
				cwd: base,
				timeoutMs: 180_000,
				maxCaptureBytes: 64 * 1024 * 1024,
			};
			let result = await workspace.executor.exec(argv, options);
			if (
				result.code > 1 &&
				/(?:look-around|backreferences|backreference|lookahead|lookbehind).*not supported|PCRE2/i.test(
					result.stderr,
				)
			)
				result = await workspace.executor.exec([argv[0]!, "--pcre2", ...argv.slice(1)], options);
			if (result.code > 1 || result.timedOut || result.aborted || result.droppedStdoutBytes)
				throw new ToolFailure(`grep failed: ${result.stderr || "incomplete output; narrow the search"}`);
			const rows: string[] = [];
			for (const line of result.stdout.split("\n").filter(Boolean)) {
				if (mode !== "content") {
					rows.push(displayPath(base, line));
					continue;
				}
				const event = JSON.parse(line) as {
					type: string;
					data?: {
						path?: { text?: string; bytes?: string };
						line_number?: number;
						lines?: { text?: string; bytes?: string };
					};
				};
				if (event.type !== "match" && event.type !== "context") continue;
				const data = event.data!,
					path = data.path?.text ?? Buffer.from(data.path?.bytes ?? "", "base64").toString("utf8");
				const text = data.lines?.text ?? Buffer.from(data.lines?.bytes ?? "", "base64").toString("utf8");
				rows.push(
					`${displayPath(base, path)}:${data.line_number ?? 0}${event.type === "match" ? ":" : "-"} ${text.replace(/\r?\n$/, "")}`,
				);
			}
			return searchPage(environment, context, args, "grep", rows);
		},
	});
	const astGrep = defineTool({
		name: "ast_grep",
		description:
			"Structural search with $NODE and $$$NODES metavariables. A valid pattern with no matches is success; malformed patterns are errors. Page with skip/limit or recover full results from artifacts.",
		parameters: {
			type: "object",
			properties: { ...common, pattern: { type: "string" }, lang: { type: "string" } },
			required: ["pattern"],
			additionalProperties: false,
		},
		async run(args, context) {
			const workspace = environment.workspace(context),
				target = workspace.resolvePath(context.cwd, argOptionalString(args, "path") ?? ".");
			const argv = [`--pattern=${argString(args, "pattern")}`];
			const lang = argOptionalString(args, "lang");
			if (lang) argv.push(`--lang=${lang}`);
			if (argBool(args, "hidden", false)) argv.push("--no-ignore=hidden");
			if (!argBool(args, "gitignore", true)) argv.push("--no-ignore=vcs", "--no-ignore=dot");
			argv.push(target);
			const matches = await runAst(workspace, await resolveAstGrep(workspace, context.signal), argv, context);
			const rows = matches
				.map((match) => {
					const range = match.range as { start: { line: number; column: number } };
					return `${displayPath(workspace.base(context.cwd), String(match.file))}:${range.start.line + 1}:${range.start.column + 1}\n${String(match.lines ?? match.text ?? "")}`;
				})
				.sort();
			return searchPage(environment, context, args, "ast-grep", rows);
		},
	});
	return [glob, grep, astGrep, ...createAstEditTools(environment, resolveAstGrep)];
}
