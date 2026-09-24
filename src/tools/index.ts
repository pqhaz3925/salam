import type { Arguments, HarnessTool, SalamConfig, ToolContext, ToolOutput } from "../contracts.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { createDebugTools } from "./debug.ts";
import { createEvalTools } from "./eval.ts";
import { createFileOperationTools } from "./file-ops.ts";
import { createFileTools, createViewImageTool } from "./files.ts";
import { createLspTools } from "./lsp/tools.ts";
import type { ProcessManager, WatchEvent } from "./processes.ts";
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
	/** Where `command_watch` events go; the runtime files them as mail and wakes the watcher. */
	setWatchSink?(sink: (event: WatchEvent) => void): void;
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
	// The full shell steers toward these tools; a restricted set without them gets the bare shell.
	const bare =
		config.tools !== undefined &&
		!["read", "grep", "glob", "command_wait", "command_watch"].every((name) => config.tools!.includes(name));
	const background = bare && ["command_output", "command_stop"].every((name) => config.tools!.includes(name));
	const files = createFileTools(environment);
	const tools: HarnessTool[] = [
		...files,
		...createFileOperationTools(environment),
		...createSearchTools(environment),
		createShellTool(environment, { bare, background }),
		...createProcessTools(environment),
		...lsp.tools,
		...evaluation.tools,
		...debugging.tools,
		// Only a restricted set asks for it; the full set already shows images through read.
		...(config.tools?.includes("view_image")
			? [createViewImageTool(files.find((tool) => tool.name === "read")!)]
			: []),
	];
	let closed = false;
	return {
		tools,
		artifacts: environment.artifacts,
		processes: environment.processes,
		workspaceFor: (context) => environment.workspace(context),
		setToolInvoker: (invoke) => evaluation.setInvoker(invoke),
		setWatchSink: (sink) => environment.setWatchSink(sink),
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

export type { BoundedText, BoundOptions, StoredArtifact } from "./artifacts.ts";
export { ARTIFACT_SCHEME, ArtifactStore } from "./artifacts.ts";
export type { BinaryExecResult, ExecOptions, ExecResult, ProtocolProcess, RunningCommand } from "./exec.ts";
export { Executor, LocalExecutor } from "./exec.ts";
export type { DirEntry, FileStat, FsMutation, FsMutationObserver, WorkspaceFs } from "./fs.ts";
export { LocalFs, observeMutations, RemoteFs, readTextFile, unobserved } from "./fs.ts";
export type {
	ProcessInfo,
	ProcessManager,
	ProcessOutput,
	ProcessState,
	ReadinessCondition,
	WatchEvent,
	WatchSpec,
} from "./processes.ts";
export { describeWatchEvent, longestSleep } from "./shell.ts";
export { connectionKey, RemoteExecutor, validateTarget } from "./ssh.ts";
export type { CommandInput, TerminalScreen } from "./supervised-command.ts";
export { unifiedDiff } from "./text.ts";
export { defineTool, displayPath, ToolEnvironment, Workspace } from "./workspace.ts";
