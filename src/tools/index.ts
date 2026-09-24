import type { Arguments, HarnessTool, SalamConfig, ToolContext, ToolOutput } from "../contracts.ts";
import { ArtifactStore } from "./artifacts.ts";
import { createDebugTools } from "./debug.ts";
import { createEvalTools } from "./eval.ts";
import { createFileOperationTools } from "./file-ops.ts";
import { createFileTools } from "./files.ts";
import { createLspTools } from "./lsp/tools.ts";
import type { ProcessManager } from "./processes.ts";
import { createSearchTools } from "./search.ts";
import { createProcessTools, createShellTool } from "./shell.ts";
import { ToolEnvironment, type Workspace } from "./workspace.ts";

export interface ToolServices {
	tools: HarnessTool[];
	/**
	 * Shared spill store. The runtime writes its own oversized payloads here so
	 * every truncation in the product is recoverable through the same
	 * `read artifact://…` path.
	 */
	artifacts: ArtifactStore;
	/**
	 * Background commands started by `shell` with `background: true`. The runtime
	 * drives `/jobs`, `/output`, `/wait` and `/kill` through exactly this, so a
	 * slash command and a tool call address the same job by the same id.
	 */
	processes: ProcessManager;
	/**
	 * The live workspace cache the tools themselves use. Callers that need an
	 * executor (worktrees, for instance) take it from here rather than building
	 * their own, so one SSH connection and one lifecycle are shared.
	 */
	workspaceFor(context: ToolContext): Workspace;
	/** Give programmable kernels the same validated, scoped dispatch path as direct tool calls. */
	setToolInvoker?(invoke: (name: string, args: Arguments, context: ToolContext) => Promise<ToolOutput>): void;
	close(): Promise<void>;
}

/**
 * Builds the complete local/remote tool surface: filesystem, search, shell and
 * language-server tools. Every tool is written once against a `Workspace`, so
 * the presence of `ToolContext.remote` is the only thing that decides whether a
 * call touches this machine or an SSH target.
 */
export async function createTools(config: SalamConfig): Promise<ToolServices> {
	const environment = new ToolEnvironment(config);
	await environment.processes.recover();
	const lsp = createLspTools(environment);
	const evaluation = createEvalTools(environment);
	const debugging = createDebugTools(environment);
	const tools: HarnessTool[] = [
		...createFileTools(environment),
		...createFileOperationTools(environment),
		...createSearchTools(environment),
		createShellTool(environment),
		...createProcessTools(environment),
		...lsp.tools,
		...evaluation.tools,
		...debugging.tools,
	];
	let closed = false;
	return {
		tools,
		artifacts: environment.artifacts,
		processes: environment.processes,
		workspaceFor: (context) => environment.workspace(context),
		setToolInvoker: (invoke) => evaluation.setInvoker(invoke),
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			const results = await Promise.allSettled([lsp.close(), evaluation.close(), debugging.close()]);
			try {
				await environment.close();
			} catch (reason) {
				results.push({ status: "rejected", reason });
			}
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length) throw new AggregateError(errors, "Some tool services could not shut down cleanly.");
		},
	};
}

export { ARTIFACT_SCHEME, ArtifactStore } from "./artifacts.ts";
export type { BoundedText, BoundOptions, StoredArtifact } from "./artifacts.ts";
export { Executor, LocalExecutor } from "./exec.ts";
export type { ExecOptions, ExecResult, BinaryExecResult, RunningCommand, ProtocolProcess } from "./exec.ts";
export type {
	ProcessInfo,
	ProcessManager,
	ProcessOutput,
	ProcessState,
	ReadinessCondition,
} from "./processes.ts";
export type { CommandInput, TerminalScreen } from "./supervised-command.ts";
export { LocalFs, observeMutations, RemoteFs, readTextFile, unobserved } from "./fs.ts";
export type { DirEntry, FileStat, FsMutation, FsMutationObserver, WorkspaceFs } from "./fs.ts";
export { connectionKey, RemoteExecutor, validateTarget } from "./ssh.ts";
export { unifiedDiff } from "./text.ts";
export { defineTool, displayPath, ToolEnvironment, Workspace } from "./workspace.ts";
