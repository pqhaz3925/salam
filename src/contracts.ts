import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";

export const REASONING_LEVELS = ["off", "low", "medium", "high"] as const;
export interface SessionGoal {
	id: string;
	text: string;
	status: "active" | "paused" | "completed";
	summary?: string;
}

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed" | "blocked" | "abandoned";
	phase?: string;
	reason?: string;
}
export interface UserQuestionOption {
	label: string;
	description?: string;
}
export interface UserQuestion {
	id: string;
	question: string;
	options?: UserQuestionOption[];
	multi?: boolean;
}
export interface PendingQuestion {
	id: string;
	agentId: string;
	questions: UserQuestion[];
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Arguments = Record<string, unknown>;
export type ProviderKind = "anthropic" | "openai-codex" | "devin" | "custom-openai" | "custom-anthropic";
export interface ModelChoice {
	provider: string;
	model: string;
	label?: string;
	contextWindow?: number;
}
export interface ModelContext {
	selection: ModelChoice;
	sessionId: string;
	cacheKey: string;
	contextStart: number;
	compactionId?: string;
	cacheBoundary?: string;
	notebook?: string;
	tokens: number;
	restoreControls?: boolean;
	contextReset?: boolean;
	notesReminder?: boolean;
}
export interface ProviderProfile {
	kind: ProviderKind;
	baseUrl?: string;
	apiKeyEnv?: string;
	headers?: Record<string, string>;
	models?: { id: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }[];
}
export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
}
export interface RemoteTarget {
	host: string;
	cwd: string;
	port?: number;
	identityFile?: string;
	knownHostsFile?: string;
}
export interface SalamConfig {
	home: string;
	cwd: string;
	selection: ModelChoice;
	webSearchModel: ModelChoice;
	providers: Record<string, ProviderProfile>;
	mcpServers: Record<string, McpServerConfig>;
	remotes: Record<string, RemoteTarget>;
	maxTurns: number;
	/** Generate session titles with the session's model from the first message (default true). */
	autoTitle?: boolean;
	maxAgents: number;
	maxOutputTokens: number;
	/** Optional token cap; absent uses the active model's context budget. */
	contextThreshold?: number;
	reasoning: (typeof REASONING_LEVELS)[number];
	/** Claude Code-style file auto memory; absent means enabled. */
	autoMemoryEnabled?: boolean;
	/** Absolute memory directory override replacing the per-project default. */
	autoMemoryDirectory?: string;
	/** Settings source for persistent /memory toggles; defaults to the user config. */
	autoMemorySettingsPath?: string;
	/**
	 * Tools the model is offered (`--tools`/`--lean`); absent offers every tool. A restricted
	 * set also swaps in a system prompt that names no tool outside it, so a benchmark measures the
	 * tool set rather than leftover guidance.
	 */
	tools?: string[];
}
export type HistoryEntry = { origin?: ModelChoice } & (
	| { id: string; kind: "message"; message: Message }
	| { id: string; kind: "system"; text: string; addTools?: string[]; removeTools?: string[] }
	| {
			id: string;
			kind: "compaction";
			summary: string;
			native?: Json;
			provider: string;
			model: string;
			usage?: Usage;
	  }
);
export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	deferred?: boolean;
}
export interface ToolOutput {
	text: string;
	content?: ToolResultMessage["content"];
	isError?: boolean;
	details?: Json;
	diff?: string;
}
export interface ToolContext {
	cwd: string;
	sessionId: string;
	agentId: string;
	signal: AbortSignal;
	remote?: RemoteTarget;
	emit: (text: string) => void;
	/** Load/check scoped guidance for every planned mutation path before any effects. */
	checkMutationPaths?: (paths: string[]) => Promise<void>;
}
export interface HarnessTool extends ToolSpec {
	execute(args: Arguments, context: ToolContext): Promise<ToolOutput>;
}
export interface ProviderRequest {
	selection: ModelChoice;
	sessionId: string;
	cacheKey?: string;
	cacheBoundary?: string;
	historyOrigin?: ModelChoice;
	system: string[];
	firstUserText: string;
	entries: HistoryEntry[];
	tools: ToolSpec[];
	signal: AbortSignal;
	maxTokens: number;
	reasoning: SalamConfig["reasoning"];
}
export type ProviderEvent =
	| { type: "text" | "thinking"; delta: string }
	| { type: "done"; message: AssistantMessage };
