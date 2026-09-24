import type { TextChunk } from "@opentui/core";
import { bold as boldChunk, dim as dimChunk, fg, italic as italicChunk, SyntaxStyle } from "@opentui/core";

/** Unstyled chunk: inherits the terminal's own foreground colour. */
export function plain(text: string): TextChunk {
	return { __isChunk: true, text };
}

/**
 * Claude Code-like palette for dark terminals: near-white body text, grey for
 * secondary detail, green/red for results and diffs, and one warm accent for
 * live activity. The transcript background is never painted, except the user's
 * own messages and diff lines, which get a subtle tint as in Claude Code.
 */
export const palette = {
	accent: "#5fb3c3",
	accentSoft: "#4a8d9b",
	/** Live activity (spinner and status), Claude Code's warm orange. */
	active: "#d77757",
	user: "#f2f2f2",
	userBg: "#373737",
	text: "#e4e4e4",
	thinking: "#8c8c8c",
	muted: "#9a9a9a",
	faint: "#6e6e6e",
	rule: "#505050",
	ok: "#6fbf73",
	warn: "#d4a24c",
	error: "#e0685e",
	added: "#8fd694",
	removed: "#f08a82",
	addedBg: "#1f3d27",
	removedBg: "#4d2629",
	code: "#a3c49a",
	link: "#7aa7d4",
} as const;

export const accent = fg(palette.accent);
export const accentSoft = fg(palette.accentSoft);
export const active = fg(palette.active);
export const user = fg(palette.user);
export const text = fg(palette.text);
export const thinking = fg(palette.thinking);
export const muted = fg(palette.muted);
export const faint = fg(palette.faint);
export const rule = fg(palette.rule);
export const ok = fg(palette.ok);
export const warn = fg(palette.warn);
export const danger = fg(palette.error);
export const bold = boldChunk;
export const dim = dimChunk;
export const italic = italicChunk;

/** Glyphs. Plain box-drawing / geometric characters only, never emoji. */
export const glyph = {
	user: ">",
	prompt: "\u276f",
	tool: "\u25cf",
	toolRunning: "\u25cb",
	bullet: "\u00b7",
	rule: "\u2500",
	sep: "\u00b7",
	divider: "\u2502",
	branch: "\u23bf",
	branchMid: "\u251c",
	ellipsis: "\u2026",
	caret: "\u203a",
	mask: "\u2022",
	done: "\u273b",
	/** Todo states; completed and pending reuse the tool dots. */
	todoActive: "\u25d0",
	todoBlocked: "!",
	todoAbandoned: "\u2013",
} as const;

/** Claude Code's glyph spinner: a star that grows and shrinks. */
export const spinnerFrames = [
	"\u00b7",
	"\u2722",
	"\u2733",
	"\u2736",
	"\u273b",
	"\u273d",
	"\u273b",
	"\u2736",
	"\u2733",
	"\u2722",
] as const;

/**
 * Quiet syntax theme shared by markdown, fenced code and diffs. Prose and
 * unmapped captures use the muted-gray body colour; bold text steps up to the
 * brighter prompt colour so emphasis still stands out against the body.
 * Dotted captures fall back to their first segment (`string.special.url` to
 * `string`), so the official grammar queries in `syntax.ts` resolve here.
 */
export const syntaxStyle: SyntaxStyle = SyntaxStyle.fromStyles({
	default: { fg: palette.text },
	"markup.heading": { fg: palette.accent, bold: true },
	"markup.strong": { fg: palette.user, bold: true },
	"markup.italic": { fg: palette.text, italic: true },
	"markup.underline": { fg: palette.text, underline: true },
	"markup.quote": { fg: palette.muted, italic: true },
	"markup.list": { fg: palette.accentSoft },
	"markup.raw": { fg: palette.code },
	"markup.link": { fg: palette.link },
	"markup.link.label": { fg: palette.link },
	"markup.link.url": { fg: palette.link, underline: true },
	"string.special.url": { fg: palette.link, underline: true },
	conceal: { fg: palette.faint, dim: true },
	comment: { fg: palette.faint, italic: true },
	keyword: { fg: palette.accentSoft },
	"keyword.function": { fg: palette.accentSoft },
	"keyword.return": { fg: palette.accentSoft },
	"keyword.operator": { fg: palette.accentSoft },
	string: { fg: palette.code },
	"string.escape": { fg: palette.warn },
	"string.special.key": { fg: palette.accentSoft },
	escape: { fg: palette.warn },
	character: { fg: palette.code },
	embedded: { fg: palette.text },
	number: { fg: palette.warn },
	float: { fg: palette.warn },
	boolean: { fg: palette.warn },
	constant: { fg: palette.warn },
	"constant.builtin": { fg: palette.warn },
	function: { fg: palette.link },
	"function.call": { fg: palette.link },
	"function.method": { fg: palette.link },
	type: { fg: palette.accent },
	"type.builtin": { fg: palette.accent },
	constructor: { fg: palette.accent },
	module: { fg: palette.accent },
	namespace: { fg: palette.accent },
	variable: { fg: palette.text },
	"variable.parameter": { fg: palette.muted },
	"variable.member": { fg: palette.text },
	property: { fg: palette.text },
	attribute: { fg: palette.accent },
	tag: { fg: palette.accentSoft },
	label: { fg: palette.muted },
	operator: { fg: palette.muted },
	punctuation: { fg: palette.muted },
	"punctuation.bracket": { fg: palette.muted },
	"punctuation.delimiter": { fg: palette.muted },
	"punctuation.special": { fg: palette.muted },
	delimiter: { fg: palette.muted },
	"diff.plus": { fg: palette.added },
	"diff.minus": { fg: palette.removed },
	"diff.delta": { fg: palette.accentSoft },
	"diff.file": { fg: palette.muted, bold: true },
});
