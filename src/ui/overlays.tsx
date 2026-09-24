import type { SelectOption, TextChunk } from "@opentui/core";
import { StyledText } from "@opentui/core";
import { For, Show } from "solid-js";
import type { AgentView } from "../contracts.ts";
import { modelTag } from "./blocks.tsx";
import type { SlashCommand } from "./commands.ts";
import { StyledLine } from "./styled.tsx";
import { flatten, truncate } from "./text.ts";
import { accent, bold, danger, faint, glyph, muted, ok, palette, plain, warn } from "./theme.ts";

/** Command palette rows: one terminal row per command, selected row accented. */
export function buildSuggestionText(
	commands: readonly SlashCommand[],
	index: number,
	width: number,
	maxRows: number,
): StyledText {
	const chunks: TextChunk[] = [];
	const nameWidth = commands.reduce(
		(max, command) => Math.max(max, command.name.length + command.hint.length + 1),
		0,
	);
	const first = Math.max(0, index - maxRows + 1);
	for (let i = first; i < Math.min(commands.length, first + maxRows); i += 1) {
		if (i > first) chunks.push(plain("\n"));
		const command = commands[i];
		const selected = i === index;
		const label = truncate(
			`${command.name}${command.hint ? ` ${command.hint}` : ""}`.padEnd(nameWidth),
			Math.max(0, width - 2),
		);
		chunks.push(selected ? accent(`${glyph.caret} `) : plain("  "));
		chunks.push(selected ? bold(accent(label)) : muted(label));
		if (width > nameWidth + 6) chunks.push(faint(`  ${truncate(command.detail, width - nameWidth - 6)}`));
	}
	return new StyledText(chunks);
}

/** Read-only agent roster shown by /agents; never a permanent panel. */
export function buildAgentsText(agents: readonly AgentView[], width: number): StyledText {
	if (agents.length === 0) return new StyledText([faint("  no agents running")]);
	const chunks: TextChunk[] = [];
	const nameWidth = agents.reduce((max, agent) => Math.max(max, agent.name.length), 0);
	for (let i = 0; i < agents.length; i += 1) {
		if (i > 0) chunks.push(plain("\n"));
		const agent = agents[i];
		const tone =
			agent.status === "error"
				? danger
				: agent.status === "running"
					? warn
					: agent.status === "done"
						? ok
						: muted;
		chunks.push(muted("  "));
		chunks.push(tone(agent.status.padEnd(9)));
		chunks.push(plain(agent.name.padEnd(nameWidth)));
		let room = width - nameWidth - 14 - (agent.worktree ? 11 : 0);
		const tag = [modelTag(agent.selection), agent.reasoning ?? ""]
			.filter((part) => part.length > 0)
			.join(" ");
		if (tag.length > 0 && room - tag.length - 2 >= 12) {
			chunks.push(faint(`  ${tag}`));
			room -= tag.length + 2;
		}
		const failure = agent.status === "error" && agent.error ? agent.error : undefined;
		chunks.push(
			(failure ? danger : faint)(`  ${truncate(flatten(failure ?? agent.task), Math.max(4, room))}`),
		);
		if (agent.worktree) chunks.push(faint(`  ${glyph.sep} worktree`));
	}
	return new StyledText(chunks);
}

export function OverlayHeading(props: { title: string; hint: string; width: number }) {
	return (
		<StyledLine
			wrapMode="none"
			content={
				new StyledText([
					accent(props.title),
					faint(`  ${truncate(props.hint, Math.max(0, props.width - props.title.length - 2))}`),
				])
			}
		/>
	);
}

/** Scrollable chooser with a stable selection and bounded detail preview. */
export function Picker(props: {
	title: string;
	hint: string;
	options: SelectOption[];
	width: number;
	maxRows: number;
	detailRows: number;
	showHeading: boolean;
	selectedIndex: number;
	onMove: (index: number) => void;
	details: string;
	disabled: readonly number[];
	onChoose: (index: number) => void;
}) {
	const rows = () => Math.max(1, Math.min(props.options.length, props.maxRows));
	return (
		<box flexDirection="column" width="100%" flexShrink={0}>
			<Show when={props.showHeading}>
				<OverlayHeading title={props.title} hint={props.hint} width={props.width} />
			</Show>
			<select
				focused
				width="100%"
				height={rows()}
				options={props.options}
				selectedIndex={props.selectedIndex}
				keyBindings={[
					{ name: "pageup", action: "move-up-fast" },
					{ name: "pagedown", action: "move-down-fast" },
				]}
				fastScrollStep={rows()}
				showDescription={false}
				showScrollIndicator={props.options.length > props.maxRows}
				wrapSelection
				backgroundColor="transparent"
				focusedBackgroundColor="transparent"
				textColor={palette.muted}
				focusedTextColor={palette.muted}
				selectedBackgroundColor="transparent"
				selectedTextColor={props.disabled.includes(props.selectedIndex) ? palette.faint : palette.accent}
				onChange={(index: number) => props.onMove(index)}
				onSelect={(index: number) => {
					if (!props.disabled.includes(index)) props.onChoose(index);
				}}
			/>
			<For
				each={
					props.detailRows > 0 && props.details.length > 0
						? props.details.split("\n").slice(-props.detailRows)
						: []
				}
			>
				{(line) => (
					<StyledLine
						wrapMode="none"
						width="100%"
						content={new StyledText([muted(truncate(line, props.width))])}
					/>
				)}
			</For>
		</box>
	);
}
