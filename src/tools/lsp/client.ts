import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256Hex, ToolFailure } from "../util.ts";

/** LSP positions are zero-based, and `character` counts UTF-16 code units. */
export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface LocationLink {
	targetUri: string;
	targetRange: Range;
	targetSelectionRange?: Range;
}

export interface Diagnostic {
	range: Range;
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

export interface TextEdit {
	range: Range;
	newText: string;
}

export interface TextDocumentEdit {
	textDocument: { uri: string; version?: number | null };
	edits: TextEdit[];
}

export interface CreateFileOperation {
	kind: "create";
	uri: string;
	options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export interface RenameFileOperation {
	kind: "rename";
	oldUri: string;
	newUri: string;
	options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export interface DeleteFileOperation {
	kind: "delete";
	uri: string;
	options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
}

export type ResourceOperation = CreateFileOperation | RenameFileOperation | DeleteFileOperation;
export type DocumentChange = TextDocumentEdit | ResourceOperation;

export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: DocumentChange[];
}

export interface MarkupContent {
	kind: string;
	value: string;
}

export interface Hover {
	contents: string | MarkupContent | (string | { language?: string; value: string })[];
	range?: Range;
}

/** Server-owned call-hierarchy node; `data` is opaque and must round-trip unchanged. */
export interface CallHierarchyItem {
	name: string;
	kind: number;
	tags?: number[];
	detail?: string;
	uri: string;
	range: Range;
	selectionRange: Range;
	data?: unknown;
}

export type CallDirection = "incoming" | "outgoing";

/**
 * One edge of the hierarchy: the caller (incoming) or callee (outgoing) item,
 * with call-site ranges. Incoming ranges lie in `item`'s document; outgoing
 * ranges lie in the document of the item that was asked about.
 */
export interface CallHierarchyCall {
	item: CallHierarchyItem;
	fromRanges: Range[];
}

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** A document this client has told the server about and has not closed. */
interface OpenDocument {
	uri: string;
	languageId: string;
	version: number;
	/** Digest and byte length of the text the server currently holds. */
	hash: string;
	size: number;
}

/** What the server believes an open document contains, for staleness checks. */
export interface OpenDocumentInfo {
	uri: string;
	languageId: string;
	hash: string;
	size: number;
}

/** `FileChangeType` from the protocol: the values a watched-file event may carry. */
export const FILE_CREATED = 1;
export const FILE_CHANGED = 2;
export const FILE_DELETED = 3;

export interface ExternalChange {
	uri: string;
	type: typeof FILE_CREATED | typeof FILE_CHANGED | typeof FILE_DELETED;
	/** The file's text after the change, when the caller knows it. */
	text?: string;
	/** Language id for the file, so one the client does not hold open can still be refreshed. */
	languageId?: string;
}

const HEADER_TERMINATOR = "\r\n\r\n";
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

// URI escaping is not identity: servers may encode parentheses and other
// characters differently from didOpen. Keep all document state by decoded path.
function documentPath(uri: string): string {
	return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
}

/**
 * Minimal but complete LSP client over a child process's stdio. It speaks the
 * parts of the protocol this harness actually needs and — importantly —
 * *answers* the server-initiated requests that real servers block on
 * (configuration, capability registration, progress creation). A client that
 * ignores those appears to work and then hangs on the first real query.
 *
 * The transport is stdio, so the same class drives a local server and one
 * running on an SSH target: ssh is simply the process on the other end.
 */
export class LspClient {
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly diagnostics = new Map<string, Diagnostic[]>();
	private readonly diagnosticWaiters = new Map<string, (() => void)[]>();
	private readonly documents = new Map<string, OpenDocument>();
	private readonly progress = new Map<string | number, string>();
	private readonly progressWaiters = new Set<() => void>();
	private applyEditHandler: ((edit: WorkspaceEdit) => Promise<void>) | undefined;
	private readonly semanticReady = new Set<string>();
	private incoming: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private stderrTail = "";
	private exited = false;
	private workspaceFolders: { uri: string; name: string }[] = [];
	private actionGeneration = 0;
	capabilities: Record<string, unknown> = {};