export interface ProviderUsage {
	provider: string;
	fetchedAt: number;
	report?: UsageReport;
	unavailable?: string;
}
export interface ProviderGateway {
	/**
	 * provider limits the listing to one configured provider; offline skips live account
	 * discovery (Codex/Devin network requests) and lists only the bundled/configured catalog.
	 */
	models(options?: { provider?: string; offline?: boolean }): Promise<ModelChoice[]>;
	stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
	webFetch(request: {
		selection: ModelChoice;
		url: string;
		prompt?: string;
		signal: AbortSignal;
	}): Promise<AssistantMessage>;
	webSearch(request: {
		query: string;
		signal: AbortSignal;
	}): Promise<{ selection: ModelChoice; message: AssistantMessage }>;
	compact(request: ProviderRequest): Promise<Extract<HistoryEntry, { kind: "compaction" }>>;
	recap(request: ProviderRequest): Promise<AssistantMessage>;
	usage(selection: ModelChoice, signal: AbortSignal): Promise<ProviderUsage>;
	capabilities(selection: ModelChoice): {
		dynamicSystem: boolean;
		dynamicTools: boolean;
		signedCompaction: boolean;
		notesContext: boolean;
	};
	authStatus(): Promise<{ provider: string; available: boolean; source: string }[]>;
	login(
		provider: string,
		callbacks: { url: (url: string) => void; prompt: (message: string) => Promise<string> },
	): Promise<void>;
	close(): Promise<void>;
}
export interface IntegrationServices {
	tools: HarnessTool[];
	/** Resolves once background startup (MCP connections) has settled; instructions are then complete. */
	ready?(): Promise<void>;
	instructions(cwd: string): Promise<string[]>;
	skills(): Promise<{ name: string; description: string; source: string }[]>;
	loadSkill(name: string): Promise<string>;
	close(): Promise<void>;
}
export interface ViewItem {
	id: string;
	kind: "user" | "assistant" | "tool" | "notice";
	text: string;
	thinking?: string;
	name?: string;
	state?: "running" | "done" | "error";
	details?: string;
	diff?: string;
	agentId?: string;
	selection?: ModelChoice;
}
export interface AgentView {
	id: string;
	name: string;
	status: "running" | "idle" | "done" | "error" | "cancelled";
	task: string;
	cwd: string;
	worktree?: string;
	selection?: ModelChoice;
	reasoning?: SalamConfig["reasoning"];
	result?: Json;
	error?: string;
}
export interface SessionInfo {
	id: string;
	title: string;
	updatedAt: number;
	cwd: string;
	provider: string;
	model: string;
}
export type RewindMode = "conversation" | "files" | "both";
export interface RewindPoint {
	id: string;
	kind: "user" | "assistant" | "tool" | "agent";
	prompt: string;
	createdAt: number;
	files: number;
	filesAvailable: boolean;
	selection?: ModelChoice;
}
/** An image the user attached to a message (pasted or dropped into the composer). */
export interface ImageAttachment {
	/** Base64 of the encoded image. */
	data: string;
	mimeType: string;
}
/** One subscription window in the footer: what is left of it and when it resets. */
export interface QuotaWindow {
	/** Short window name: `5h`, `day`, `week`. */
	label: string;
	/** Fraction of the window still available, 0..1. */
	remaining: number;
	resetsAt?: number;
}
/** The active model's account quota, as last fetched from its provider. */
export interface QuotaView {
	provider: string;
	windows: QuotaWindow[];
	fetchedAt: number;
}
export interface AppSnapshot {
	sessionId: string;
	/** Session title: /title, else model-generated, else the first message. */
	title?: string;
	inputMode?: "text" | "secret";
	selection: ModelChoice;
	reasoning: SalamConfig["reasoning"];
	goal?: SessionGoal;
	todos?: TodoItem[];
	question?: PendingQuestion;
	loops: number;
	cwd: string;
	remote?: string;
	busy: boolean;
	steering: string[];
	items: ViewItem[];
	agents: AgentView[];
	usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">;
	contextTokens: number;
	contextLimit: number;
	/** Subscription quota of the active provider (Claude, Codex, Devin); absent when unknown. */
	quota?: QuotaView;
	status: string;
}
export type RuntimeEvent =
	| { type: "change" }
	| { type: "delta"; id: string; kind: "text" | "thinking"; delta: string }
	| { type: "exit" }
	| { type: "draft"; text: string };
export type SubmissionMode = "steer" | "interrupt";
export interface AppController {
	snapshot(): AppSnapshot;
	subscribe(listener: (event: RuntimeEvent) => void): () => void;
	submit(text: string, mode?: SubmissionMode, images?: ImageAttachment[]): Promise<void>;
	answerQuestion(id: string, answers: Record<string, string | string[]>): Promise<void>;
	command(line: string): Promise<void>;
	cancel(): void;
	/** Interrupts the running work and sends queued messages now; a plain cancel when none are queued. */
	sendQueued(): Promise<void>;
	background(): boolean;
	models(): Promise<ModelChoice[]>;
	sessions(): SessionInfo[];
	checkpoints(): RewindPoint[];
	close(): Promise<void>;
}
