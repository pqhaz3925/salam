import { Buffer } from "node:buffer";
import type { HarnessTool, ToolContext, ToolOutput } from "../contracts.ts";
import { runAst } from "./ast-run.ts";
import { commitEditPlan, type EditPlan } from "./lsp/transaction.ts";
import { unifiedDiff } from "./text.ts";
import { argOptionalString, argString, randomToken, sha256Hex, ToolFailure } from "./util.ts";
import { defineTool, displayPath, type ToolEnvironment, type Workspace } from "./workspace.ts";

interface Proposal {
	owner: string;
	workspace: string;
	plan: EditPlan;
	diff: string;
	artifact: string;
}

export function createAstEditTools(
	environment: ToolEnvironment,
	resolveBinary: (workspace: Workspace, signal: AbortSignal) => Promise<string>,
): HarnessTool[] {
	const proposals = new Map<string, Proposal>();
	const owner = (context: ToolContext) => `${context.sessionId}\0${context.agentId}`;
	const stage = defineTool({
		name: "ast_edit",
		description:
			"Preview a structural rewrite without changing files. Uses AST metavariables, validates every replacement and returns complete diff and expected hashes. Explicitly call ast_apply or ast_reject with the proposal id. All apply writes use checked workspace operations, never shell rewrites.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string" },
				replacement: { type: "string" },
				lang: { type: "string", description: "Required language, e.g. ts, python, cpp." },
				path: { type: "string", description: "File/directory to rewrite; default working directory." },
			},
			required: ["pattern", "replacement", "lang"],
			additionalProperties: false,
		},
		async run(args, context): Promise<ToolOutput> {
			if (proposals.size >= 32)
				throw new ToolFailure("There are 32 pending AST proposals; apply or reject one before staging more.");
			const workspace = environment.workspace(context),
				binary = await resolveBinary(workspace, context.signal);
			const target = workspace.resolvePath(context.cwd, argOptionalString(args, "path") ?? "."),
				pattern = argString(args, "pattern"),
				replacement = argString(args, "replacement"),
				lang = argString(args, "lang");
			const flags = [`--pattern=${pattern}`, `--lang=${lang}`];
			const found = await runAst(workspace, binary, [...flags, target], context);
			const paths = [
				...new Set(found.map((match) => workspace.resolvePath(context.cwd, String(match.file)))),
			].sort();
			if (paths.length > 256) throw new ToolFailure("Rewrite spans more than 256 files; narrow the path.");
			const plan: EditPlan = { initial: new Map(), steps: [] };
			let bytes = 0;
			for (const path of paths) {
				const stat = await workspace.fs.stat(path, { signal: context.signal });
				if (stat.kind !== "file" || stat.symlink)
					throw new ToolFailure(`AST rewrite requires regular files: ${path}`);
				const read = await workspace.fs.readBytes(path, 8 * 1024 * 1024, context.signal);
				bytes += read.bytes.length;
				if (read.truncated || bytes > 64 * 1024 * 1024)
					throw new ToolFailure(
						"AST rewrite exceeds the 8 MiB/file or 64 MiB/proposal limit; narrow the path.",
					);
				const before = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
				if (sha256Hex(read.bytes) !== stat.hash)
					throw new ToolFailure(`${path} changed while preparing the rewrite.`);
				// Re-run against these exact bytes, so discovery cannot bind edits to a different revision.
				const matches = await runAst(
					workspace,
					binary,
					[...flags, `--rewrite=${replacement}`, "--stdin"],
					context,
					before,
				);
				const edits = matches
					.map((match) => {
						const range = match.range as { byteOffset?: { start: number; end: number } };
						if (!range?.byteOffset || typeof match.replacement !== "string")
							throw new ToolFailure(
								"ast-grep did not return byte ranges and replacement text; refusing to guess a rewrite.",
							);
						return {
							start: range.byteOffset.start,
							end: range.byteOffset.end,
							text: match.replacement,
							matched: String(match.text),
						};
					})
					.sort((a, b) => b.start - a.start || b.end - a.end);
				let after = Buffer.from(read.bytes),
					boundary = after.length;
				for (const edit of edits) {
					if (
						edit.start < 0 ||
						edit.end < edit.start ||
						edit.end > boundary ||
						after.subarray(edit.start, edit.end).toString("utf8") !== edit.matched
					)
						throw new ToolFailure(`Overlapping or invalid AST rewrite ranges in ${path}.`);
					after = Buffer.concat([
						after.subarray(0, edit.start),
						Buffer.from(edit.text),
						after.subarray(edit.end),
					]);
					boundary = edit.start;
				}
				if (after.length > 8 * 1024 * 1024) throw new ToolFailure(`Rewritten file exceeds 8 MiB: ${path}`);
				const updated = after.toString("utf8");
				if (before !== updated) {
					plan.initial.set(path, before);
					plan.steps.push({ path, before, after: updated });
				}
			}
			if (!plan.steps.length)
				return { text: "No structural rewrites; no files changed.", details: { changedFiles: 0 } };
			const id = randomToken(12),
				diff = plan.steps
					.map((step) =>
						unifiedDiff(step.before!, step.after!, displayPath(workspace.base(context.cwd), step.path)),
					)
					.join("");
			const artifact = await environment.artifacts.store(
				context.sessionId,
				"ast-proposal",
				JSON.stringify(
					{ id, files: plan.steps.map((step) => ({ ...step, expectedHash: sha256Hex(step.before!) })), diff },
					null,
					2,
				),
			);
			proposals.set(id, {
				owner: owner(context),
				workspace: workspace.id,
				plan,
				diff,
				artifact: artifact.uri,
			});
			return {
				text: `Staged ${plan.steps.length} file(s). Nothing written. Apply with ast_apply proposal=${id}, or discard with ast_reject. Complete proposal: ${artifact.uri}\n${plan.steps.map((step) => `${step.path} expected_hash=${sha256Hex(step.before!)}`).join("\n")}`,
				diff,
				details: {
					proposal: id,
					artifact: artifact.uri,
					files: plan.steps.map((step) => ({ path: step.path, expectedHash: sha256Hex(step.before!) })),
				},
			};
		},
	});
	const parameters = {
		type: "object",
		properties: { proposal: { type: "string" } },
		required: ["proposal"],
		additionalProperties: false,
	};
	const apply = defineTool({
		name: "ast_apply",
		description:
			"Apply an ast_edit proposal after all original hashes pass preflight; failures conditionally roll back completed writes and report recovery artifacts.",
		parameters,
		async run(args, context): Promise<ToolOutput> {
			const id = argString(args, "proposal"),
				proposal = proposals.get(id),
				workspace = environment.workspace(context);
			if (!proposal || proposal.owner !== owner(context) || proposal.workspace !== workspace.id)
				throw new ToolFailure("Unknown AST proposal for this agent/workspace.");
			await commitEditPlan(environment, workspace, context, proposal.plan);
			proposals.delete(id);
			return {
				text: `Applied AST proposal ${id} to ${proposal.plan.steps.length} file(s).`,
				diff: proposal.diff,
				details: { proposal: id, changedFiles: proposal.plan.steps.length, artifact: proposal.artifact },
			};
		},
	});
	const reject = defineTool({
		name: "ast_reject",
		description: "Discard a pending AST proposal without changing workspace files.",
		parameters,
		async run(args, context): Promise<ToolOutput> {
			const id = argString(args, "proposal"),
				proposal = proposals.get(id);
			if (
				!proposal ||
				proposal.owner !== owner(context) ||
				proposal.workspace !== environment.workspace(context).id
			)
				throw new ToolFailure("Unknown AST proposal for this agent/workspace.");
			proposals.delete(id);
			return { text: `Rejected AST proposal ${id}; no workspace files changed.` };
		},
	});
	return [stage, apply, reject];
}