	constructor(
		private readonly child: ChildProcess,
		readonly serverId: string,
	) {
		child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-4000);
		});
		child.on("close", () => {
			this.exited = true;
			for (const [id, request] of this.pending) {
				clearTimeout(request.timer);
				this.pending.delete(id);
				request.reject(
					new ToolFailure(`${serverId} exited before answering ${request.method}. ${this.stderrTail.trim()}`),
				);
			}
			for (const waiters of this.diagnosticWaiters.values()) for (const wake of waiters) wake();
			this.diagnosticWaiters.clear();
		});
		child.on("error", (error) => {
			this.exited = true;
			this.stderrTail = `${this.stderrTail}\n${error instanceof Error ? error.message : String(error)}`;
		});
	}

	get alive(): boolean {
		return !this.exited;
	}

	get codeActionGeneration(): number {
		return this.actionGeneration;
	}

	private consume(chunk: Buffer): void {
		this.incoming = this.incoming.length === 0 ? chunk : Buffer.concat([this.incoming, chunk]);
		for (;;) {
			const headerEnd = this.incoming.indexOf(HEADER_TERMINATOR);
			if (headerEnd < 0) return;
			const header = this.incoming.subarray(0, headerEnd).toString("ascii");
			const length = /content-length:\s*(\d+)/i.exec(header);
			if (!length) {
				// Unparseable frame: drop it rather than desynchronise forever.
				this.incoming = this.incoming.subarray(headerEnd + HEADER_TERMINATOR.length);
				continue;
			}
			const bodyStart = headerEnd + HEADER_TERMINATOR.length;
			const bodyEnd = bodyStart + Number(length[1]);
			if (this.incoming.length < bodyEnd) return;
			const body = this.incoming.subarray(bodyStart, bodyEnd).toString("utf8");
			this.incoming = this.incoming.subarray(bodyEnd);
			let message: JsonRpcMessage;
			try {
				message = JSON.parse(body) as JsonRpcMessage;
			} catch {
				continue;
			}
			this.dispatch(message);
		}
	}

	private dispatch(message: JsonRpcMessage): void {
		if (message.method !== undefined && message.id !== undefined) {
			this.answerServerRequest(message.id, message.method, message.params);
			return;
		}
		if (message.method !== undefined) {
			this.handleNotification(message.method, message.params);
			return;
		}
		if (typeof message.id !== "number") return;
		const request = this.pending.get(message.id);
		if (!request) return;
		clearTimeout(request.timer);
		this.pending.delete(message.id);
		if (message.error) request.reject(new ToolFailure(`${this.serverId}: ${message.error.message}`));
		else request.resolve(message.result);
	}

	private handleNotification(method: string, params: unknown): void {
		if (method === "$/progress") {
			const payload = params as {
				token: string | number;
				value: { kind: string; title?: string; message?: string };
			};
			if (payload.value.kind === "end") this.progress.delete(payload.token);
			else this.progress.set(payload.token, payload.value.title ?? payload.value.message ?? "server work");
			for (const wake of this.progressWaiters) wake();
			return;
		}
		if (method !== "textDocument/publishDiagnostics") return;
		const payload = params as { uri?: string; version?: number; diagnostics?: Diagnostic[] } | undefined;
		if (!payload?.uri) return;
		const path = documentPath(payload.uri);
		if (payload.version !== undefined && payload.version !== this.documents.get(path)?.version) return;
		this.diagnostics.set(path, payload.diagnostics ?? []);
		const waiters = this.diagnosticWaiters.get(path);
		if (waiters) {
			this.diagnosticWaiters.delete(path);
			for (const wake of waiters) wake();
		}
	}

	/**
	 * Servers stall waiting for these. `workspace/configuration` in particular is
	 * sent by typescript-language-server during startup and never times out on
	 * its side.
	 */
	private answerServerRequest(id: number | string, method: string, params: unknown): void {
		switch (method) {
			case "workspace/configuration": {
				const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
				this.reply(
					id,
					items.map(() => ({})),
				);
				return;
			}
			case "workspace/workspaceFolders":
				this.reply(id, this.workspaceFolders);
				return;
			case "client/registerCapability": {
				if (
					params &&
					typeof params === "object" &&
					"registrations" in params &&
					Array.isArray(params.registrations)
				) {
					for (const registration of params.registrations) {
						if (registration && typeof registration.method === "string")
							this.capabilities[registration.method] = registration.registerOptions ?? true;
					}
				}
				this.reply(id, null);
				return;
			}
			case "client/unregisterCapability":
			case "window/workDoneProgress/create":
			case "window/showMessageRequest":
			case "window/showDocument":
			case "workspace/diagnostic/refresh": // Each diagnostics call pulls afresh anyway.
			case "_typescript.rename": // Extract-refactor cursor hint, not another edit.
				this.reply(id, null);
				return;
			case "workspace/applyEdit":
				if (!this.applyEditHandler || !params || typeof params !== "object" || !("edit" in params)) {
					this.reply(id, {
						applied: false,
						failureReason: "No explicit code-action application is active or edit is missing.",
					});
				} else {
					const edit = params.edit as WorkspaceEdit;
					void this.applyEditHandler(edit).then(
						() => this.reply(id, { applied: true }),
						(error: unknown) => this.reply(id, { applied: false, failureReason: String(error) }),
					);
				}
				return;
			default:
				this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unhandled request: ${method}` } });
		}
	}

	private reply(id: number | string, result: unknown): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	private write(message: unknown): void {
		if (this.exited || !this.child.stdin?.writable) return;
		const body = Buffer.from(JSON.stringify(message), "utf8");
		this.child.stdin.write(`Content-Length: ${body.length}${HEADER_TERMINATOR}`);
		this.child.stdin.write(body);
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	request<T>(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
		if (this.exited) {
			return Promise.reject(new ToolFailure(`${this.serverId} is not running. ${this.stderrTail.trim()}`));
		}
		if (method === "textDocument/codeAction") {
			if (this.applyEditHandler)
				return Promise.reject(
					new ToolFailure("A code action is being applied; wait before requesting another listing."),
				);
			this.actionGeneration += 1;
		}
		const id = this.nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(
				new ToolFailure(`${this.serverId} did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`),
			);
		}, timeoutMs);
		timer.unref?.();
		this.pending.set(id, { method, resolve, reject, timer });
		this.write({ jsonrpc: "2.0", id, method, params });
		return promise as Promise<T>;
	}

	/** Only an explicitly selected action can authorize server-requested edits. */
	async executeActionCommand(
		command: string,
		args: unknown[],
		apply: (edit: WorkspaceEdit) => Promise<void>,
	): Promise<unknown> {
		if (this.applyEditHandler) throw new ToolFailure("Another language-server code action is being applied.");
		const edits: Promise<void>[] = [];
		this.applyEditHandler = (edit) => {
			const pending = (edits.at(-1) ?? Promise.resolve()).then(() => apply(edit));
			edits.push(pending);
			return pending;
		};
		let result: unknown;
		let failure: unknown;
		try {
			result = await this.request("workspace/executeCommand", { command, arguments: args });
		} catch (error) {
			failure = error;
		} finally {
			this.applyEditHandler = undefined;
		}
		// A failed command must not leave an earlier applyEdit writing after rollback starts.
		const settled = await Promise.allSettled(edits);
		for (const edit of settled) if (edit.status === "rejected") throw edit.reason;
		if (failure !== undefined) throw failure;
		return result;
	}

	readiness(uri: string): { state: string; progress: string[]; diagnosticsReceived: boolean } {
		uri = documentPath(uri);
		const diagnosticsReceived = this.diagnostics.has(uri);
		const confirmed =
			this.semanticReady.has(uri) || (this.serverId !== "typescript-language-server" && diagnosticsReceived);
		return {
			state: this.progress.size ? "initializing" : confirmed ? "ready" : "unconfirmed",
			progress: [...this.progress.values()],
			diagnosticsReceived,
		};
	}

	/** A real semantic-server round trip prevents TS's startup syntax-only answers. */
	async ensureSemanticReady(uri: string): Promise<void> {
		const path = documentPath(uri);
		if (
			this.serverId !== "typescript-language-server" ||
			(this.semanticReady.has(path) && this.progress.size === 0)
		)
			return;
		const response = await this.request<{ body?: { configFileName?: string }; success?: boolean }>(
			"workspace/executeCommand",
			{
				command: "typescript.tsserverRequest",
				arguments: ["projectInfo", { file: uri, needFileNameList: false }],
			},
			60_000,
		);
		if (response?.success === false || !response?.body?.configFileName)
			throw new ToolFailure("TypeScript semantic project is still initializing; retry the query.");
		this.semanticReady.add(path);
	}

	async typescriptDiagnostics(uri: string, timeoutMs: number): Promise<Diagnostic[]> {
		interface TsDiagnostic {
			message: string;
			category: string;
			code: number;
			startLocation: { line: number; offset: number };
			endLocation: { line: number; offset: number };
		}
		const diagnostics: Diagnostic[] = [];
		for (const command of [
			"syntacticDiagnosticsSync",
			"semanticDiagnosticsSync",
			"suggestionDiagnosticsSync",
		]) {
			const response = await this.request<{ body?: TsDiagnostic[]; success?: boolean }>(
				"workspace/executeCommand",
				{
					command: "typescript.tsserverRequest",
					arguments: [command, { file: uri, includeLinePosition: true }],
				},
				timeoutMs,
			);
			if (response?.success === false || !Array.isArray(response?.body))
				throw new ToolFailure("TypeScript did not provide a complete synchronous diagnostic report.");
			for (const item of response.body)
				diagnostics.push({
					message: item.message,
					code: item.code,
					source: "typescript",
					severity: item.category === "error" ? 1 : item.category === "warning" ? 2 : 3,
					range: {
						start: { line: item.startLocation.line - 1, character: item.startLocation.offset - 1 },
						end: { line: item.endLocation.line - 1, character: item.endLocation.offset - 1 },
					},
				});
		}
		this.diagnostics.set(documentPath(uri), diagnostics);
		return diagnostics;
	}

	documentVersions(): Map<string, number> {
		return new Map([...this.documents].map(([path, document]) => [path, document.version]));
	}

	async initialize(rootUri: string, rootPath: string, initializationOptions: unknown): Promise<void> {
		this.workspaceFolders = [{ uri: rootUri, name: rootPath.split("/").pop() || rootPath }];
		const result = await this.request<{ capabilities?: Record<string, unknown> }>(
			"initialize",
			{
				processId: process.pid,
				clientInfo: { name: "salam", version: "0.1.0" },
				locale: "en",
				rootPath,
				rootUri,
				workspaceFolders: this.workspaceFolders,
				initializationOptions,
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					window: { workDoneProgress: true },
					workspace: {
						applyEdit: true,
						configuration: true,
						workspaceFolders: true,
						didChangeConfiguration: { dynamicRegistration: true },
						fileOperations: { didRename: true, willRename: true, dynamicRegistration: true },
						workspaceEdit: {
							documentChanges: true,
							resourceOperations: ["create", "rename", "delete"],
							failureHandling: "transactional",
						},
						symbol: { dynamicRegistration: false },
						diagnostics: { refreshSupport: true },
					},
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
						hover: { contentFormat: ["markdown", "plaintext"] },
						definition: { linkSupport: true },
						typeDefinition: { linkSupport: true },
						implementation: { linkSupport: true },
						references: {},
						rename: { prepareSupport: false, dynamicRegistration: false },
						callHierarchy: { dynamicRegistration: false },
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						codeAction: {
							codeActionLiteralSupport: {
								codeActionKind: {
									valueSet: [
										"",
										"quickfix",
										"refactor",
										"refactor.extract",
										"refactor.inline",
										"refactor.rewrite",
										"source",
										"source.organizeImports",
									],
								},
							},
							resolveSupport: { properties: ["edit", "command"] },
							dataSupport: true,
						},
						publishDiagnostics: { relatedInformation: true, versionSupport: true },
						diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
					},
				},
			},
			60_000,
		);
		this.capabilities = result?.capabilities ?? {};
		this.notify("initialized", {});
		this.notify("workspace/didChangeConfiguration", { settings: {} });
	}

	/**
	 * Full-sync document open/update, recording what the server now holds so a
	 * later staleness check is one digest comparison rather than a re-send.
	 */
	syncDocument(uri: string, languageId: string, text: string): void {
		const hash = sha256Hex(text);
		const size = Buffer.byteLength(text);
		const path = documentPath(uri);
		const open = this.documents.get(path);
		if (open?.hash === hash) return;
		this.semanticReady.delete(path);
		this.diagnostics.delete(path);
		if (!open) {
			this.documents.set(path, { uri, languageId, version: 1, hash, size });
			this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
			return;
		}
		open.version += 1;
		open.hash = hash;
		open.size = size;
		this.notify("textDocument/didChange", {
			textDocument: { uri: open.uri, version: open.version },
			contentChanges: [{ text }],
		});
	}

	/** Every document the server currently holds a buffer for, with its digest. */
	openDocuments(): OpenDocumentInfo[] {
		return [...this.documents.values()].map((open) => ({
			uri: open.uri,
			languageId: open.languageId,
			hash: open.hash,
			size: open.size,
		}));
	}

	/**
	 * Drops an open buffer so the server falls back to what is on disk. The
	 * document may be opened again later; versions restart at 1, as the protocol
	 * requires.
	 */
	closeDocument(uri: string): void {
		const path = documentPath(uri),
			open = this.documents.get(path);
		if (!open) return;
		this.documents.delete(path);
		this.semanticReady.delete(path);
		this.diagnostics.delete(path);
		this.notify("textDocument/didClose", { textDocument: { uri: open.uri } });
	}

	/**
	 * Reports files this client rewrote behind the server's back.
	 *
	 * A watched-file event alone is not enough. For a document the client has
	 * opened, the server's own buffer is authoritative and the disk is ignored
	 * outright: a rename that edits three files leaves the two the cursor was not
	 * in shadowed by stale buffers, and the *next* semantic query answers from
	 * text that no longer exists — so a second rename silently misses exactly the
	 * cross-file usages the first one rewrote. Open documents are therefore
	 * pushed forward with a `didChange`.
	 *
	 * Files that are *not* open are not safe either: the server caches their
	 * contents and refreshes them from its own filesystem watchers, which are
	 * asynchronous and, for typescript-language-server, entirely disconnected
	 * from `workspace/didChangeWatchedFiles` unless the client runs the watchers
	 * itself. Handing the server the new text and handing ownership straight back
	 * makes it drop the cached copy for a disk re-read, which is exact and
	 * immediate. Anything whose text we cannot supply is closed rather than left
	 * lying.
	 */
	notifyExternalChanges(changes: ExternalChange[]): void {
		if (changes.length === 0) return;
		this.notify("workspace/didChangeWatchedFiles", {
			changes: changes.map((change) => ({ uri: change.uri, type: change.type })),
		});
		for (const change of changes) {
			const open = this.documents.get(documentPath(change.uri));
			const languageId = open?.languageId ?? change.languageId;
			if (change.type === FILE_DELETED || change.text === undefined || languageId === undefined) {
				this.closeDocument(change.uri);
				continue;
			}
			this.syncDocument(change.uri, languageId, change.text);
			if (!open) this.closeDocument(change.uri);
		}
	}

	hasDiagnostics(uri: string): boolean {
		return this.diagnostics.has(documentPath(uri));
	}

	diagnosticsFor(uri: string): Diagnostic[] {
		return this.diagnostics.get(documentPath(uri)) ?? [];
	}

	/** Pull-diagnostic options, from static capabilities or a dynamic registration. */
	private pullDiagnosticOptions(): Record<string, unknown> | undefined {
		const option = this.capabilities.diagnosticProvider ?? this.capabilities["textDocument/diagnostic"];
		if (!option) return undefined;
		return typeof option === "object" ? (option as Record<string, unknown>) : {};
	}

	get supportsPullDiagnostics(): boolean {
		return this.pullDiagnosticOptions() !== undefined;
	}

	get supportsWorkspaceDiagnostics(): boolean {
		return this.pullDiagnosticOptions()?.workspaceDiagnostics === true;
	}

	/**
	 * One native `workspace/diagnostic` pull. Only full reports whose version
	 * matches what this client holds (or documents it does not hold) are
	 * returned, keyed by decoded path. A document absent from the result has
	 * not been proven clean — callers must check it individually.
	 */
	async workspaceDiagnostics(timeoutMs: number): Promise<Map<string, Diagnostic[]>> {
		if (!this.supportsWorkspaceDiagnostics)
			throw new ToolFailure(`${this.serverId} does not advertise workspace diagnostics.`);
		const identifier = this.pullDiagnosticOptions()?.identifier;
		const result = await this.request<{
			items?: { uri?: string; kind?: string; version?: number | null; items?: Diagnostic[] }[];
		} | null>(
			"workspace/diagnostic",
			{ previousResultIds: [], ...(typeof identifier === "string" ? { identifier } : {}) },
			timeoutMs,
		);
		if (!result || !Array.isArray(result.items))
			throw new ToolFailure(`${this.serverId} returned no workspace diagnostic report.`);
		const reports = new Map<string, Diagnostic[]>();
		for (const report of result.items) {
			if (typeof report?.uri !== "string" || report.kind !== "full" || !Array.isArray(report.items)) continue;
			const path = documentPath(report.uri),
				open = this.documents.get(path);
			if (open && typeof report.version === "number" && report.version !== open.version) continue;
			if (open && typeof report.version !== "number") continue; // Disk-state report for a shadowed buffer.
			reports.set(path, report.items);
		}
		return reports;
	}

	get supportsCallHierarchy(): boolean {
		return !!(
			this.capabilities.callHierarchyProvider ?? this.capabilities["textDocument/prepareCallHierarchy"]
		);
	}

	async prepareCallHierarchy(
		uri: string,
		position: Position,
		timeoutMs = 60_000,
	): Promise<CallHierarchyItem[]> {
		if (!this.supportsCallHierarchy)
			throw new ToolFailure(`${this.serverId} does not advertise call hierarchy support.`);
		const items = await this.request<CallHierarchyItem[] | null>(
			"textDocument/prepareCallHierarchy",
			{ textDocument: { uri }, position },
			timeoutMs,
		);
		return (items ?? []).filter((item) => typeof item?.uri === "string" && item.selectionRange && item.range);
	}

	/** Sends the prepared item back verbatim, so server-private `data` survives. */
	async callHierarchyCalls(
		item: CallHierarchyItem,
		direction: CallDirection,
		timeoutMs = 60_000,
	): Promise<CallHierarchyCall[]> {
		const calls = await this.request<
			{ from?: CallHierarchyItem; to?: CallHierarchyItem; fromRanges?: Range[] }[] | null
		>(
			direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
			{ item },
			timeoutMs,
		);
		const result: CallHierarchyCall[] = [];
		for (const call of calls ?? []) {
			const other = direction === "incoming" ? call?.from : call?.to;
			if (typeof other?.uri !== "string" || !other.selectionRange) continue;
			result.push({ item: other, fromRanges: Array.isArray(call.fromRanges) ? call.fromRanges : [] });
		}
		return result;
	}

	/** Wait for actual server evidence, never infer readiness from an arbitrary sleep. */
	async awaitDiagnostics(uri: string, timeoutMs: number): Promise<Diagnostic[]> {
		uri = documentPath(uri);
		const deadline = Date.now() + timeoutMs;
		if (!this.diagnostics.has(uri)) {
			const { promise, resolve } = Promise.withResolvers<void>();
			const waiters = this.diagnosticWaiters.get(uri) ?? [];
			waiters.push(resolve);
			this.diagnosticWaiters.set(uri, waiters);
			const timer = setTimeout(resolve, timeoutMs);
			await promise;
			clearTimeout(timer);
			const remaining = this.diagnosticWaiters.get(uri)?.filter((wake) => wake !== resolve);
			if (remaining?.length) this.diagnosticWaiters.set(uri, remaining);
			else this.diagnosticWaiters.delete(uri);
		}
		while (this.progress.size && Date.now() < deadline && !this.exited) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.progressWaiters.add(resolve);
			const timer = setTimeout(resolve, deadline - Date.now());
			await promise;
			clearTimeout(timer);
			this.progressWaiters.delete(resolve);
		}
		return this.diagnostics.get(uri) ?? [];
	}

	async dispose(): Promise<void> {
		if (!this.exited) {
			await this.request("shutdown", null, 3000).catch(() => undefined);
			this.notify("exit", null);
		}
		await Bun.sleep(50);
		this.exited = true;
		try {
			this.child.kill("SIGTERM");
		} catch {
			// Already gone.
		}
	}
}
