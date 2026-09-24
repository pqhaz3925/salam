import { expect, test } from "bun:test";
import { unifiedDiff } from "../src/tools/text.ts";

/** Applies a unified diff to `before`, checking every context and removed line on the way. */
function apply(before: string, patch: string): string {
	const source = before.split("\n");
	const out: string[] = [];
	let index = 0;
	const lines = patch.split("\n");
	for (let i = 2; i < lines.length; i++) {
		const header = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(lines[i]!);
		if (!header) continue;
		const start = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1;
		while (index < start) out.push(source[index++]!);
		for (i++; i < lines.length && !lines[i]!.startsWith("@@"); i++) {
			const line = lines[i]!;
			if (line === "" && i === lines.length - 1) break;
			const body = line.slice(1);
			if (line[0] === "+") out.push(body);
			else {
				expect(source[index]).toBe(body);
				if (line[0] === " ") out.push(body);
				index++;
			}
		}
		i--;
	}
	while (index < source.length) out.push(source[index++]!);
	return out.join("\n");
}

/** Deterministic PRNG so failures reproduce. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

test("a few scattered edits in a large file diff as small hunks, not a whole-file replacement", () => {
	const before = Array.from({ length: 3_200 }, (_, index) => `line ${index}`);
	const after = [...before];
	after.splice(2_500, 1, "changed 2500");
	after.splice(1_000, 0, "inserted after 999");
	after.splice(10, 2);
	const patch = unifiedDiff(`${before.join("\n")}\n`, `${after.join("\n")}\n`, "big.ts");
	const changed = patch.split("\n").filter((line) => /^[-+][^-+]/.test(line));
	expect(changed).toEqual(["-line 10", "-line 11", "+inserted after 999", "-line 2500", "+changed 2500"]);
	expect(patch.split("\n").length).toBeLessThan(40);
	expect(apply(`${before.join("\n")}\n`, patch)).toBe(`${after.join("\n")}\n`);
});

test("random edits round-trip through the patch", () => {
	const next = random(7);
	for (let round = 0; round < 200; round++) {
		const before = Array.from({ length: Math.floor(next() * 60) }, () => `v${Math.floor(next() * 8)}`);
		const after = before.filter(() => next() > 0.2).map((line) => (next() > 0.85 ? `${line}x` : line));
		for (let insert = Math.floor(next() * 5); insert > 0; insert--)
			after.splice(Math.floor(next() * (after.length + 1)), 0, `n${Math.floor(next() * 8)}`);
		const from = `${before.join("\n")}\n`;
		const to = `${after.join("\n")}\n`;
		const patch = unifiedDiff(from, to, "f");
		if (from === to) expect(patch).toBe("");
		else expect(apply(from, patch)).toBe(to);
	}
});
