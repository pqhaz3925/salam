import { expect, test } from "bun:test";
import { classifyShell } from "../src/tools/shell-kind.ts";

const label = (command: string, output?: string) =>
	classifyShell(command, output)
		?.map((part) => (part.target ? `${part.verb}(${part.target})` : part.verb))
		.join(" ");

test("reads, searches and listings are labelled from the command line", () => {
	expect(label("cat src/a.ts")).toBe("Read(src/a.ts)");
	expect(label("sed -n 1,40p src/ui/images.ts")).toBe("Read(src/ui/images.ts)");
	expect(label("head -n 20 README.md")).toBe("Read(README.md)");
	expect(label("wc -l a.ts b.ts")).toBe("Read(a.ts, b.ts)");
	expect(label("rg -n 'foo bar' src")).toBe("Search(foo bar in src)");
	expect(label("grep -rn -e needle src test")).toBe("Search(needle in src test)");
	expect(label("git grep TODO")).toBe("Search(TODO)");
	expect(label("ls -la src")).toBe("List(src)");
	expect(label("find src -name '*.ts' -type f")).toBe("List(src *.ts)");
});

test("wrappers, cd prefixes, pipelines and chains reduce to what the command does", () => {
	expect(label("cd /repo && rtk git status")).toBe("Git(status)");
	expect(label("rg paste src/ui/App.tsx | head -20")).toBe("Search(paste in src/ui/App.tsx)");
	expect(label("cat a.ts && cat b.ts")).toBe("Read(a.ts, b.ts)");
	expect(label("rg foo src; sed -n 1,5p a.ts")).toBe("Search(foo in src) Read(a.ts)");
	expect(label("FOO=1 bunx tsc --noEmit -p .")).toBe("Check(tsc .)");
	expect(label("bun run test test/a.test.ts")).toBe("Test(test/a.test.ts)");
	expect(label("npm run lint")).toBe("Check(npm lint)");
	expect(label("bun add zod")).toBe("Install(zod)");
	expect(label("pytest -x tests/")).toBe("Test(tests/)");
});

test("writes, in-place edits and file operations", () => {
	expect(label("sed -i '' 's/a/b/' src/x.ts")).toBe("Update(src/x.ts)");
	expect(label("perl -pi -e 's/a/b/' a.txt b.txt")).toBe("Update(a.txt, b.txt)");
	expect(label("cat > new.py <<'EOF'\nprint(1) && rm -rf /\nEOF")).toBe("Write(new.py)");
	expect(label("echo hi >> log.txt")).toBe("Write(log.txt)");
	expect(label("rm -rf build dist")).toBe("Delete(build, dist)");
	expect(label("mv a.ts b.ts")).toBe("Move(a.ts → b.ts)");
	expect(label("curl -fsS https://example.com/x")).toBe("Fetch(https://example.com/x)");
});

test("unknown commands keep the plain shell row", () => {
	expect(label("python3 script.py")).toBeUndefined();
	expect(label("cat a.ts && python3 -c 'print(1)'")).toBeUndefined();
	expect(label("make")).toBeUndefined();
});

test("files the command really changed override the static reading", () => {
	const report =
		"[files you had seen changed on disk while this command ran: a.py, new.txt (created), old.txt (deleted)]";
	expect(label("python3 -c 'import pathlib; ...'", `out\n${report}\n--- a.py`)).toBe(
		"Update(a.py) Create(new.txt) Delete(old.txt)",
	);
	expect(
		label("bun test && sed -i 's/x/y/' a.py", report.replace(", new.txt (created), old.txt (deleted)", "")),
	).toBe("Update(a.py) Test(bun test)");
});
