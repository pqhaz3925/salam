import { MacOSScrollAccel, StyledText, decodePasteBytes, stripAnsiSequences } from "@opentui/core";
import type {
	KeyEvent,
	MouseEvent,
	PasteEvent,
	ScrollBoxRenderable,
	SelectOption,
	Selection,
	TextareaRenderable,
} from "@opentui/core";
import {
	useKeyboard,
	usePaste,
	useRenderer,
	useSelectionHandler,
	useTerminalDimensions,
} from "@opentui/solid";
import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { REASONING_LEVELS } from "../contracts.ts";
import type {
	AppController,
	AppSnapshot,
	ModelChoice,
	PendingQuestion,
	RewindPoint,
	SessionInfo,
	SubmissionMode,
	UserQuestion,
} from "../contracts.ts";
import { suggestCommands } from "./commands.ts";
import { OverlayHeading, Picker, buildAgentsText, buildSuggestionText } from "./overlays.tsx";
import { buildActivityText, buildFooterText } from "./status.ts";
import { StyledLine } from "./styled.tsx";
import { accent, faint, glyph, muted, palette, plain, rule, spinnerFrames, user, warn } from "./theme.ts";
import { formatElapsed, formatWhen, truncate } from "./text.ts";
import { ConversationRows } from "./transcript.tsx";
import { modelTag } from "./blocks.tsx";
import { buildQuestionText, questionKeys, resolveAnswer } from "./question.ts";
import type { QuestionCursor } from "./question.ts";
import { buildTodoLine, buildTodoRows, todoProgress } from "./todo.ts";
import type { Transcript } from "./transcript.tsx";

type Overlay = "model" | "effort" | "resume" | "rewind" | "rewind-mode" | "agents" | "todo" | null;

/** Idle key hints, most important first; the activity row drops trailing ones on narrow terminals. */
const IDLE_KEYS = ["enter send", "/ commands", "ctrl+o tool output", "shift+enter newline", "drag to copy"];
const EXIT_ARM_MS = 2500;
const HINT_MS = 3000;

