import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Message, Usage } from "@oh-my-pi/pi-ai";
import type {
	AgentView,
	HistoryEntry,
	Json,
	ModelChoice,
	ModelContext,
	RemoteTarget,
	RewindPoint,
	SalamConfig,
	SessionGoal,
	SessionInfo,
	ToolSpec,
	TodoItem,
} from "../contracts.ts";
import {
	auxUsageSchema,
	decode,
	historySchema,
	legacySessionSchema,
	mutationSchema,
	sessionSchema,
	snapshotSchema,
	worktreeSchema,
} from "./schema.ts";

export interface SessionRecord {
	id: string;
	title: string;
	cwd: string;
	localCwd?: string;
	selection: ModelChoice;
	reasoning?: SalamConfig["reasoning"];
	goal?: SessionGoal;
	todos?: TodoItem[];
	system: string[];
	tools: ToolSpec[];
	activeTools: string[];
	firstUserText: string;
	/**
	 * The text the provider's cached prompt head was seeded from, frozen when
	 * the first request is built — possibly empty — and absent until then.
	 * Inherited by every branch, even one cut before the message it came from,
	 * so a rewind never reseeds the head; it is never shown to a model as text.
	 */
	cacheFirstUserText?: string;
	remote?: string;
	notebook: string;
	/**
	 * One context window per model the session has used, never removed. The
	 * first is the session's original model; history entries without an
	 * `origin` belong to it.
	 */
	contexts: ModelContext[];
	parentId?: string;
	ownerId?: string;
	resultSchema?: Record<string, unknown> | boolean;
	completion?: { id: string; status: AgentView["status"]; response: string; result?: Json; error?: string };
	agent?: AgentView;
	instructions: string[];
	updatedAt: number;
}
/**
 * The session shape before per-model contexts, when the only window sat on the
 * session root. Decoded solely by the v3 migration and by read-only listing of
 * a database that has not been migrated yet.
 */
export interface LegacySessionRecord extends Omit<SessionRecord, "contexts" | "cacheFirstUserText"> {
	contextStart: number;
	compactionId?: string;
}
export interface StoredEntry {
	seq: number;
	entry: HistoryEntry;
}
export interface InboxMessage {
	id: number;
	sender: string;
	text: string;
}
export interface WorktreeRecord {
	id: string;
	root: string;
	path: string;
	branch: string;
	base: string;
	createdAt: number;
	remote?: RemoteTarget;
}

/**
 * A rewind point plus everything needed to actually go back to it: the history
 * prefix it retains and the session metadata as it stood at that moment.
 *
 * `beforeSeq` is the last sequence the point keeps, so the retained prefix is
 * exactly `seq <= beforeSeq`. Points are captured before the entry they name
 * exists — and for a child agent's work that entry never lands in this
 * session's history at all — so a checkpoint is never validated against, or
 * filtered by, the main transcript.
 */
export interface CheckpointRecord extends RewindPoint {
	sessionId: string;
	beforeSeq: number;
	state: SessionRecord;
}

/** Existence, contents and mode of one path at one instant. */
export type FileSnapshot =
	| { kind: "missing" }
	| { kind: "dir"; mode?: number }
	| { kind: "file"; hash: string; size: number; mode?: number };

/**
 * `pending` is written before the bytes move and only ever becomes `done` once
 * the resulting state has been observed, so an interrupted process leaves a
 * record that cannot be mistaken for a reversible change. `reverted` marks a
 * record whose effect has already been undone by a restore.
 */
export type MutationStatus = "pending" | "done" | "failed" | "reverted";

export interface FileMutationInput {
	sessionId: string;
	checkpointId: string;
	workspaceId: string;
	cwd: string;
	remote?: RemoteTarget;
	path: string;
	operation: "write" | "remove" | "move" | "mkdir" | "rmdir" | "dirmode";
	/** The other path of a move, recorded for reporting only. */
	counterpart?: string;
	before: FileSnapshot;
	at: number;
}
export interface FileMutation extends FileMutationInput {
	id: number;
	status: MutationStatus;
	after?: FileSnapshot;
}

/**
 * Token usage spent outside the canonical conversation — recaps, compaction and
 * provider-backed web retrieval. Folding these into the transcript would corrupt context window
 * accounting, so they are billed to the session separately.
 */
export interface AuxUsageRecord {
	kind: "recap" | "compaction" | "web_fetch" | "web_search";
	usage: Usage;
	selection: ModelChoice;
	timestamp: number;
}

const SCHEMA_VERSION = 3;

