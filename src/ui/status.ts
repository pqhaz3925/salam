import type { TextChunk } from "@opentui/core";
import { StyledText } from "@opentui/core";
import type { AppSnapshot } from "../contracts.ts";
import { compactCount, displayPath, formatElapsed, truncate } from "./text.ts";
import { accent, active, danger, faint, glyph, muted, text, warn } from "./theme.ts";

type Tone = (text: string) => TextChunk;

interface Segment {
	text: string;
	tone: Tone;
}

const ACTIVITY_SEPARATOR = ` ${glyph.sep} `;
const FOOTER_SEPARATOR = ` ${glyph.sep} `;

/**
 * Activity row directly above the composer: current work, transient notices,
 * and the keys that matter in the current state. Segments are in priority order and
 * appended only while they fit, so a narrow terminal drops trailing key hints
 * instead of wrapping; the leading segment is truncated rather than dropped.
 * While busy it reads like Claude Code's: `✻ Thinking… (10m10s · esc to interrupt)`, the
 * warm status first and everything else in parentheses. An empty result means the row can
 * be hidden.
 */
export function buildActivityText(
	snapshot: AppSnapshot,
	options: {
		width: number;
		spinnerFrame: string;
		elapsedMs: number;
		notice: string;
		keys: readonly string[];
	},
): StyledText {
	const segments: Segment[] = [];

	if (snapshot.busy) {
		segments.push({ text: `${options.spinnerFrame} ${snapshot.status || "Working"}\u2026`, tone: active });
		segments.push({ text: formatElapsed(options.elapsedMs), tone: muted });
	} else {
		if (snapshot.status.length > 0 && snapshot.status !== "Ready")
			segments.push({ text: snapshot.status, tone: snapshot.status === "Error" ? danger : muted });
	}
	if (options.notice.length > 0) segments.push({ text: options.notice, tone: text });
	if (snapshot.goal)
		segments.push({
			text: `goal ${snapshot.goal.status}`,
			tone: snapshot.goal.status === "active" ? accent : muted,
		});
	if (snapshot.loops > 0)
		segments.push({ text: `${snapshot.loops} loop${snapshot.loops === 1 ? "" : "s"}`, tone: warn });
	let running = 0;
	for (const agent of snapshot.agents) if (agent.status === "running") running += 1;
	if (running > 0) segments.push({ text: `${running} agent${running === 1 ? "" : "s"}`, tone: warn });
	if (options.notice.length === 0) for (const key of options.keys) segments.push({ text: key, tone: faint });

	const chunks: TextChunk[] = [];
	const grouped = snapshot.busy;
	// The closing parenthesis is reserved up front so the group always closes.
	let used = grouped ? 1 : 0;
	let details = 0;
	for (const segment of segments) {
		if (chunks.length === 0) {
			const first = truncate(segment.text, options.width - used);
			if (first.length === 0) break;
			chunks.push(segment.tone(first));
			used += first.length;
			continue;
		}
		const lead = grouped && details === 0 ? " (" : ACTIVITY_SEPARATOR;
		const cost = lead.length + segment.text.length;
		if (used + cost > options.width) continue;
		chunks.push(faint(lead), segment.tone(segment.text));
		used += cost;
		details += 1;
	}
	if (grouped && details > 0) chunks.push(faint(")"));
	return new StyledText(chunks);
}

interface FooterSegment {
	text: string;
	tone: Tone;
	/** Lower ranks survive longer when the row is too narrow. */
	rank: number;
	/** Elastic segments shrink to `ELASTIC_MIN` columns before anything is dropped. */
	fit?: (width: number) => string;
	/** Narrowest useful width of an elastic segment; defaults to `ELASTIC_MIN`. */
	min?: number;
}

const ELASTIC_MIN = 12;

