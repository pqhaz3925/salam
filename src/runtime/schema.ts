import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { REASONING_LEVELS } from "../contracts.ts";
import type { HistoryEntry } from "../contracts.ts";
import type {
	AuxUsageRecord,
	FileMutationInput,
	FileSnapshot,
	LegacySessionRecord,
	SessionRecord,
	WorktreeRecord,
} from "./store.ts";

const ajv = new Ajv({ strict: false, allErrors: true });
const string = { type: "string" };
const strings = { type: "array", items: string };
const number = { type: "number" };
const content = {
	anyOf: [
		string,
		{ type: "array", items: { type: "object", required: ["type"], properties: { type: string } } },
	],
};
const modelChoice = {
	type: "object",
	required: ["provider", "model"],
	properties: { provider: string, model: string, label: string, contextWindow: number },
};
const flag = { type: "boolean" };
const sequence = { type: "integer", minimum: 0 };
const modelContext = {
	type: "object",
	required: ["selection", "sessionId", "cacheKey", "contextStart", "tokens"],
	properties: {
		selection: modelChoice,
		sessionId: string,
		cacheKey: string,
		contextStart: sequence,
		compactionId: string,
		cacheBoundary: string,
		notebook: string,
		tokens: { type: "number", minimum: 0 },
		restoreControls: flag,
		contextReset: flag,
		notesReminder: flag,
	},
};
const remoteTarget = {
	type: "object",
	required: ["host", "cwd"],
	properties: {
		host: string,
		cwd: string,
		port: { type: "integer", minimum: 1, maximum: 65535 },
		identityFile: string,
		knownHostsFile: string,
	},
};
const fileSnapshot = {
	type: "object",
	required: ["kind"],
	properties: {
		kind: { enum: ["missing", "file", "dir"] },
		hash: string,
		size: number,
		mode: { type: "integer", minimum: 0, maximum: 0o7777 },
	},
};
const sessionRequired = [
	"id",
	"title",
	"cwd",
	"selection",
	"system",
	"tools",
	"activeTools",
	"firstUserText",
	"notebook",
	"instructions",
	"updatedAt",
];
const sessionProperties = {
	id: string,
	title: string,
	cwd: string,
	localCwd: string,
	remote: string,
	parentId: string,
	ownerId: string,
	resultSchema: { anyOf: [{ type: "object" }, { type: "boolean" }] },
	completion: {
		type: "object",
		required: ["id", "status", "response"],
		properties: {
			id: string,
			status: { enum: ["running", "idle", "done", "error", "cancelled"] },
			response: string,
			result: {},
			error: string,
		},
	},
	firstUserText: string,
	notebook: string,
	updatedAt: number,
	system: strings,
	activeTools: strings,
	instructions: strings,
	selection: modelChoice,
	reasoning: { enum: REASONING_LEVELS },
	goal: {
		type: "object",
		required: ["id", "text", "status"],
		properties: {
			id: string,
			text: string,
			status: { enum: ["active", "paused", "completed"] },
			summary: string,
		},
	},
	todos: {
		type: "array",
		items: {
			type: "object",
			required: ["content", "status"],
			properties: {
				content: string,
				status: { enum: ["pending", "in_progress", "completed", "blocked", "abandoned"] },
				phase: string,
				reason: string,
			},
		},
	},
	tools: {
		type: "array",
		items: {
			type: "object",
			required: ["name", "description", "parameters"],
			properties: {
				name: string,
				description: string,
				parameters: { type: "object" },
				deferred: flag,
			},
		},
	},
	agent: {
		type: "object",
		required: ["id", "name", "status", "task", "cwd"],
		properties: {
			id: string,
			name: string,
			task: string,
			cwd: string,
			worktree: string,
			status: { enum: ["running", "idle", "done", "error", "cancelled"] },
			selection: modelChoice,
			reasoning: { enum: REASONING_LEVELS },
			result: {},
			error: string,
		},
	},
};
export const sessionSchema = ajv.compile<SessionRecord>({
	type: "object",
	required: [...sessionRequired, "contexts"],
	properties: {
		...sessionProperties,
		cacheFirstUserText: string,
		contexts: { type: "array", minItems: 1, items: modelContext },
	},
});
/** Sessions and checkpoint states written before schema v3. */
export const legacySessionSchema = ajv.compile<LegacySessionRecord>({
	type: "object",
	required: [...sessionRequired, "contextStart"],
	properties: { ...sessionProperties, contextStart: sequence, compactionId: string },
});
export const historySchema = ajv.compile<HistoryEntry>({
	type: "object",
	required: ["id", "kind"],
	properties: { id: string, origin: modelChoice },
	oneOf: [
		{
			required: ["message"],
			properties: {
				kind: { const: "message" },
				message: {
					type: "object",
					required: ["role", "content", "timestamp"],
					properties: { timestamp: number, content },
					oneOf: [
						{ properties: { role: { enum: ["user", "developer"] } } },
						{
							required: ["toolCallId", "toolName", "isError"],
							properties: {
								role: { const: "toolResult" },
								toolCallId: string,
								toolName: string,
								isError: { type: "boolean" },
								content: { type: "array" },
							},
						},
						{
							required: ["api", "provider", "model", "usage", "stopReason"],
							properties: {
								role: { const: "assistant" },
								api: string,
								provider: string,
								model: string,
								stopReason: string,
								content: { type: "array" },
								usage: {
									type: "object",
									required: ["input", "output", "cacheRead", "cacheWrite", "totalTokens"],
									properties: {
										input: number,
										output: number,
										cacheRead: number,
										cacheWrite: number,
										totalTokens: number,
									},
								},
							},
						},
					],
				},
			},
		},
		{
			required: ["text"],
			properties: { kind: { const: "system" }, text: string, addTools: strings, removeTools: strings },
		},
		{
			required: ["summary", "provider", "model"],
			properties: { kind: { const: "compaction" }, summary: string, provider: string, model: string },
		},
	],
});
export const worktreeSchema = ajv.compile<WorktreeRecord>({
	type: "object",
	required: ["id", "root", "path", "branch", "base", "createdAt"],
	properties: {
		id: string,
		root: string,
		path: string,
		branch: string,
		base: string,
		createdAt: number,
		remote: remoteTarget,
	},
});
export const snapshotSchema = ajv.compile<FileSnapshot>(fileSnapshot);
export const mutationSchema = ajv.compile<FileMutationInput>({
	type: "object",
	required: ["sessionId", "checkpointId", "workspaceId", "cwd", "path", "operation", "before", "at"],
	properties: {
		sessionId: string,
		checkpointId: string,
		workspaceId: string,
		cwd: string,
		path: string,
		counterpart: string,
		operation: { enum: ["write", "remove", "move", "mkdir", "rmdir", "dirmode"] },
		before: fileSnapshot,
		at: number,
		remote: remoteTarget,
	},
});
export const auxUsageSchema = ajv.compile<AuxUsageRecord>({
	type: "object",
	required: ["kind", "usage", "selection", "timestamp"],
	properties: {
		kind: { enum: ["recap", "compaction", "web_fetch", "web_search"] },
		selection: modelChoice,
		timestamp: number,
		usage: {
			type: "object",
			required: ["input", "output", "cacheRead", "cacheWrite", "totalTokens"],
			properties: {
				input: number,
				output: number,
				cacheRead: number,
				cacheWrite: number,
				totalTokens: number,
			},
		},
	},
});

export function decode<T>(json: string, validate: ValidateFunction<T>): T {
	const value: unknown = JSON.parse(json);
	if (!validate(value))
		throw new Error(`Invalid persisted runtime record: ${ajv.errorsText(validate.errors)}`);
	return value;
}
