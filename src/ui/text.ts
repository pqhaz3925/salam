/** Single-line truncation with an ellipsis; width <= 0 yields an empty string. */
export function truncate(text: string, width: number): string {
	const limit = Math.trunc(width);
	if (limit <= 0) return "";
	const flat = text.replaceAll("\n", " ").replaceAll("\t", " ");
	if (flat.length <= limit) return flat;
	if (limit === 1) return "\u2026";
	return `${flat.slice(0, limit - 1)}\u2026`;
}

/** 1234 -> "1.2k", 1234567 -> "1.2M". Used for token and context counters. */
export function compactCount(value: number): string {
	const n = Math.max(0, Math.trunc(value));
	if (n < 1000) return String(n);
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
	}
	const m = n / 1_000_000;
	return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** Elapsed wall time for the busy indicator: "4s", "1m12s", "1h03m". */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Coarse "when" label for the session picker. */
export function formatWhen(timestamp: number, now: number): string {
	const delta = Math.max(0, now - timestamp);
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return days < 30 ? `${days}d ago` : new Date(timestamp).toISOString().slice(0, 10);
}

/** `/Users/me/src/app` -> `~/src/app`, then head-elided to fit `width`. */
export function displayPath(path: string, home: string, width: number): string {
	const short = home.length > 1 && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	const limit = Math.trunc(width);
	if (limit <= 0 || short.length <= limit) return short;
	const tail = short.slice(short.length - (limit - 1));
	return `\u2026${tail}`;
}

/** Collapse whitespace so tool arguments stay on one terse line. */
export function flatten(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Word-wraps text into rows of at most `width` columns, keeping explicit
 * newlines and hard-breaking words longer than a row. Used where a view
 * windows rows itself, so it must know the exact row count up front.
 */
export function wrapText(text: string, width: number): string[] {
	const limit = Math.max(1, Math.trunc(width));
	const rows: string[] = [];
	for (const paragraph of text.replaceAll("\t", " ").split("\n")) {
		let row = "";
		for (const word of paragraph.split(" ")) {
			if (row.length > 0 && row.length + 1 + word.length <= limit) {
				row += ` ${word}`;
				continue;
			}
			if (row.length > 0) rows.push(row);
			row = word;
			while (row.length > limit) {
				rows.push(row.slice(0, limit));
				row = row.slice(limit);
			}
		}
		rows.push(row);
	}
	return rows;
}