/** Time until a quota window resets: `43m`, `2h13m`, `3d4h`. */
function untilReset(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/**
 * One continuous left-aligned status row below the composer:
 * `cwd │ remote │ provider/model │ thinking level │ used/limit (pct) │ quota left │ cache pct`.
 * The model label and working directory shrink first (tail-truncated model,
 * head-elided path); after that the least important segments are dropped
 * whole, so long paths or model ids never wrap the footer.
 */
export function buildFooterText(
	snapshot: AppSnapshot,
	options: { width: number; home: string; expanded: boolean; now?: number },
): StyledText {
	const segments: FooterSegment[] = [];
	if (snapshot.cwd.length > 0)
		segments.push({
			text: displayPath(snapshot.cwd, options.home, Number.POSITIVE_INFINITY),
			tone: muted,
			rank: 3,
			fit: (width) => displayPath(snapshot.cwd, options.home, width),
		});
	if (snapshot.remote) segments.push({ text: `remote ${snapshot.remote}`, tone: warn, rank: 1 });
	const model = `${snapshot.selection.provider}/${snapshot.selection.model}`;
	segments.push({ text: model, tone: text, rank: 0, fit: (width) => truncate(model, width) });
	segments.push({ text: `thinking ${snapshot.reasoning}`, tone: muted, rank: 1 });

	if (snapshot.contextLimit > 0) {
		const pct = Math.round((snapshot.contextTokens / snapshot.contextLimit) * 100);
		segments.push({
			text: `${compactCount(snapshot.contextTokens)}/${compactCount(snapshot.contextLimit)} (${pct}%)`,
			tone: pct >= 80 ? warn : muted,
			rank: 2,
		});
	} else if (snapshot.contextTokens > 0) {
		segments.push({ text: `${compactCount(snapshot.contextTokens)} ctx`, tone: muted, rank: 2 });
	}

	// Subscription quota left for the active provider: 5h/day and weekly windows.
	const now = options.now ?? Date.now();
	for (const window of snapshot.quota?.windows ?? []) {
		// A window whose reset time has passed is full again, even before the next fetch says so.
		const lapsed = window.resetsAt !== undefined && window.resetsAt <= now;
		const pct = lapsed ? 100 : Math.floor(window.remaining * 100);
		const short = `${window.label} left ${pct}%`;
		const countdown =
			window.resetsAt !== undefined && window.resetsAt > now ? ` (${untilReset(window.resetsAt - now)})` : "";
		segments.push({
			text: `${short}${countdown}`,
			tone: pct <= 10 ? danger : pct <= 25 ? warn : muted,
			rank: 2,
			fit: (width) => (width >= short.length ? short : truncate(short, width)),
			min: short.length,
		});
	}

	// Session prompt-cache hit rate, the same ratio `/usage` reports: cached
	// reads over every prompt token (uncached input + cache reads + writes).
	const usage = snapshot.usage;
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	if (prompt > 0)
		segments.push({ text: `cache ${Math.round((usage.cacheRead / prompt) * 100)}%`, tone: muted, rank: 5 });

	if (options.expanded) segments.push({ text: "tool output expanded", tone: muted, rank: 4 });

	const widths = segments.map((segment) =>
		segment.fit ? Math.min(segment.text.length, segment.min ?? ELASTIC_MIN) : segment.text.length,
	);
	let needed = (segments.length - 1) * FOOTER_SEPARATOR.length;
	for (const width of widths) needed += width;
	while (segments.length > 1 && needed > options.width) {
		let drop = 0;
		for (let i = 1; i < segments.length; i += 1) if (segments[i].rank >= segments[drop].rank) drop = i;
		needed -= widths[drop] + FOOTER_SEPARATOR.length;
		segments.splice(drop, 1);
		widths.splice(drop, 1);
	}

	// Spare columns grow elastic segments back toward full length, most important first.
	let spare = Math.max(0, options.width - needed);
	const order = segments.map((_, index) => index).sort((a, b) => segments[a].rank - segments[b].rank);
	for (const index of order) {
		const grow = Math.min(spare, segments[index].text.length - widths[index]);
		widths[index] += grow;
		spare -= grow;
	}

	const chunks: TextChunk[] = [];
	for (let i = 0; i < segments.length; i += 1) {
		const { text: full, tone, fit } = segments[i];
		const width = Math.min(widths[i], options.width);
		const shown = full.length <= width ? full : fit ? fit(width) : truncate(full, width);
		if (shown.length === 0) continue;
		if (chunks.length > 0) chunks.push(faint(FOOTER_SEPARATOR));
		chunks.push(tone(shown));
	}
	return new StyledText(chunks);
}
