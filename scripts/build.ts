import solidPlugin from "@opentui/solid/bun-plugin";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveSyntaxAssets } from "../src/ui/syntax.ts";

const root = resolve(import.meta.dir, "..");
await mkdir(join(root, "dist"), { recursive: true });
// Grammars stay in their packages and are resolved from dist/ at runtime, like
// every other external package; a bundle that would render code plain is not built.
const syntax = resolveSyntaxAssets(join(root, "dist"));
if (syntax.missing.length > 0)
	throw new Error(`Missing syntax highlighting assets: ${syntax.missing.join("; ")}. Run bun install.`);
// Native provider and terminal packages retain their platform-specific assets.
// This is a runnable Bun bundle alongside installed dependencies, not a static binary.
const result = await Bun.build({
	entrypoints: [join(root, "src", "cli.ts")],
	outdir: join(root, "dist"),
	target: "bun",
	packages: "external",
	plugins: [solidPlugin],
	sourcemap: "external",
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exitCode = 1;
} else {
	const directories = [
		...[
			"@oh-my-pi/pi-ai",
			"@oh-my-pi/pi-catalog",
			"@oh-my-pi/pi-wire",
			"@oh-my-pi/pi-utils",
			"@oh-my-pi/pi-natives",
			"@opentui/core",
			"@opentui/solid",
			"solid-js",
			"web-tree-sitter",
		].map((packageName) => join(root, "node_modules", packageName)),
		...syntax.packages,
	];
	const licenses: string[] = [];
	for (const directory of new Set(directories)) {
		const { name, version } = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
			name: string;
			version: string;
		};
		const files = await readdir(directory);
		const filename = files.find((file) => /^licen[cs]e(?:\.|$)/i.test(file));
		if (!filename) throw new Error(`Cannot locate the required license notice for ${name}`);
		licenses.push(`=== ${name}@${version} ===\n${await readFile(join(directory, filename), "utf8")}`);
	}
	await writeFile(join(root, "dist", "THIRD-PARTY-NOTICES.txt"), licenses.join("\n\n"));
	console.log("Built dist/cli.js. Run with Bun 1.4.1+; installed dependencies are required.");
}