const SCHEMA_V1 = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
  CREATE INDEX entries_session ON entries(session_id, seq);
  CREATE TABLE inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), sender TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX inbox_pending ON inbox(session_id, delivered, id);
  CREATE TABLE worktrees (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  PRAGMA user_version=1;
`;

/**
 * `ord` is the capture order and the only correct chronology: several points
 * share one `before_seq` whenever a turn issues parallel tool calls or spawns
 * child agents, because nothing has been appended to the main transcript
 * between them.
 */
const SCHEMA_V2 = `
  CREATE TABLE checkpoints (
    ord INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    before_seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    state TEXT NOT NULL,
    UNIQUE(session_id, id)
  );
  CREATE INDEX checkpoints_session ON checkpoints(session_id, ord);
  CREATE TABLE blobs (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
  CREATE TABLE mutations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    after TEXT,
    FOREIGN KEY (session_id, checkpoint_id) REFERENCES checkpoints(session_id, id)
  );
  CREATE INDEX mutations_point ON mutations(session_id, checkpoint_id, id);
  CREATE TABLE aux_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), data TEXT NOT NULL);
  CREATE INDEX aux_usage_session ON aux_usage(session_id, id);
  PRAGMA user_version=2;
`;

/**
 * v3 moves the single context window off the session root and into per-model
 * contexts, for sessions and for every saved checkpoint state. Each earlier
 * record had exactly one window, owned by the model then selected and
 * addressed by the session id, so it becomes that model's context with the
 * session id kept as both transport identity and cache key: a migrated session
 * resumes, and its checkpoints rewind, against the same provider-side cache.
 * The cached head was seeded from the logical first user text, which becomes
 * the frozen seed even when empty. History entries are not touched — an entry
 * without an origin belongs to the first context.
 */
function migrateModelContexts(db: Database): void {
	const earlier = db.query<{ one: number }, [string, number]>(
		"SELECT 1 AS one FROM entries WHERE session_id=? AND seq<? LIMIT 1",
	);
	const newestFirst = db.query<{ data: string }, [string, number, number, string]>(
		"SELECT data FROM entries WHERE session_id=? AND seq>=? AND seq<=? AND ((json_extract(data,'$.kind')='compaction' AND json_extract(data,'$.id')=?) OR (json_extract(data,'$.kind')='message' AND json_extract(data,'$.message.role')='assistant')) ORDER BY seq DESC LIMIT 1",
	);
	const root = (legacy: LegacySessionRecord, through: number): SessionRecord => {
		const { contextStart, compactionId, ...rest } = legacy;
		// Old branches remapped a whole-history window to their own first entry;
		// a start with nothing before it is the whole history, not a rolled window.
		const start = compactionId || earlier.get(legacy.id, contextStart) ? contextStart : 0;
		const context: ModelContext = {
			selection: legacy.selection,
			sessionId: legacy.id,
			cacheKey: legacy.id,
			contextStart: start,
			tokens: 0,
		};
		if (compactionId) {
			context.compactionId = compactionId;
			// The old runtime re-sent active controls after every resume of a
			// compacted window; nothing recorded whether that had happened.
			context.restoreControls = true;
			// Only responses after the summary measured this window.
			const row = newestFirst.get(legacy.id, start, through, compactionId);
			if (row) {
				const entry = decode(row.data, historySchema);
				if (entry.kind === "message" && entry.message.role === "assistant") {
					const usage = entry.message.usage;
					context.tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
				}
			}
		} else if (start > 0) context.notebook = legacy.notebook;
		return { ...rest, cacheFirstUserText: legacy.firstUserText, contexts: [context] };
	};
	// Paged by key so no more than one page of records is held at once.
	const sessions = db.query<{ id: string; data: string }, [string]>(
		"SELECT id,data FROM sessions WHERE id>? ORDER BY id LIMIT 256",
	);
	const saveSession = db.query("UPDATE sessions SET data=? WHERE id=?");
	for (let rows = sessions.all(""); rows.length; rows = sessions.all(rows[rows.length - 1]!.id))
		for (const row of rows)
			saveSession.run(
				JSON.stringify(root(decode(row.data, legacySessionSchema), Number.MAX_SAFE_INTEGER)),
				row.id,
			);
	const points = db.query<{ ord: number; before_seq: number; state: string }, [number]>(
		"SELECT ord,before_seq,state FROM checkpoints WHERE ord>? ORDER BY ord LIMIT 256",
	);
	const savePoint = db.query("UPDATE checkpoints SET state=? WHERE ord=?");
	for (let rows = points.all(0); rows.length; rows = points.all(rows[rows.length - 1]!.ord))
		for (const row of rows)
			savePoint.run(JSON.stringify(root(decode(row.state, legacySessionSchema), row.before_seq)), row.ord);
	db.exec("PRAGMA user_version=3");
}

const INTERRUPTED_LABEL = "(no text)";
/**
 * Inbox sender reserved for the user's own queued messages. Agents are named
 * by session id or `main`, so it cannot collide with real mail.
 */
const STEERING = "user (steering)";

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	let text = "";
	for (const block of message.content) if (block.type === "text") text += block.text;
	return text;
}

/** Legacy points are labelled from the transcript, which is not size-bounded. */
function label(message: Message): string {
	const raw = messageText(message).replace(/\s+/g, " ").trim();
	const body = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw || INTERRUPTED_LABEL;
	return message.role === "toolResult" ? `${message.toolName}: ${body}` : body;
}

function pointKind(message: Message): RewindPoint["kind"] | undefined {
	if (message.role === "assistant") return "assistant";
	if (message.role === "toolResult") return "tool";
	if (message.role !== "user") return undefined;
	return message.synthetic ? "agent" : "user";
}

function mutationStatus(value: string): MutationStatus {
	if (value === "pending" || value === "done" || value === "failed" || value === "reverted") return value;
	throw new Error(`Unknown persisted mutation status: ${value}`);
}

/**
 * The model an event belongs to. A stamped entry says so itself; otherwise the
 * model selected when the point was captured handled it — except a child
 * agent's response, whose entry lives in the child session while the capture
 * froze the main one.
 */
function pointSelection(
	kind: RewindPoint["kind"],
	state: SessionRecord,
	entry: HistoryEntry | undefined,
): ModelChoice | undefined {
	if (entry) return entry.origin ?? state.selection;
	return kind === "agent" ? undefined : state.selection;
}

interface CheckpointRow {
	ord: number;
	id: string;
	kind: string;
	before_seq: number;
	created_at: number;
	prompt: string;
	state: string;
}

export class Store {
	private readonly db: Database;
	/** A read-only client of an unmigrated database: it may only list sessions. */
	private readonly legacy: boolean;
	private closed = false;
	constructor(home: string, readonly = false) {
		if (!readonly) mkdirSync(home, { recursive: true, mode: 0o700 });
		this.db = new Database(join(home, "sessions.sqlite"), readonly ? { readonly: true } : { create: true });
		this.db.exec(
			readonly
				? "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;"
				: "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
		);
		const versionRow = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get();
		if (!versionRow) throw new Error("Cannot read SQLite schema version");
		const version = versionRow.user_version;
		if (version > SCHEMA_VERSION) {
			this.db.close();
			throw new Error(`Session database version ${version} is newer than this salam runtime`);
		}
		// Listing only reads `sessions`, which every released schema already has,
		// and decodes records older than v3 in their own shape, so a read-only
		// client never blocks on — or writes — a migration it cannot perform.
		if (readonly && version < 1) {
			this.db.close();
			throw new Error(
				`Session database version ${version} needs migration; start salam once before listing sessions.`,
			);
		}
		this.legacy = readonly && version < SCHEMA_VERSION;
		if (!readonly && version < SCHEMA_VERSION)
			this.db.transaction(() => {
				if (version < 1) this.db.exec(SCHEMA_V1);
				if (version < 2) this.db.exec(SCHEMA_V2);
				if (version < 3) migrateModelContexts(this.db);
			})();
	}
	save(session: SessionRecord): void {
		session.updatedAt = Date.now();
		this.db
			.query(
				"INSERT INTO sessions(id,parent_id,updated_at,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data",
			)
			.run(session.id, session.parentId ?? null, session.updatedAt, JSON.stringify(session));
	}
	get(id: string): SessionRecord | undefined {
		const row = this.db.query<{ data: string }, [string]>("SELECT data FROM sessions WHERE id=?").get(id);
		return row ? decode(row.data, sessionSchema) : undefined;
	}
	children(parentId: string): SessionRecord[] {
		return this.db
			.query<{ data: string }, [string]>("SELECT data FROM sessions WHERE parent_id=? ORDER BY updated_at")
			.all(parentId)
			.map((row) => decode(row.data, sessionSchema));
	}
	list(): SessionInfo[] {
		return this.db
			.query<{ data: string }, []>(
				"SELECT data FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC",
			)
			.all()
			.map((row) => {
				const s = this.legacy ? decode(row.data, legacySessionSchema) : decode(row.data, sessionSchema);
				return {
					id: s.id,
					title: s.title,
					updatedAt: s.updatedAt,
					cwd: s.cwd,
					provider: s.selection.provider,
					model: s.selection.model,
				};
			});
	}
	/**
	 * Entries that do not name their model yet are stamped with the one selected
	 * now; everything else, provider-signed payloads included, is stored as given.
	 */
	append(session: SessionRecord, ...entries: HistoryEntry[]): StoredEntry[] {
		return this.db.transaction(() => {
			let origin: ModelChoice | undefined;
			const rows = entries.map((entry) => {
				if (!entry.origin) {
					origin ??= { ...session.selection };
					entry.origin = origin;
				}
				const result = this.db
					.query("INSERT INTO entries(session_id,id,data) VALUES(?,?,?)")
					.run(session.id, entry.id, JSON.stringify(entry));
				return { seq: Number(result.lastInsertRowid), entry };
			});
			this.save(session);
			return rows;
		})();
	}
	history(id: string, after = 0, limit = 1000000): StoredEntry[] {
		return this.db
			.query<{ seq: number; data: string }, [string, number, number]>(
				"SELECT seq,data FROM entries WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?",
			)
			.all(id, after, limit)
			.map((row) => ({ seq: row.seq, entry: decode(row.data, historySchema) }));
	}
	search(id: string, text: string, limit: number): { seq: number; role: string; snippet: string }[] {
		const found: { seq: number; role: string; snippet: string }[] = [];
		const query = text.toLocaleLowerCase();
		// Search only visible prose/tool arguments, never provider signatures,
		// hidden thinking or raw usage. Iterate lazily so a small limit stays cheap.
		for (const row of this.db
			.query<{ seq: number; data: string }, [string]>(
				"SELECT seq,data FROM entries WHERE session_id=? ORDER BY seq DESC",
			)
			.iterate(id)) {
			const entry = decode(row.data, historySchema);
			let visible: string;
			let role: string;
			if (entry.kind === "message") {
				const message = entry.message;
				role = message.role;
				visible = messageText(message);
				if (message.role === "assistant")
					visible += message.content
						.flatMap((block) =>
							block.type === "toolCall" && block.name !== "history_search"
								? [`\n${block.name} ${JSON.stringify(block.arguments)}`]
								: [],
						)
						.join("");
			} else {
				role = entry.kind;
				visible = entry.kind === "system" ? entry.text : entry.summary;
			}
			const at = visible.toLocaleLowerCase().indexOf(query);
			if (at < 0) continue;
			const start = Math.max(0, at - 160);
			const end = Math.min(visible.length, start + 640);
			found.push({
				seq: row.seq,
				role,
				snippet: `${start ? "…" : ""}${visible.slice(start, end)}${end < visible.length ? "…" : ""}`,
			});
			if (found.length >= limit) break;
		}
		return found;
	}
	send(id: string, sender: string, text: string): void {
		this.db.query("INSERT INTO inbox(session_id,sender,text) VALUES(?,?,?)").run(id, sender, text);
	}
	/** Called only inside the transaction that persists a completion's delivery. */
	private takeInbox(id: string, sender: string): boolean {
		return (
			this.db
				.query("UPDATE inbox SET delivered=1 WHERE session_id=? AND sender=? AND delivered=0")
				.run(id, sender).changes > 0
		);
	}
	/** Completion state and its one authoritative notification are committed together. */
	publishCompletion(session: SessionRecord, recipient: string, text: string): void {
		if (!session.completion) throw new Error("Cannot publish an absent completion");
		const sender = `completion:${session.completion.id}`;
		this.db.transaction(() => {
			this.save(session);
			this.send(recipient, sender, text);
		})();
	}
	/** Consumption and provider-result persistence share a transaction: a crash cannot lose both deliveries. */
	appendCompletion(
		session: SessionRecord,
		result: HistoryEntry,
		alreadyDelivered: HistoryEntry,
		sender: string,
	): StoredEntry[] {
		return this.db.transaction(() =>
			this.append(session, this.takeInbox(session.id, sender) ? result : alreadyDelivered),
		)();
	}
	/** Persist every nested wait result even when the cell did not display it. */
	appendEvalCompletions(
		session: SessionRecord,
		result: Extract<HistoryEntry, { kind: "message" }>,
		senders: string[],
	): StoredEntry[] {
		if (result.message.role !== "toolResult" || result.message.isError)
			throw new Error("Nested completions require a successful enclosing tool result");
		const message = result.message;
		return this.db.transaction(() => {
			const reports: string[] = [];
			for (const sender of senders) {
				const row = this.db
					.query<{ text: string }, [string, string]>(
						"SELECT text FROM inbox WHERE session_id=? AND sender=? AND delivered=0",
					)
					.get(session.id, sender);
				if (row && this.takeInbox(session.id, sender)) reports.push(row.text);
			}
			return this.append(session, {
				...result,
				message: {
					...message,
					content: [
						...message.content,
						...(reports.length
							? [
									{
										type: "text" as const,
										text: `Authoritative child completions received by this eval:\n${reports.join("\n\n")}`,
									},
								]
							: []),
					],
				},
			});
		})();
	}
	/** Authoritative child mail is still pending until delivery is persisted. */
	pendingCompletion(id: string, sender?: string): boolean {
		return sender === undefined
			? this.db
					.query<{ one: number }, [string]>(
						"SELECT 1 AS one FROM inbox WHERE session_id=? AND delivered=0 AND sender LIKE 'completion:%' LIMIT 1",
					)
					.get(id) !== null
			: this.db
					.query<{ one: number }, [string, string]>(
						"SELECT 1 AS one FROM inbox WHERE session_id=? AND delivered=0 AND sender=? LIMIT 1",
					)
					.get(id, sender) !== null;
	}
	/** Queues a user message for the session's next request boundary. */
	steer(id: string, text: string): void {
		this.send(id, STEERING, text);
	}
	/** Queued user messages not yet delivered, oldest first. */
	steering(id: string): string[] {
		return this.db
			.query<{ text: string }, [string, string]>(
				"SELECT text FROM inbox WHERE session_id=? AND delivered=0 AND sender=? ORDER BY id",
			)
			.all(id, STEERING)
			.map((row) => row.text);
	}
	/** Whether any mail, user or agent, is waiting for delivery. */
	pending(id: string): boolean {
		return (
			this.db
				.query<{ one: number }, [string]>(
					"SELECT 1 AS one FROM inbox WHERE session_id=? AND delivered=0 LIMIT 1",
				)
				.get(id) !== null
		);
	}
	/**
	 * Delivers queued mail one message at a time so `beforeAppend` can see the
	 * exact sequence preceding each one. The caller's in-memory history is not
	 * updated until this returns, so that sequence cannot be derived outside.
	 *
	 * A queued user message becomes an ordinary user turn; everything else is
	 * attributed agent mail. Without `steering`, user messages stay queued —
	 * an idle session holds them for the user's next explicit send — while
	 * the mail around them is still delivered.
	 */
	deliver(
		session: SessionRecord,
		beforeAppend?: (entry: HistoryEntry, beforeSeq: number) => void,
		steering = true,
	): StoredEntry[] {
		return this.db.transaction(() => {
			const messages = steering
				? this.db
						.query<InboxMessage, [string]>(
							"SELECT id,sender,text FROM inbox WHERE session_id=? AND delivered=0 ORDER BY id",
						)
						.all(session.id)
				: this.db
						.query<InboxMessage, [string, string]>(
							"SELECT id,sender,text FROM inbox WHERE session_id=? AND delivered=0 AND sender<>? ORDER BY id",
						)
						.all(session.id, STEERING);
			if (!messages.length) return [];
			let previous =
				this.db
					.query<{ seq: number | null }, [string]>("SELECT MAX(seq) AS seq FROM entries WHERE session_id=?")
					.get(session.id)?.seq ?? 0;
			const delivered = this.db.query("UPDATE inbox SET delivered=1 WHERE id=?");
			const rows: StoredEntry[] = [];
			for (const message of messages) {
				const entry: HistoryEntry = {
					id: crypto.randomUUID(),
					kind: "message",
					message:
						message.sender === STEERING
							? { role: "user", content: message.text, timestamp: Date.now() }
							: {
									role: "user",
									synthetic: true,
									attribution: "agent",
									content: `[Agent message from ${message.sender}]\n${message.text}`,
									timestamp: Date.now(),
								},
				};
				beforeAppend?.(entry, previous);
				const stored = this.append(session, entry);
				rows.push(...stored);
				previous = stored[stored.length - 1]!.seq;
				delivered.run(message.id);
			}
			return rows;
		})();
	}
	worktrees(): WorktreeRecord[] {
		return this.db
			.query<{ data: string }, []>("SELECT data FROM worktrees")
			.all()
			.map((row) => decode(row.data, worktreeSchema));
	}
	worktreeSave(record: WorktreeRecord): void {
		this.db.query("INSERT INTO worktrees(id,data) VALUES(?,?)").run(record.id, JSON.stringify(record));
	}
	worktreeDelete(id: string): void {
		this.db.query("DELETE FROM worktrees WHERE id=?").run(id);
	}

	/**
	 * Freezes the session as it stands immediately before `id` is appended.
	 * Capturing first is what makes the point restorable: once the entry exists
	 * the notebook, tool set and instructions it changed can no longer be
	 * recovered from the transcript.
	 */
	captureCheckpoint(
		session: SessionRecord,
		beforeSeq: number,
		id: string,
		prompt: string,
		kind: RewindPoint["kind"],
	): CheckpointRecord {
		const createdAt = Date.now();
		const state = JSON.stringify(session);
		this.db
			.query(
				"INSERT INTO checkpoints(session_id,id,kind,before_seq,created_at,prompt,state) VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id,id) DO NOTHING",
			)
			.run(session.id, id, kind, beforeSeq, createdAt, prompt, state);
		const frozen = decode(state, sessionSchema);
		return {
			id,
			kind,
			prompt,
			createdAt,
			files: 0,
			filesAvailable: true,
			selection: pointSelection(kind, frozen, undefined),
			sessionId: session.id,
			beforeSeq,
			state: frozen,
		};
	}

	/** Owning session of a checkpoint, for tool calls that only know its id. */
	checkpointOwner(id: string): { sessionId: string; beforeSeq: number } | undefined {
		const row = this.db
			.query<{ session_id: string; before_seq: number }, [string]>(
				"SELECT session_id,before_seq FROM checkpoints WHERE id=?",
			)
			.get(id);
		return row ? { sessionId: row.session_id, beforeSeq: row.before_seq } : undefined;
	}

	/**
	 * Every rewind point of a session, oldest first.
	 *
	 * Recorded checkpoints are authoritative and are listed verbatim. History
	 * older than the first recorded checkpoint is still offered, reconstructed
	 * from the transcript alone — those points can rewind the conversation but
	 * never claim to restore files, because nothing captured what the files
	 * looked like then.
	 */
	checkpoints(sessionId: string): CheckpointRecord[] {
		const session = this.get(sessionId);
		if (!session) return [];
		const rows = this.db
			.query<CheckpointRow, [string]>(
				"SELECT ord,id,kind,before_seq,created_at,prompt,state FROM checkpoints WHERE session_id=? ORDER BY ord",
			)
			.all(sessionId);
		const recordedIds = new Set(rows.map((row) => row.id));
		const firstRecorded = rows.length ? rows[0]!.before_seq : Number.POSITIVE_INFINITY;

		const root = session.contexts[0]!;
		const messages = new Map<string, HistoryEntry>();
		const legacy: CheckpointRecord[] = [];
		let activeTools = session.tools.filter((tool) => !tool.deferred).map((tool) => tool.name);
		let firstUserText = "";
		let previousSeq = 0;
		for (const row of this.history(sessionId)) {
			const entry = row.entry;
			if (entry.kind === "message") {
				messages.set(entry.id, entry);
				const kind = pointKind(entry.message);
				if (kind && previousSeq < firstRecorded && !recordedIds.has(entry.id))
					legacy.push({
						id: entry.id,
						kind,
						prompt: label(entry.message),
						createdAt: entry.message.timestamp,
						files: 0,
						filesAvailable: false,
						selection: entry.origin ?? root.selection,
						sessionId,
						beforeSeq: previousSeq,
						state: {
							...session,
							id: sessionId,
							parentId: undefined,
							agent: undefined,
							selection: root.selection,
							activeTools: [...activeTools],
							firstUserText,
							// The notebook and the context window at that moment are not
							// recoverable, and guessing them would import text the rewound
							// conversation had not produced yet. Only the first model's
							// identity predates recorded checkpoints.
							notebook: "",
							contexts: [
								{
									selection: root.selection,
									sessionId: root.sessionId,
									cacheKey: root.cacheKey,
									contextStart: 0,
									tokens: 0,
								},
							],
							instructions: session.instructions.filter((text) => session.system.includes(text)),
						},
					});
				if (!firstUserText && entry.message.role === "user" && !entry.message.synthetic)
					firstUserText = messageText(entry.message);
			} else if (entry.kind === "system") {
				if (entry.addTools) activeTools = [...new Set([...activeTools, ...entry.addTools])];
				if (entry.removeTools) {
					const removed = entry.removeTools;
					activeTools = activeTools.filter((name) => !removed.includes(name));
				}
			}
			previousSeq = row.seq;
		}

		const points = [
			...legacy,
			...rows.map((row) => {
				const kind = pointKindOf(row.kind);
				const state = decode(row.state, sessionSchema);
				return {
					id: row.id,
					kind,
					prompt: row.prompt,
					createdAt: row.created_at,
					files: 0,
					filesAvailable: true,
					selection: pointSelection(kind, state, messages.get(row.id)),
					sessionId,
					beforeSeq: row.before_seq,
					state,
				};
			}),
		];

		// Each point reports the tracked paths a rewind to it would touch: every
		// mutation captured at that point or later in capture order.
		const touched = this.db
			.query<{ ord: number; path: string }, [string]>(
				"SELECT c.ord AS ord,m.path AS path FROM mutations m JOIN checkpoints c ON c.session_id=m.session_id AND c.id=m.checkpoint_id WHERE m.session_id=? AND m.status<>'reverted' ORDER BY c.ord DESC",
			)
			.all(sessionId);
		const ords = new Map(rows.map((row) => [row.id, row.ord]));
		const seen = new Set<string>();
		let cursor = 0;
		for (let index = points.length - 1; index >= 0; index--) {
			const point = points[index]!;
			const from = ords.get(point.id) ?? 0;
			while (cursor < touched.length && touched[cursor]!.ord >= from) seen.add(touched[cursor++]!.path);
			point.files = seen.size;
		}
		return points;
	}

	checkpoint(sessionId: string, id: string): CheckpointRecord | undefined {
		return this.checkpoints(sessionId).find((point) => point.id === id);
	}

	/**
	 * Branches the retained prefix into a brand new main session. The original
	 * is never truncated: rewinding is always additive, so a fork can be
	 * abandoned and the session it came from resumed intact.
	 *
	 * Entry ids are remapped because they are globally unique, while everything
	 * the provider signed — tool call ids, thinking signatures, compaction
	 * payloads — and each entry's origin are copied byte for byte. Dangling tool
	 * calls at the cut are left dangling on purpose: the runtime's own loader
	 * answers them with explicit interruption results rather than replaying
	 * side effects.
	 *
	 * Every model context is frozen as it stood at the point. Cache keys are
	 * inherited unchanged, since the branch replays the same prefix, while each
	 * transport identity is replaced by one fresh id per branch, the same in the
	 * fork and in every checkpoint copied into it. The cached-head seed is the
	 * source session's own, even when the cut precedes the user message it came
	 * from: the branch then has no first user text but keeps the same head, and
	 * stays unseeded only if the source never built a request.
	 */
	forkCheckpoint(sessionId: string, checkpointId: string): SessionRecord {
		const point = this.checkpoint(sessionId, checkpointId);
		if (!point) throw new Error(`Unknown rewind point ${checkpointId} in session ${sessionId}`);
		const prefix = this.history(sessionId).filter((row) => row.seq <= point.beforeSeq);
		const rows = this.db
			.query<CheckpointRow, [string]>(
				"SELECT ord,id,kind,before_seq,created_at,prompt,state FROM checkpoints WHERE session_id=? ORDER BY ord",
			)
			.all(sessionId);
		const cut = rows.find((row) => row.id === checkpointId)?.ord ?? 0;
		// A point exists only for a stored session.
		const cacheFirstUserText = this.get(sessionId)!.cacheFirstUserText;
		return this.db.transaction(() => {
			const fork: SessionRecord = {
				...point.state,
				id: crypto.randomUUID(),
				cacheFirstUserText,
				updatedAt: Date.now(),
			};
			fork.parentId = undefined;
			fork.agent = undefined;
			this.save(fork);

			const ids = new Map<string, string>();
			const seqs: { old: number; fresh: number }[] = [];
			const insert = this.db.query("INSERT INTO entries(session_id,id,data) VALUES(?,?,?)");
			for (const row of prefix) {
				const id = crypto.randomUUID();
				ids.set(row.entry.id, id);
				const result = insert.run(fork.id, id, JSON.stringify({ ...row.entry, id }));
				seqs.push({ old: row.seq, fresh: Number(result.lastInsertRowid) });
			}
			const last = seqs.length ? seqs[seqs.length - 1]!.fresh : 0;
			const remapStart = (value: number): number => {
				const index = seqs.findIndex((pair) => pair.old >= value);
				// Nothing retained precedes the window, so it spans the whole branch.
				if (index === 0 || !seqs.length) return 0;
				return index < 0 ? last + 1 : seqs[index]!.fresh;
			};
			// The source session's own id doubles as its first model's transport;
			// the branch keeps that convention with its own id.
			const transports = new Map<string, string>([[sessionId, fork.id]]);
			const remapContext = (context: ModelContext): ModelContext => {
				let transport = transports.get(context.sessionId);
				if (!transport) {
					transport = crypto.randomUUID();
					transports.set(context.sessionId, transport);
				}
				const copy: ModelContext = {
					...context,
					sessionId: transport,
					cacheBoundary: context.cacheBoundary === undefined ? undefined : ids.get(context.cacheBoundary),
				};
				if (context.compactionId === undefined) {
					copy.contextStart = remapStart(context.contextStart);
					if (!copy.contextStart) copy.notebook = undefined;
					return copy;
				}
				copy.compactionId = ids.get(context.compactionId);
				if (copy.compactionId) copy.contextStart = remapStart(context.contextStart);
				else {
					// A summary that did not make the cut cannot stand in for the
					// history it replaced, so the whole retained prefix becomes this
					// model's live window again, measured afresh.
					copy.contextStart = 0;
					copy.notebook = undefined;
					copy.restoreControls = undefined;
					copy.tokens = 0;
				}
				return copy;
			};
			const remapState = (state: SessionRecord): SessionRecord => {
				const copy: SessionRecord = {
					...state,
					id: fork.id,
					cacheFirstUserText,
					contexts: state.contexts.map(remapContext),
				};
				copy.parentId = undefined;
				copy.agent = undefined;
				return copy;
			};
			fork.contexts = point.state.contexts.map(remapContext);
			this.save(fork);

			const addPoint = this.db.query(
				"INSERT INTO checkpoints(session_id,id,kind,before_seq,created_at,prompt,state) VALUES(?,?,?,?,?,?,?)",
			);
			const addMutation = this.db.query(
				"INSERT INTO mutations(session_id,checkpoint_id,path,status,data,after) VALUES(?,?,?,?,?,?)",
			);
			const sources = this.db.query<
				{ id: number; path: string; status: string; data: string; after: string | null },
				[string, string]
			>("SELECT id,path,status,data,after FROM mutations WHERE session_id=? AND checkpoint_id=? ORDER BY id");
			for (const row of rows) {
				if (row.ord >= cut || row.before_seq > point.beforeSeq) continue;
				// Points whose entry lives in a child session have nothing to remap
				// against, but they still name a real boundary in this prefix.
				const freshId = ids.get(row.id) ?? crypto.randomUUID();
				let before = 0;
				for (const pair of seqs) {
					if (pair.old > row.before_seq) break;
					before = pair.fresh;
				}
				addPoint.run(
					fork.id,
					freshId,
					row.kind,
					before,
					row.created_at,
					row.prompt,
					JSON.stringify(remapState(decode(row.state, sessionSchema))),
				);
				for (const mutation of sources.all(sessionId, row.id)) {
					const record = decode(mutation.data, mutationSchema);
					record.sessionId = fork.id;
					record.checkpointId = freshId;
					addMutation.run(
						fork.id,
						freshId,
						mutation.path,
						mutation.status,
						JSON.stringify(record),
						mutation.after,
					);
				}
			}
			return fork;
		})();
	}

	recordUsage(sessionId: string, kind: AuxUsageRecord["kind"], usage: Usage, selection: ModelChoice): void {
		const record: AuxUsageRecord = { kind, usage, selection, timestamp: Date.now() };
		this.db
			.query("INSERT INTO aux_usage(session_id,data) VALUES(?,?)")
			.run(sessionId, JSON.stringify(record));
	}
	extraUsage(sessionId: string): AuxUsageRecord[] {
		return this.db
			.query<{ data: string }, [string]>("SELECT data FROM aux_usage WHERE session_id=? ORDER BY id")
			.all(sessionId)
			.map((row) => decode(row.data, auxUsageSchema));
	}

	recordMutation(input: FileMutationInput): number {
		const result = this.db
			.query("INSERT INTO mutations(session_id,checkpoint_id,path,status,data) VALUES(?,?,?,'pending',?)")
			.run(input.sessionId, input.checkpointId, input.path, JSON.stringify(input));
		return Number(result.lastInsertRowid);
	}
	settleMutation(id: number, status: MutationStatus, after?: FileSnapshot): void {
		this.db
			.query("UPDATE mutations SET status=?,after=? WHERE id=?")
			.run(status, after ? JSON.stringify(after) : null, id);
	}
	revertMutations(ids: number[]): void {
		if (!ids.length) return;
		this.db.transaction(() => {
			const update = this.db.query("UPDATE mutations SET status='reverted' WHERE id=?");
			for (const id of ids) update.run(id);
		})();
	}
	/** Every still-live mutation captured at `checkpointId` or later. */
	mutationsFrom(sessionId: string, checkpointId: string): FileMutation[] {
		const from =
			this.db
				.query<{ ord: number }, [string, string]>("SELECT ord FROM checkpoints WHERE session_id=? AND id=?")
				.get(sessionId, checkpointId)?.ord ?? 0;
		return this.db
			.query<{ id: number; status: string; data: string; after: string | null }, [string, number]>(
				"SELECT m.id AS id,m.status AS status,m.data AS data,m.after AS after FROM mutations m JOIN checkpoints c ON c.session_id=m.session_id AND c.id=m.checkpoint_id WHERE m.session_id=? AND c.ord>=? AND m.status<>'reverted' ORDER BY m.id",
			)
			.all(sessionId, from)
			.map((row) => ({
				...decode(row.data, mutationSchema),
				id: row.id,
				status: mutationStatus(row.status),
				...(row.after ? { after: decode(row.after, snapshotSchema) } : {}),
			}));
	}

	hasBlob(hash: string): boolean {
		return (
			this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM blobs WHERE hash=?").get(hash) !== null
		);
	}
	putBlob(hash: string, bytes: Uint8Array): void {
		this.db.query("INSERT INTO blobs(hash,bytes) VALUES(?,?) ON CONFLICT(hash) DO NOTHING").run(hash, bytes);
	}
	blob(hash: string): Uint8Array | undefined {
		const row = this.db
			.query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM blobs WHERE hash=?")
			.get(hash);
		return row?.bytes;
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			this.db.close();
		}
	}
}

function pointKindOf(value: string): RewindPoint["kind"] {
	if (value === "user" || value === "assistant" || value === "tool" || value === "agent") return value;
	throw new Error(`Unknown persisted rewind point kind: ${value}`);
}
