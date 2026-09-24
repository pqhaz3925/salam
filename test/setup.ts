/**
 * Suite-wide preload.
 *
 * Refuses to run the suite on a Bun older than package.json `engines.bun`.
 * `bun test` uses whatever `bun` is first on PATH (often a global install),
 * while `bin/salam` always runs the pinned node_modules copy; an older global
 * Bun reports behaviour salam never sees (e.g. Bun 1.3 drops setuid/setgid in
 * chmod). `bun run test` puts the pinned copy first on PATH.
 *
 * Points the recovery cache at a private temporary directory: every guarded
 * overwrite retains its displaced inode there and salam never prunes it, so
 * without this each run would leave hundreds of entries in the user's real
 * `~/Library/Caches/salam/recovery` (or `~/.cache`) until its capacity is spent.
 * Tests that need their own cache still set and restore `XDG_CACHE_HOME`.
 */
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

const required = packageJson.engines.bun;
if (!Bun.semver.satisfies(Bun.version, required))
	throw new Error(
		`salam tests need Bun ${required}, but this is Bun ${Bun.version} (${process.execPath}). Run \`bun run test\` to use the pinned copy.`,
	);

const PREFIX = "salam-test-cache-";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// Parallel workers are not always given an exit hook: each cache is named for
// its process, and any left by a process that is gone is removed here. Several
// workers start at once and race for the same leftovers, so this is best effort.
for (const name of readdirSync(tmpdir())) {
	const pid = Number(/^salam-test-cache-(\d+)-/.exec(name)?.[1]);
	if (!pid || pid === process.pid || alive(pid)) continue;
	try {
		rmSync(join(tmpdir(), name), { recursive: true, force: true });
	} catch {
		/* Another worker is removing it, or it is not ours to remove. */
	}
}

// Resolved: recovery roots refuse symlinked ancestors, and macOS's /var is one.
const cache = realpathSync(mkdtempSync(join(tmpdir(), `${PREFIX}${process.pid}-`)));
process.env.XDG_CACHE_HOME = cache;
process.on("exit", () => {
	try {
		rmSync(cache, { recursive: true, force: true });
	} catch {
		/* Left for the next run's sweep. */
	}
});
