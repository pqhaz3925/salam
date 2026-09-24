import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { ToolContext } from "../src/contracts.ts";
import { createTools } from "../src/tools/index.ts";
import type { ToolServices } from "../src/tools/index.ts";

let directory: string | undefined;
let services: ToolServices | undefined;
afterEach(async () => {
	await services?.close();
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
	services = undefined;
});

test("read pages preserve oversized lines and Unicode in files and saved artifacts", async () => {
	directory = await mkdtemp(join(tmpdir(), "salam-read-"));
	const config = await loadConfig({ cwd: directory, home: join(directory, "state") });
	services = await createTools(config);
	const reader = services.tools.find((tool) => tool.name === "read")!;
	const context: ToolContext = {
		cwd: directory,
		sessionId: "reader",
		agentId: "main",
		signal: new AbortController().signal,
		emit: () => {},
	};
	const contents = "a".repeat(39_996) + "𝄞" + "b".repeat(110_000) + "END_MARKER";
	const file = join(directory, "long.txt");
	await Bun.write(file, contents);
	const artifact = await services.artifacts.store(context.sessionId, "long", contents);

	for (const path of [file, artifact.uri]) {
		let offset = 1;
		let column = 1;
		let recovered = "";
		for (let page = 0; page < 20; page++) {
			const result = await reader.execute({ path, offset, column }, context);
			expect(result.isError).not.toBe(true);
			expect(result.text.length).toBeLessThan(48_000);
			for (const row of result.text.split("\n")) {
				const match = /^\d+(?::\d+)?\t(.*)$/.exec(row);
				if (match) recovered += match[1];
			}
			const details = result.details as { truncated: boolean; nextOffset?: number; nextColumn?: number };
			if (!details.truncated) break;
			expect(Number.isInteger(details.nextOffset)).toBe(true);
			expect(Number.isInteger(details.nextColumn)).toBe(true);
			offset = details.nextOffset!;
			column = details.nextColumn!;
		}
		expect(recovered).toBe(contents);
	}
});
