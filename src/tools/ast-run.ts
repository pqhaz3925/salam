import type { ToolContext } from "../contracts.ts";
import { ToolFailure } from "./util.ts";
import type { Workspace } from "./workspace.ts";

/** Exit 1 means no matches only when the parser emitted no diagnostic. */
export async function runAst(
	workspace: Workspace,
	binary: string,
	args: string[],
	context: ToolContext,
	stdin?: string,
): Promise<Record<string, unknown>[]> {
	const result = await workspace.executor.exec([binary, "run", ...args, "--json=stream", "--color=never"], {
		cwd: workspace.base(context.cwd),
		signal: context.signal,
		timeoutMs: 180_000,
		maxCaptureBytes: 64 * 1024 * 1024,
		...(stdin === undefined ? {} : { stdin }),
	});
	if (
		result.timedOut ||
		result.aborted ||
		result.droppedStdoutBytes ||
		(result.code !== 0 && !(result.code === 1 && !result.stderr.trim()))
	)
		throw new ToolFailure(
			`ast_grep failed: ${result.stderr.trim() || (result.droppedStdoutBytes ? "output exceeds 64 MiB; narrow the search" : `ast-grep exited ${result.code}`)}`,
		);
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new ToolFailure("ast-grep returned malformed JSON; results are incomplete.");
			}
			if (
				!parsed ||
				typeof parsed !== "object" ||
				Array.isArray(parsed) ||
				!("file" in parsed) ||
				typeof parsed.file !== "string" ||
				!("range" in parsed) ||
				!("text" in parsed)
			)
				throw new ToolFailure("ast-grep returned an invalid match object.");
			return parsed as Record<string, unknown>;
		});
}
