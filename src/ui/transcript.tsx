import type { Accessor, Setter } from "solid-js";
import { batch, createMemo, createSignal, For, Match, Switch } from "solid-js";
import type { AppSnapshot, ViewItem } from "../contracts.ts";
import { AssistantBlock, NoticeBlock, ToolBlock, UserBlock } from "./blocks.tsx";

interface TranscriptRow {
	id: string;
	item: Accessor<ViewItem>;
	update: Setter<ViewItem>;
	previous: ViewItem;
}

export interface Transcript {
	rows: Accessor<TranscriptRow[]>;
	notices: Accessor<ViewItem[]>;
	/** Tool output (results and diffs) shown in full; assistant answers and reasoning never depend on it. */
	expanded: Accessor<boolean>;
	notice(text: string, error: boolean): void;
	sync(snapshot: AppSnapshot): void;
	toggleExpanded(): void;
}

/** Runtime mutates items in place. Retain stable rows, publishing only changed records. */
export function createTranscript(): Transcript {
	const [rows, setRows] = createSignal<TranscriptRow[]>([]);
	const [notices, setNotices] = createSignal<ViewItem[]>([]);
	const [expanded, setExpanded] = createSignal(false);
	let current: TranscriptRow[] = [];
	let sessionId: string | undefined;
	let noticeId = 0;

	return {
		rows,
		notices,
		expanded,
		notice(text, error) {
			setNotices((items) => [
				...items,
				{ id: `ui-notice-${++noticeId}`, kind: "notice", text, state: error ? "error" : "done" },
			]);
		},
		toggleExpanded() {
			setExpanded((value) => !value);
		},
		sync(snapshot) {
			batch(() => {
				if (sessionId !== snapshot.sessionId) {
					current = [];
					setRows(current);
					if (sessionId !== undefined) setNotices([]);
					sessionId = snapshot.sessionId;
				}
				const changedOrder =
					current.length !== snapshot.items.length ||
					current.some((row, index) => row.id !== snapshot.items[index]?.id);
				if (changedOrder) {
					const existing = new Map(current.map((row) => [row.id, row]));
					current = snapshot.items.map((value) => {
						const row = existing.get(value.id);
						if (row) return row;
						const previous = { ...value };
						const [item, update] = createSignal(previous);
						return { id: value.id, item, update, previous };
					});
					setRows(current);
				}
				for (let index = 0; index < current.length; index += 1) {
					const row = current[index];
					const value = snapshot.items[index];
					const previous = row.previous;
					if (
						previous.kind === value.kind &&
						previous.text === value.text &&
						previous.thinking === value.thinking &&
						previous.name === value.name &&
						previous.state === value.state &&
						previous.details === value.details &&
						previous.diff === value.diff &&
						previous.agentId === value.agentId &&
						previous.selection === value.selection
					)
						continue;
					row.previous = { ...value };
					row.update(row.previous);
				}
			});
		},
	};
}

function TranscriptItem(props: { item: Accessor<ViewItem>; width: number; expanded: boolean }) {
	const text = createMemo(() => props.item().text);
	const thinking = createMemo(() => props.item().thinking ?? "");
	return (
		<Switch>
			<Match when={props.item().kind === "user"}>
				<UserBlock text={text()} />
			</Match>
			<Match when={props.item().kind === "assistant"}>
				<AssistantBlock text={text()} thinking={thinking()} streaming={props.item().state === "running"} />
			</Match>
			<Match when={props.item().kind === "tool"}>
				<ToolBlock item={props.item()} width={props.width} expanded={props.expanded} />
			</Match>
			<Match when={props.item().kind === "notice"}>
				<NoticeBlock text={text()} error={props.item().state === "error"} width={props.width} />
			</Match>
		</Switch>
	);
}

export function ConversationRows(props: { transcript: Transcript; width: number }) {
	return (
		<>
			<For each={props.transcript.rows()}>
				{(row) => (
					<TranscriptItem item={row.item} width={props.width} expanded={props.transcript.expanded()} />
				)}
			</For>
			<For each={props.transcript.notices()}>
				{(item) => <NoticeBlock text={item.text} error={item.state === "error"} width={props.width} />}
			</For>
		</>
	);
}