/** Enter submits; the editor keeps newline on the shifted and alt variants. */
const composerKeyBindings = [
	{ name: "return", shift: true, action: "newline" as const },
	{ name: "kpenter", shift: true, action: "newline" as const },
	{ name: "return", meta: true, action: "newline" as const },
	{ name: "kpenter", meta: true, action: "newline" as const },
];

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function App(props: {
	controller: AppController;
	transcript: Transcript;
	snapshot: Accessor<AppSnapshot>;
	home: string;
	exit: () => void;
	/** Puts text on the system clipboard; resolves to the status line to flash. */
	copy: (text: string) => Promise<string>;
}) {
	const dimensions = useTerminalDimensions();
	const renderer = useRenderer();
	// One shared curve so quick wheel/trackpad streaks accelerate across events.
	const wheelAcceleration = new MacOSScrollAccel();

	let conversation: ScrollBoxRenderable | undefined;
	let input: TextareaRenderable | undefined;
	let exitArmed = false;
	let exitTimer: Timer | undefined;
	let hintTimer: Timer | undefined;
	let spinTimer: Timer | undefined;
	let busyStart = 0;
	let historyIndex = 0;
	let draft = "";
	let shownSession: string | undefined;
	const history: string[] = [];
	/** The composer draft set aside while the composer answers a question. */
	let stashedDraft: string | undefined;
	/** Answers collected for the pending question's earlier sub-questions. */
	let questionAnswers: Record<string, string | string[]> = {};

	const [buffer, setBuffer] = createSignal("");
	const [suggestIndex, setSuggestIndex] = createSignal(0);
	const [overlay, setOverlay] = createSignal<Overlay>(null);
	const [pickerOptions, setPickerOptions] = createSignal<SelectOption[]>([]);
	const [pickerValues, setPickerValues] = createSignal<string[]>([]);
	const [pickerIndex, setPickerIndex] = createSignal(0);
	const [sessionChoices, setSessionChoices] = createSignal<SessionInfo[]>([]);
	const [rewindChoices, setRewindChoices] = createSignal<RewindPoint[]>([]);
	const [rewindPoint, setRewindPoint] = createSignal<RewindPoint>();
	const [hint, setHint] = createSignal("");
	const [secret, setSecret] = createSignal("");
	const [tick, setTick] = createSignal(0);
	/** Wall time of the last run that finished in the shown session; cleared when a run starts. */
	const [completedMs, setCompletedMs] = createSignal<number>();
	const [todoOffset, setTodoOffset] = createSignal(0);
	const [questionIndex, setQuestionIndex] = createSignal(0);
	const [questionCursor, setQuestionCursor] = createSignal<QuestionCursor>({ focus: 0, picked: [] });
	/** A question already answered or cancelled here, hidden until the runtime publishes the next one. */
	const [settledQuestion, setSettledQuestion] = createSignal<string>();

	const width = () => Math.max(1, dimensions().width);
	const question = createMemo(() => {
		const pending = props.snapshot().question;
		return pending && pending.id !== settledQuestion() ? pending : undefined;
	});
	const currentQuestion = () => question()?.questions[questionIndex()];
	const todo = createMemo(() => todoProgress(props.snapshot().todos));
	const todoLine = createMemo(() => {
		const progress = todo();
		return progress && dimensions().height >= 8 ? buildTodoLine(progress, width()) : null;
	});
	const detailRows = () => (dimensions().height >= 14 ? 3 : dimensions().height >= 10 ? 1 : 0);
	const steeringRows = () => (props.snapshot().steering.length > 0 && dimensions().height >= 8 ? 1 : 0);
	const overlayRows = () =>
		Math.max(
			1,
			Math.min(
				10,
				dimensions().height - composerRows() - detailRows() - steeringRows() - (todoLine() ? 1 : 0) - 7,
			),
		);
	const composerRows = () => Math.max(1, Math.min(6, Math.floor(dimensions().height / 4)));
	const secretMode = () => props.snapshot().inputMode === "secret";
	const suggestions = createMemo(() =>
		overlay() === null && !secretMode() && !question() ? suggestCommands(buffer()) : [],
	);
	const modelLabel = () => `${props.snapshot().selection.provider}/${props.snapshot().selection.model}`;
	const separator = createMemo(() => new StyledText([rule(glyph.rule.repeat(width()))]));
	const footerText = createMemo(() =>
		buildFooterText(props.snapshot(), {
			width: width(),
			home: props.home,
			expanded: props.transcript.expanded(),
		}),
	);
	/** A main-session shell command is still running in the foreground of the latest turn. */
	const shellRunning = createMemo(() => {
		const items = props.snapshot().items;
		for (let i = items.length - 1; i >= 0; i -= 1) {
			const item = items[i];
			if (item.kind === "user") return false;
			if (item.kind === "tool" && item.name === "shell" && item.state === "running") return true;
		}
		return false;
	});

	const steeringText = createMemo(() => {
		const queued = props.snapshot().steering;
		if (queued.length === 0) return null;
		const label = `${queued.length} queued`;
		const latest = queued[queued.length - 1].replace(/\s+/g, " ");
		const room = width() - label.length - 5;
		return new StyledText([
			warn(`${glyph.caret} ${label}`),
			...(room > 0 ? [faint(` ${glyph.sep} ${truncate(latest, room)}`)] : []),
		]);
	});

	const spinnerFrame = () => spinnerFrames[tick() % spinnerFrames.length];

	/** Keys that matter in the current state, most important first. */
	const keyHints = (): readonly string[] => {
		if (secretMode()) return ["input hidden", "enter send", "esc cancel"];
		if (overlay() !== null || question() || dimensions().height < 12) return [];
		if (suggestions().length > 0) return ["\u2191\u2193 select", "tab complete", "enter run"];
		const drafting = buffer().length > 0;
		if (!props.snapshot().busy) {
			if (drafting) return ["enter send", "shift+enter newline", "esc clear"];
			// The primer is only needed before the first completed run.
			return completedMs() === undefined ? IDLE_KEYS : [];
		}
		const keys = drafting ? ["enter queue", "ctrl+enter interrupt + send"] : [];
		if (shellRunning()) keys.push("ctrl+b background shell");
		keys.push("esc interrupt");
		return keys;
	};

	const activityText = createMemo(() => {
		tick();
		return buildActivityText(props.snapshot(), {
			width: width(),
			spinnerFrame: spinnerFrame(),
			elapsedMs: busyStart === 0 ? 0 : Date.now() - busyStart,
			notice: hint(),
			keys: keyHints(),
		});
	});

	function flashHint(message: string): void {
		setHint(message);
		clearTimeout(hintTimer);
		hintTimer = setTimeout(() => {
			hintTimer = undefined;
			setHint("");
		}, HINT_MS);
	}

	function armExit(): void {
		exitArmed = true;
		clearTimeout(exitTimer);
		exitTimer = setTimeout(() => {
			exitTimer = undefined;
			exitArmed = false;
		}, EXIT_ARM_MS);
	}

	// Native edit notifications can trail a packet containing both text and a
	// command key. Actions read the editor; rendering tracks the buffer signal.
	const readComposer = () => input?.plainText ?? buffer();

	function writeComposer(value: string): void {
		setBuffer(value);
		if (input === undefined) return;
		input.setText(value);
		input.cursorOffset = value.length;
	}

	function closeOverlay(): void {
		setOverlay(null);
		setPickerOptions([]);
		setPickerValues([]);
		setPickerIndex(0);
		setRewindPoint(undefined);
	}

	function copyText(text: string): void {
		void props.copy(text).then(flashHint);
	}

	/** Answers (or, with no answers, cancels) the pending question; the task itself keeps running. */
	function settleQuestion(pending: PendingQuestion, answers: Record<string, string | string[]>): void {
		setSettledQuestion(pending.id);
		props.controller.answerQuestion(pending.id, answers).catch((error: unknown) => {
			props.transcript.notice(describe(error), true);
			// A refused answer leaves the question pending, so offer it again.
			if (settledQuestion() === pending.id) setSettledQuestion(undefined);
		});
	}

	const questionTitle = () => {
		const pending = question();
		if (!pending) return "";
		const count = pending.questions.length > 1 ? ` ${questionIndex() + 1}/${pending.questions.length}` : "";
		const agent =
			pending.agentId === "main"
				? undefined
				: (props.snapshot().agents.find((entry) => entry.id === pending.agentId)?.name ?? "agent");
		return `question${count}${agent ? ` ${glyph.sep} ${agent}` : ""}`;
	};

	/** The whole todo list, pre-wrapped so the overlay can scroll it row by row. */
	const todoRows = createMemo(() =>
		overlay() === "todo" ? buildTodoRows(props.snapshot().todos ?? [], width()) : [],
	);
	const todoStart = () => Math.min(todoOffset(), Math.max(0, todoRows().length - overlayRows()));
	const todoView = createMemo(() => {
		const rows = todoRows().slice(todoStart(), todoStart() + overlayRows());
		return new StyledText(rows.flatMap((row, index) => (index === 0 ? row : [plain("\n"), ...row])));
	});
	const todoHeading = () => {
		const counted = (props.snapshot().todos ?? []).filter((item) => item.status !== "abandoned");
		const done = counted.filter((item) => item.status === "completed").length;
		const total = todoRows().length;
		const room = overlayRows();
		return {
			title: counted.length > 0 ? `todo ${done}/${counted.length}` : "todo",
			hint:
				total > room
					? `${todoStart() + 1}-${Math.min(total, todoStart() + room)} of ${total} ${glyph.sep} \u2191\u2193 scroll ${glyph.sep} esc close`
					: "esc to close",
		};
	};

	function scrollTodo(delta: number): void {
		setTodoOffset(Math.max(0, Math.min(todoStart() + delta, todoRows().length - overlayRows())));
	}

	function historyPrev(): void {
		if (history.length === 0) return;
		if (historyIndex === history.length) draft = readComposer();
		if (historyIndex === 0) return;
		historyIndex -= 1;
		writeComposer(history[historyIndex]);
	}

	function historyNext(): void {
		if (historyIndex >= history.length) return;
		historyIndex += 1;
		writeComposer(historyIndex === history.length ? draft : history[historyIndex]);
	}

	async function openModelPicker(): Promise<void> {
		setOverlay("model");
		try {
			const models = await props.controller.models();
			if (overlay() !== "model") return;
			if (models.length === 0) {
				closeOverlay();
				props.transcript.notice("no models available", true);
				return;
			}
			const current = modelLabel();
			const nameWidth = models.reduce(
				(max, choice) => Math.max(max, `${choice.provider}/${choice.model}`.length),
				0,
			);
			setPickerIndex(
				Math.max(
					0,
					models.findIndex((choice) => `${choice.provider}/${choice.model}` === current),
				),
			);
			setPickerValues(models.map((choice: ModelChoice) => `${choice.provider}/${choice.model}`));
			setPickerOptions(
				models.map((choice: ModelChoice) => {
					const value = `${choice.provider}/${choice.model}`;
					const suffix =
						choice.label ?? (choice.contextWindow ? `${Math.round(choice.contextWindow / 1000)}k ctx` : "");
					const marker = value === current ? " *" : "  ";
					return {
						name: `${value.padEnd(nameWidth)}${marker} ${truncate(suffix, Math.max(0, width() - nameWidth - 8))}`,
						description: "",
					};
				}),
			);
		} catch (error) {
			if (overlay() === "model") closeOverlay();
			props.transcript.notice(describe(error), true);
		}
	}

	function openEffortPicker(): void {
		setPickerValues([...REASONING_LEVELS]);
		setPickerOptions(
			REASONING_LEVELS.map((level) => ({
				name: `${level === props.snapshot().reasoning ? "* " : "  "}${level}`,
				description: "",
			})),
		);
		setPickerIndex(REASONING_LEVELS.indexOf(props.snapshot().reasoning));
		setOverlay("effort");
	}

	function openSessionPicker(): void {
		try {
			const sessions = props.controller.sessions();
			if (sessions.length === 0) {
				props.transcript.notice("no saved sessions", true);
				return;
			}
			const now = Date.now();
			setSessionChoices(sessions);
			setPickerIndex(
				Math.max(
					0,
					sessions.findIndex((session) => session.id === props.snapshot().sessionId),
				),
			);
			setPickerValues(sessions.map((session) => session.id));
			setPickerOptions(
				sessions.map((session) => {
					const when = formatWhen(session.updatedAt, now).padEnd(10);
					const title = truncate(session.title || session.id, Math.max(8, width() - 32));
					const marker = session.id === props.snapshot().sessionId ? "* " : "  ";
					return { name: `${marker}${when} ${title}`, description: "" };
				}),
			);
			setOverlay("resume");
		} catch (error) {
			props.transcript.notice(describe(error), true);
		}
	}

	function openRewindPicker(): void {
		try {
			const points = props.controller.checkpoints();
			if (points.length === 0) {
				props.transcript.notice("no rewindable events in this session", false);
				return;
			}
			setRewindChoices(points);
			setPickerValues(points.map((point) => point.id));
			setPickerOptions(
				points.map((point) => {
					const tag = modelTag(point.selection);
					return {
						name: `[${point.kind}]${tag.length > 0 ? ` ${tag}` : ""} ${point.files} files${point.filesAvailable ? "" : " (unavailable)"}  ${glyph.sep}  ${point.prompt.replace(/\s+/g, " ")}`,
						description: "",
					};
				}),
			);
			setPickerIndex(0);
			setOverlay("rewind");
		} catch (error) {
			props.transcript.notice(describe(error), true);
		}
	}

	function choose(index: number): void {
		const kind = overlay();
		const value = pickerValues()[index];
		if (value === undefined || kind === null || kind === "agents") return;
		if (kind === "rewind") {
			const point = rewindChoices()[index];
			if (!point) return;
			setRewindPoint(point);
			setPickerValues(["conversation", "files", "both"]);
			const unavailable = point.filesAvailable ? "" : " — unavailable";
			setPickerOptions([
				{ name: "conversation — fork history; keep current files", description: "" },
				{ name: `files${unavailable} — restore tracked files; keep conversation`, description: "" },
				{ name: `both${unavailable} — fork history and restore tracked files`, description: "" },
			]);
			setPickerIndex(0);
			setOverlay("rewind-mode");
			return;
		}
		let line: string;
		if (kind === "rewind-mode") {
			const point = rewindPoint();
			if (!point || (value !== "conversation" && !point.filesAvailable)) {
				flashHint("file restore unavailable for this checkpoint");
				return;
			}
			line = `/rewind ${point.id} ${value}`;
		} else {
			line =
				kind === "model" ? `/model ${value}` : kind === "effort" ? `/effort ${value}` : `/resume ${value}`;
		}
		closeOverlay();
		props.controller.command(line).catch((error: unknown) => props.transcript.notice(describe(error), true));
	}

	const pickerDetails = () => {
		if (overlay() === "effort")
			return "Saved for this session. Takes effect on the next provider request.\nAlready running requests and agents keep their effort; new agents inherit it.\nProviders may adapt reasoning to the task or not support it.";
		if (overlay() === "resume") {
			const session = sessionChoices()[pickerIndex()];
			return session
				? `${session.id === props.snapshot().sessionId ? "current · " : ""}${session.id}\n${session.cwd}\n${session.provider}/${session.model}`
				: "";
		}
		if (overlay() === "rewind" || overlay() === "rewind-mode") {
			const point = overlay() === "rewind" ? rewindChoices()[pickerIndex()] : rewindPoint();
			const tag = point ? modelTag(point.selection) : "";
			return point
				? `[${point.kind}]${tag.length > 0 ? ` ${tag}` : ""} ${point.id} · ${point.files} tracked files · ${formatWhen(point.createdAt, Date.now())}\n${point.prompt.replace(/\s+/g, " ")}\nShell, MCP and external edits are NOT rolled back.`
				: "";
		}
		return "";
	};

	async function runCommand(line: string): Promise<void> {
		const boundary = line.search(/\s/);
		const name = (boundary === -1 ? line : line.slice(0, boundary)).toLowerCase();
		const rest = boundary === -1 ? "" : line.slice(boundary + 1).trim();

		if (name === "/quit" || name === "/exit") {
			props.exit();
			return;
		}
		if (name === "/agents") {
			setOverlay("agents");
			return;
		}
		if (name === "/todo" && rest.length === 0) {
			setTodoOffset(0);
			setOverlay("todo");
			return;
		}
		if (name === "/model" && rest.length === 0) {
			await openModelPicker();
			return;
		}
		if (name === "/effort" && rest.length === 0) {
			openEffortPicker();
			return;
		}
		if (name === "/resume" && rest.length === 0) {
			openSessionPicker();
			return;
		}
		if (name === "/rewind" && rest.length === 0) {
			openRewindPicker();
			return;
		}
		try {
			await props.controller.command(line);
		} catch (error) {
			props.transcript.notice(describe(error), true);
		}
	}

	async function submit(mode: SubmissionMode = "steer"): Promise<void> {
		const text = readComposer();
		if (text.trim().length === 0) return;
		writeComposer("");
		setHint("");
		if (history[history.length - 1] !== text) history.push(text);
		historyIndex = history.length;
		draft = "";
		if (text.trimStart().startsWith("/")) {
			await runCommand(text.trim());
			return;
		}
		try {
			await props.controller.submit(text, mode);
		} catch (error) {
			props.transcript.notice(describe(error), true);
		}
	}

	function acceptSuggestion(run: boolean): void {
		const list = suggestCommands(readComposer());
		if (list.length === 0) return;
		const command = list[Math.min(suggestIndex(), list.length - 1)];
		if (run && (command.hint.length === 0 || command.name === readComposer())) {
			writeComposer("");
			void runCommand(command.name);
			return;
		}
		writeComposer(command.hint.length > 0 ? `${command.name} ` : command.name);
	}

	function handleSecretKey(key: KeyEvent): void {
		key.preventDefault();
		if (key.name === "return" || key.name === "kpenter") {
			const value = secret();
			setSecret("");
			if (value.length === 0) return;
			props.controller
				.submit(value)
				.catch((error: unknown) => props.transcript.notice(describe(error), true));
			return;
		}
		if (key.name === "escape" || (key.ctrl && key.name === "c")) {
			setSecret("");
			props.controller.cancel();
			return;
		}
		if (key.name === "backspace") {
			setSecret((value) => value.slice(0, -1));
			return;
		}
		if (key.ctrl && (key.name === "u" || key.name === "w")) {
			setSecret("");
			return;
		}
		if (key.ctrl || key.meta || key.super) return;
		if (key.name === "space") {
			setSecret((value) => `${value} `);
			return;
		}
		const first = key.sequence.charCodeAt(0);
		if (key.sequence.length === 0 || first < 32 || first === 127) return;
		setSecret((value) => value + key.sequence);
	}

	/**
	 * Keys owned by a pending question. The composer stays focused as the
	 * free-text answer box; returns true when the key must not reach the
	 * conversation handlers (history, submit, interrupt).
	 */
	function handleQuestionKey(key: KeyEvent, pending: PendingQuestion): boolean {
		const current = pending.questions[questionIndex()];
		if (!current) return false;
		const options = current.options ?? [];
		if (key.name === "escape") {
			key.preventDefault();
			settleQuestion(pending, {});
			flashHint("question cancelled");
			return true;
		}
		if (key.name === "up" || key.name === "down") {
			// Without options the arrows move the answer's cursor, never through history.
			if (options.length === 0) return true;
			key.preventDefault();
			const step = key.name === "up" ? -1 : 1;
			setQuestionCursor((cursor) => ({
				...cursor,
				focus: (cursor.focus + step + options.length) % options.length,
			}));
			return true;
		}
		if (key.name === "space" && current.multi && options.length > 0 && readComposer().length === 0) {
			key.preventDefault();
			setQuestionCursor((cursor) => ({
				...cursor,
				picked: cursor.picked.includes(cursor.focus)
					? cursor.picked.filter((index) => index !== cursor.focus)
					: [...cursor.picked, cursor.focus],
			}));
			return true;
		}
		const enter =
			((key.name === "return" || key.name === "kpenter") && !key.shift && !key.meta) ||
			(key.ctrl && key.name === "g");
		if (!enter) return false;
		key.preventDefault();
		const result = resolveAnswer(current, questionCursor(), readComposer());
		if ("hint" in result) {
			flashHint(result.hint);
			return true;
		}
		questionAnswers = { ...questionAnswers, [current.id]: result.answer };
		writeComposer("");
		if (questionIndex() + 1 < pending.questions.length) {
			setQuestionIndex((index) => index + 1);
			setQuestionCursor({ focus: 0, picked: [] });
		} else settleQuestion(pending, questionAnswers);
		return true;
	}

	function handleKey(key: KeyEvent): void {
		// Terminals that forward Cmd (kitty keyboard protocol) copy the UI selection;
		// macOS Terminal.app keeps Cmd+C for itself, so a finished drag copies too.
		if (key.super && key.name === "c") {
			key.preventDefault();
			const selected =
				renderer.getSelection()?.getSelectedText() || (input?.hasSelection() ? input.getSelectedText() : "");
			if (selected.length > 0) copyText(selected);
			else flashHint("nothing selected");
			return;
		}

		if (secretMode()) {
			handleSecretKey(key);
			return;
		}

		const snapshot = props.snapshot();

		if (key.ctrl && key.name === "c") {
			key.preventDefault();
			if (snapshot.busy) {
				props.controller.cancel();
				flashHint("interrupted");
				exitArmed = false;
				return;
			}
			if (readComposer().length > 0) {
				writeComposer("");
				flashHint("press ctrl+c again to exit");
				armExit();
				return;
			}
			if (exitArmed) {
				props.exit();
				return;
			}
			flashHint("press ctrl+c again to exit");
			armExit();
			return;
		}

		if (key.ctrl && key.name === "d") {
			if (readComposer().length > 0) return;
			key.preventDefault();
			props.exit();
			return;
		}

		if (key.ctrl && key.name === "o") {
			key.preventDefault();
			props.transcript.toggleExpanded();
			flashHint(props.transcript.expanded() ? "tool output expanded" : "tool output collapsed");
			return;
		}

		// While a turn runs, ctrl+b promotes its foreground shell command to a
		// background job; the turn, the draft and the queue are left untouched,
		// and the runtime posts its own notice naming the moved job. Idle, the
		// key stays the composer's cursor-left binding.
		if (key.ctrl && key.name === "b" && snapshot.busy) {
			key.preventDefault();
			if (!props.controller.background()) flashHint("nothing to background");
			return;
		}

		const open = overlay();
		if (open === "agents") {
			if (key.name === "escape" || key.name === "return" || key.name === "kpenter") {
				key.preventDefault();
				closeOverlay();
				return;
			}
			return;
		} else if (open === "todo") {
			key.preventDefault();
			if (key.name === "escape" || key.name === "return" || key.name === "kpenter") closeOverlay();
			else if (key.name === "up" || key.name === "down") scrollTodo(key.name === "up" ? -1 : 1);
			else if (key.name === "pageup" || key.name === "pagedown")
				scrollTodo((key.name === "pageup" ? -1 : 1) * overlayRows());
			else if (key.name === "home" || key.name === "end")
				scrollTodo((key.name === "home" ? -1 : 1) * todoRows().length);
			return;
		} else if (open !== null) {
			if (key.name === "escape") {
				key.preventDefault();
				closeOverlay();
			}
			return;
		}

		if (key.name === "pageup" || key.name === "pagedown") {
			key.preventDefault();
			conversation?.scrollBy(
				(key.name === "pageup" ? -1 : 1) * Math.max(1, (conversation?.viewport.height ?? 2) - 1),
			);
			return;
		}
		if (key.ctrl && key.name === "end") {
			key.preventDefault();
			conversation?.scrollTo(conversation.scrollHeight);
			return;
		}

		const pending = question();
		if (pending && handleQuestionKey(key, pending)) return;

		if (
			key.ctrl &&
			!key.shift &&
			!key.meta &&
			!key.super &&
			(key.name === "return" || key.name === "kpenter" || key.name === "g")
		) {
			key.preventDefault();
			void submit("interrupt");
			return;
		}

		const list = pending ? [] : suggestCommands(readComposer());
		if (list.length > 0) {
			if (key.name === "up") {
				key.preventDefault();
				setSuggestIndex((index) => (index - 1 + list.length) % list.length);
				return;
			}
			if (key.name === "down") {
				key.preventDefault();
				setSuggestIndex((index) => (index + 1) % list.length);
				return;
			}
			if (key.name === "tab") {
				key.preventDefault();
				acceptSuggestion(false);
				return;
			}
			if ((key.name === "return" || key.name === "kpenter") && !key.shift && !key.meta && !key.ctrl) {
				key.preventDefault();
				acceptSuggestion(true);
				return;
			}
		}

		if ((key.name === "return" || key.name === "kpenter") && !key.shift && !key.meta && !key.ctrl) {
			key.preventDefault();
			void submit("steer");
			return;
		}

		if (key.name === "escape") {
			key.preventDefault();
			if (snapshot.busy) {
				props.controller.cancel();
				flashHint("interrupted");
				return;
			}
			if (readComposer().length > 0) writeComposer("");
			return;
		}

		if (key.ctrl || key.meta || key.super) return;

		if (key.name === "up" && !key.shift && (input?.cursorOffset ?? 0) === 0) {
			key.preventDefault();
			historyPrev();
			return;
		}
		if (key.name === "down" && !key.shift && (input?.cursorOffset ?? 0) >= readComposer().length) {
			key.preventDefault();
			historyNext();
		}
	}

	useKeyboard((key: KeyEvent) => {
		try {
			handleKey(key);
		} catch (error) {
			props.transcript.notice(describe(error), true);
		}
	});

	usePaste((event: PasteEvent) => {
		if (!secretMode()) return;
		event.preventDefault();
		const text = stripAnsiSequences(decodePasteBytes(event.bytes)).replace(/[\r\n]+/g, "");
		setSecret((value) => value + text);
	});

	const unsubscribeDraft = props.controller.subscribe((event) => {
		if (event.type !== "draft") return;
		closeOverlay();
		draft = event.text;
		historyIndex = history.length;
		// The composer is answering a question; the restored draft returns with it.
		if (question()) stashedDraft = event.text;
		else writeComposer(event.text);
	});

	/**
	 * A question borrows the composer as its answer box: the draft is set aside
	 * when the first question appears and put back when none is pending, and
	 * each new question starts from its first sub-question with nothing picked.
	 */
	createEffect(
		on(
			() => question()?.id,
			(id, previous) => {
				setQuestionIndex(0);
				setQuestionCursor({ focus: 0, picked: [] });
				questionAnswers = {};
				if (id !== undefined && previous === undefined) {
					closeOverlay();
					stashedDraft = readComposer();
					writeComposer("");
				} else if (id === undefined && previous !== undefined) {
					writeComposer(stashedDraft ?? "");
					stashedDraft = undefined;
				} else if (id !== undefined) writeComposer("");
			},
		),
	);

	// With mouse reporting on, the terminal never sees the drag, so its own
	// copy has nothing selected: the finished UI selection is copied instead.
	useSelectionHandler((selection: Selection) => {
		const text = selection.getSelectedText();
		if (text.trim().length > 0) copyText(text);
	});

	createEffect(() => {
		const snapshot = props.snapshot();
		if (shownSession !== snapshot.sessionId) {
			shownSession = snapshot.sessionId;
			conversation?.scrollTo(conversation.scrollHeight);
			setCompletedMs(undefined);
			// A run that ended together with the previous session is not this session's.
			if (!snapshot.busy) busyStart = 0;
		}
		if (snapshot.busy) {
			if (busyStart === 0) {
				busyStart = Date.now();
				setCompletedMs(undefined);
			}
		} else if (busyStart !== 0) {
			setCompletedMs(Date.now() - busyStart);
			busyStart = 0;
		}
		props.transcript.sync(snapshot);
	});

	createEffect(() => {
		const busy = props.snapshot().busy;
		if (busy && spinTimer === undefined) {
			spinTimer = setInterval(() => setTick((value) => value + 1), 90);
		} else if (!busy && spinTimer !== undefined) {
			clearInterval(spinTimer);
			spinTimer = undefined;
			setTick((value) => value + 1);
		}
	});

	createEffect(() => {
		suggestions();
		setSuggestIndex(0);
	});

	onCleanup(() => {
		unsubscribeDraft();
		clearInterval(spinTimer);
		clearTimeout(exitTimer);
		clearTimeout(hintTimer);
	});

	/**
	 * The wheel scrolls the conversation wherever the pointer is. Events over
	 * the transcript reach the scrollbox directly; this forwards the ones that
	 * land on the composer and footer chrome, except while a picker owns the
	 * wheel or an overflowing draft needs it to scroll itself.
	 */
	function forwardWheel(event: MouseEvent): void {
		if (overlay() === "todo") {
			const direction = event.scroll?.direction;
			if (direction === "up" || direction === "down") scrollTodo(direction === "up" ? -1 : 1);
			return;
		}
		if (conversation === undefined || overlay() !== null) return;
		if (input !== undefined && event.target === input && input.virtualLineCount > input.height) return;
		conversation.processMouseEvent(event);
	}

	return (
		<box width="100%" height="100%" flexDirection="column">
			<scrollbox
				ref={(element: ScrollBoxRenderable) => {
					conversation = element;
				}}
				width="100%"
				flexGrow={1}
				flexShrink={1}
				minHeight={0}
				stickyScroll
				stickyStart="bottom"
				scrollX={false}
				scrollAcceleration={wheelAcceleration}
				verticalScrollbarOptions={{
					trackOptions: { backgroundColor: "transparent", foregroundColor: palette.rule },
				}}
				contentOptions={{ flexDirection: "column", flexShrink: 0 }}
			>
				<ConversationRows transcript={props.transcript} width={Math.max(1, width() - 1)} />
				<Show when={!props.snapshot().busy && completedMs() !== undefined}>
					<box width="100%" marginTop={1} flexShrink={0}>
						<StyledLine
							wrapMode="none"
							width="100%"
							content={
								new StyledText([
									muted(
										`${glyph.done} ${props.snapshot().status === "Interrupted" ? "Interrupted after" : props.snapshot().status === "Error" ? "Stopped after" : "Worked for"} ${formatElapsed(completedMs() ?? 0)}`,
									),
								])
							}
						/>
					</box>
				</Show>
			</scrollbox>
			<box flexShrink={0} flexDirection="column" width="100%" onMouseScroll={forwardWheel}>
				<Show when={overlay() === "agents"}>
					<box flexDirection="column" width="100%" maxHeight={overlayRows() + 1} overflow="hidden">
						<OverlayHeading title="agents" hint="esc to close" width={width()} />
						<StyledLine
							wrapMode="none"
							width="100%"
							content={buildAgentsText(props.snapshot().agents, width())}
						/>
					</box>
				</Show>

				<Show when={overlay() === "todo"}>
					<box flexDirection="column" width="100%" maxHeight={overlayRows() + 1} overflow="hidden">
						<OverlayHeading title={todoHeading().title} hint={todoHeading().hint} width={width()} />
						<StyledLine wrapMode="none" width="100%" content={todoView()} />
					</box>
				</Show>

				<Show when={overlay() !== null && overlay() !== "agents" && overlay() !== "todo"}>
					<Picker
						title={
							overlay() === "model"
								? "select model"
								: overlay() === "effort"
									? "reasoning effort"
									: overlay() === "resume"
										? "resume session"
										: overlay() === "rewind"
											? "rewind timeline"
											: "rewind event mode"
						}
						hint={`↑↓ / pgup/pgdown · enter choose · esc cancel`}
						options={pickerOptions()}
						selectedIndex={pickerIndex()}
						onMove={setPickerIndex}
						details={pickerDetails()}
						disabled={overlay() === "rewind-mode" && !rewindPoint()?.filesAvailable ? [1, 2] : []}
						width={width()}
						maxRows={overlayRows()}
						detailRows={detailRows()}
						showHeading={dimensions().height >= 6}
						onChoose={choose}
					/>
				</Show>

				<Show when={suggestions().length > 0}>
					<box flexDirection="column" width="100%" maxHeight={overlayRows()} overflow="hidden">
						<StyledLine
							wrapMode="none"
							width="100%"
							content={buildSuggestionText(suggestions(), suggestIndex(), width(), overlayRows())}
						/>
					</box>
				</Show>

				<Show when={currentQuestion()}>
					{(current: Accessor<UserQuestion>) => (
						<box flexDirection="column" width="100%" flexShrink={0}>
							<Show when={dimensions().height >= 6}>
								<OverlayHeading title={questionTitle()} hint={questionKeys(current())} width={width()} />
							</Show>
							<StyledLine
								wrapMode="none"
								width="100%"
								content={buildQuestionText(current(), questionCursor(), width(), overlayRows())}
							/>
						</box>
					)}
				</Show>

				<Show when={steeringRows() > 0}>
					<StyledLine wrapMode="none" width="100%" content={steeringText() ?? new StyledText([])} />
				</Show>

				<Show when={(activityText().chunks.length > 0 && dimensions().height >= 4) || todoLine()}>
					<box
						flexDirection="column"
						width="100%"
						flexShrink={0}
						marginTop={dimensions().height >= 16 ? 1 : 0}
					>
						<Show when={activityText().chunks.length > 0 && dimensions().height >= 4}>
							<StyledLine wrapMode="none" width="100%" content={activityText()} />
						</Show>
						<Show when={todoLine()}>
							{(line: Accessor<StyledText>) => <StyledLine wrapMode="none" width="100%" content={line()} />}
						</Show>
					</box>
				</Show>

				<Show when={dimensions().height >= 8}>
					<StyledLine wrapMode="none" width="100%" content={separator()} />
				</Show>

				<Show
					when={!secretMode()}
					fallback={
						<box flexDirection="row" width="100%">
							<StyledLine wrapMode="none" width={2} content={new StyledText([accent(`${glyph.caret} `)])} />
							<StyledLine
								wrapMode="none"
								content={
									new StyledText([
										user(glyph.mask.repeat(Math.min(secret().length, Math.max(0, width() - 4)))),
									])
								}
							/>
						</box>
					}
				>
					<box flexDirection="row" width="100%">
						<StyledLine wrapMode="none" width={2} content={new StyledText([accent(`${glyph.caret} `)])} />
						<textarea
							ref={(element: TextareaRenderable) => {
								input = element;
							}}
							flexGrow={1}
							height="auto"
							maxHeight={composerRows()}
							wrapMode="word"
							focused={overlay() === null}
							keyBindings={composerKeyBindings}
							backgroundColor="transparent"
							focusedBackgroundColor="transparent"
							textColor={palette.user}
							focusedTextColor={palette.user}
							cursorColor={palette.accent}
							placeholder={
								currentQuestion()
									? currentQuestion()?.options?.length
										? "or type your own answer"
										: "type your answer"
									: props.snapshot().busy
										? "working\u2026 enter to queue, ctrl+enter to interrupt"
										: "ask anything, or / for commands"
							}
							placeholderColor={palette.faint}
							onContentChange={() => setBuffer(input?.plainText ?? "")}
						/>
					</box>
				</Show>

				<Show when={dimensions().height >= 8}>
					<StyledLine wrapMode="none" width="100%" content={separator()} />
				</Show>

				<Show when={dimensions().height >= 6}>
					<StyledLine wrapMode="none" width="100%" content={footerText()} />
				</Show>
			</box>
		</box>
	);
}
