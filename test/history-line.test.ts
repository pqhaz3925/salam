import { expect, test } from "bun:test";
import type { HistoryEntry } from "../src/contracts.ts";
import { historyLine } from "../src/runtime/index.ts";

function user(content: string, extra: Record<string, unknown> = {}): HistoryEntry {
	return {
		id: "x",
		kind: "message",
		message: { role: "user", content, timestamp: 0, ...extra },
	} as HistoryEntry;
}

test("history_read shows only the head of long harness handoffs but keeps agent mail and user text whole", () => {
	const handoff = `The installed tool catalogue changed (grep).\n${"guidance and quoted transcript ".repeat(200)}`;
	const collapsed = historyLine({ seq: 5, entry: user(handoff, { synthetic: true }) })!;
	expect(collapsed.startsWith("[5 harness] The installed tool catalogue changed (grep).")).toBe(true);
	expect(collapsed.length).toBeLessThan(800);
	expect(collapsed).toContain("more chars of harness context omitted");

	const mail = `[Agent message from worker]\n${"child result ".repeat(300)}`;
	expect(historyLine({ seq: 6, entry: user(mail, { synthetic: true, attribution: "agent" }) })).toBe(
		`[6 harness] ${mail}`,
	);
	const typed = "please ".repeat(400);
	expect(historyLine({ seq: 7, entry: user(typed) })).toBe(`[7 user] ${typed}`);
	expect(historyLine({ seq: 8, entry: user("short control", { synthetic: true }) })).toBe(
		"[8 harness] short control",
	);
});
