import { SyntaxStyle, bold as boldChunk, dim as dimChunk, fg, italic as italicChunk } from "@opentui/core";
import type { TextChunk } from "@opentui/core";

/** Unstyled chunk: inherits the terminal's own foreground colour. */
export function plain(text: string): TextChunk {
	return { __isChunk: true, text };
}

/**
 * Restrained palette for dark terminals: readable muted-gray body text, cyan
 * accents, green for completed actions and amber for work in progress. The
 * background is never painted, so the transcript stays on the terminal's own
 * near-black canvas with no cards or panels.
 */
export const palette = {
	accent: "#5fb3c3",
	accentSoft: "#4a8d9b",
	user: "#d3d7dc",
	text: "#bfc3c8",
	thinking: "#7b8087",
	muted: "#8b9096",
	faint: "#62676d",
	rule: "#367f8b",
	ok: "#6fbf73",
	warn: "#d4a24c",
	error: "#d7675e",
	added: "#6fb070",
	removed: "#cf6a62",
	code: "#a3c49a",
	link: "#7aa7d4",
} as const;

export const accent = fg(palette.accent);
export const accentSoft = fg(palette.accentSoft);
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
	tool: "\u25cf",
	toolRunning: "\u25cb",
	bullet: "\u00b7",
	rule: "\u2500",
	sep: "\u00b7",
	divider: "\u2502",
	branch: "\u2514",
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

export const spinnerFrames = [
	"\u280b",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283c",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280f",
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
