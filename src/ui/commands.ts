/**
 * Slash commands offered by the composer's completion list. Everything here is
 * forwarded verbatim to AppController.command except `/quit`, `/agents`, the
 * bare `/todo`, and the bare `/model`, `/effort`, `/resume`, and `/rewind`
 * forms, which open a local view or chooser first and then forward the
 * resolved line.
 */
export interface SlashCommand {
	name: string;
	/** Argument placeholder; empty means the command runs on its own. */
	hint: string;
	detail: string;
}

export const slashCommands: readonly SlashCommand[] = [
	{
		name: "/model",
		hint: "[provider/model]",
		detail: "switch model in this dialog; each model keeps its own history",
	},
	{
		name: "/effort",
		hint: "[off|low|medium|high]",
		detail: "change reasoning effort without resetting the session",
	},
	{
		name: "/goal",
		hint: "[TEXT|status|pause|resume|clear]",
		detail: "work until the goal is completed or paused",
	},
	{ name: "/todo", hint: "", detail: "show task progress and the full todo list" },
	{
		name: "/memory",
		hint: "[on|off|list]",
		detail: "inspect persistent project memory or toggle auto-memory",
	},
	{ name: "/loop", hint: "[INTERVAL TASK|list|stop ID|all]", detail: "schedule a recurring task while idle" },
	{ name: "/jobs", hint: "", detail: "list managed background commands" },
	{
		name: "/wait",
		hint: "ID [SECONDS]",
		detail: "wait for a background command without killing it on cancel",
	},
	{ name: "/output", hint: "ID", detail: "read background command output" },
	{ name: "/kill", hint: "ID", detail: "stop a background command and its process tree" },
	{ name: "/resume", hint: "[ID-prefix|latest]", detail: "pick or resume a saved session" },
	{
		name: "/rewind",
		hint: "[ID [conversation|files|both]]",
		detail: "fork before a labelled event and pick a restore mode",
	},
	{ name: "/new", hint: "", detail: "start a fresh session" },
	{ name: "/compact", hint: "", detail: "summarise and shrink context" },
	{ name: "/recap", hint: "[focus]", detail: "read-only conversation summary" },
	{
		name: "/usage",
		hint: "[session|provider|all]",
		detail: "session tokens and subscription quota (default all)",
	},
	{ name: "/context", hint: "", detail: "show context breakdown" },
	{ name: "/tools", hint: "", detail: "list available tools" },
	{ name: "/remote", hint: "<name|local>", detail: "switch execution target" },
	{ name: "/auth", hint: "", detail: "show provider auth status" },
	{ name: "/login", hint: "<provider>", detail: "authenticate a provider" },
	{ name: "/agents", hint: "", detail: "show running agents" },
	{ name: "/help", hint: "", detail: "list commands" },
	{ name: "/quit", hint: "", detail: "exit salam" },
];

/**
 * Suggestions for the composer. Only fires while the buffer is a single
 * unfinished `/word`, so typing `/model gpt` or prose never opens the list.
 */
export function suggestCommands(buffer: string): SlashCommand[] {
	if (!buffer.startsWith("/") || buffer.includes("\n") || buffer.includes(" ")) return [];
	const prefix = buffer.toLowerCase();
	return slashCommands.filter((command) => command.name.startsWith(prefix));
}
