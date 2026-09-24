import { Buffer } from "node:buffer";
import { chmodSync, closeSync, openSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ToolContext } from "../src/contracts.ts";
import { createFileOperationTools } from "../src/tools/file-ops.ts";
import { FreshnessTracker, type ToolEnvironment, Workspace } from "../src/tools/workspace.ts";
import { atomicRename } from "../src/tools/atomic-rename.ts";
import { type ExecOptions, type ExecResult, LocalExecutor } from "../src/tools/exec.ts";
import { LocalFs, observeMutations, readTextFile, RemoteFs } from "../src/tools/fs.ts";
import { REMOTE_ATOMIC_SOURCE } from "../src/tools/remote-atomic.ts";
import { REMOTE_HELPER_SOURCE } from "../src/tools/remote-helper.ts";
import type { RemoteExecutor } from "../src/tools/ssh.ts";
import { sha256Hex, shellQuote, ToolFailure } from "../src/tools/util.ts";

let root = "";
let sandbox = "";
let cache = "";
let previousCache: string | undefined;
const fs = new LocalFs();

beforeEach(async () => {
	sandbox = await realpath(await mkdtemp(join(tmpdir(), "salam-atomic-")));
	root = join(sandbox, "project");
	cache = join(sandbox, "cache");
	await mkdir(root);
	previousCache = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = cache;
});

afterEach(async () => {
	if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = previousCache;
	await rm(sandbox, { recursive: true, force: true });
});

async function recoveryDirectories(): Promise<string[]> {
	const directory = join(cache, "salam", "recovery");
	return (
		await readdir(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		})
	).map((name) => join(directory, name));
}

function recoveryDirectory(error: unknown): string {
	if (!(error instanceof ToolFailure))
		throw new Error(`Expected a recoverable mutation failure, got ${error}`);
	const details = error.details;
	if (
		!details ||
		typeof details !== "object" ||
		Array.isArray(details) ||
		!Array.isArray(details.recoveryPaths) ||
		typeof details.recoveryPaths[0] !== "string"
	)
		throw new Error("Mutation failure did not report a recovery directory");
	return details.recoveryPaths[0];
}

test("a second editor save during rollback remains recoverable alongside both earlier versions", async () => {
	const path = join(root, "shared.txt");
	await writeFile(path, "original\n");
	const exchange = atomicRename.exchange;
	let calls = 0;
	const hook = spyOn(atomicRename, "exchange").mockImplementation((source, target) => {
		if (target === path) writeFileSync(path, ++calls === 1 ? "editor one\n" : "editor two\n");
		exchange(source, target);
	});
	let error: unknown;
	try {
		await fs.write(path, "assistant\n", undefined, sha256Hex("original\n"));
	} catch (caught) {
		error = caught;
	} finally {
		hook.mockRestore();
	}
	const directory = recoveryDirectory(error);
	expect(await readFile(join(directory, "before"), "utf8")).toBe("original\n");
	expect(await readFile(join(directory, "displaced"), "utf8")).toBe("editor two\n");
	expect(await readFile(path, "utf8")).toBe("editor one\n");
});

test("a create-only commit never overwrites a file created at its syscall boundary", async () => {
	const path = join(root, "new.txt");
	const exclusive = atomicRename.exclusive;
	const hook = spyOn(atomicRename, "exclusive").mockImplementation((source, target) => {
		if (target === path) writeFileSync(path, "external creation\n");
		exclusive(source, target);
	});
	try {
		await expect(fs.write(path, "assistant\n", undefined, null)).rejects.toThrow();
	} finally {
		hook.mockRestore();
	}
	expect(await readFile(path, "utf8")).toBe("external creation\n");
});

test("a symlink introduced at exchange is refused and its target is not modified", async () => {
	const path = join(root, "victim.txt");
	const target = join(root, "outside.txt");
	await writeFile(path, "original\n");
	await writeFile(target, "outside\n");
	const exchange = atomicRename.exchange;
	let injected = false;
	const hook = spyOn(atomicRename, "exchange").mockImplementation((source, destination) => {
		if (!injected && destination === path) {
			injected = true;
			unlinkSync(path);
			symlinkSync(target, path);
		}
		exchange(source, destination);
	});
	try {
		await expect(fs.write(path, "assistant\n", undefined, sha256Hex("original\n"))).rejects.toThrow();
	} finally {
		hook.mockRestore();
	}
	expect((await lstat(path)).isSymbolicLink()).toBe(true);
	expect(await readlink(path)).toBe(target);
	expect(await readFile(target, "utf8")).toBe("outside\n");
});

test("a successful write preserves old-descriptor saves and original permissions", async () => {
	const path = join(root, "open-editor.txt");
	await writeFile(path, "original\n");
	await chmod(path, 0o751);
	const editor = await open(path, "r+");
	try {
		expect(await fs.write(path, "assistant\n", undefined, sha256Hex("original\n"))).toBe(
			sha256Hex("assistant\n"),
		);
		await editor.truncate(0);
		await editor.writeFile("late descriptor save\n");
	} finally {
		await editor.close();
	}
	const directory = (await recoveryDirectories())[0]!;
	expect(await readFile(join(directory, "displaced"), "utf8")).toBe("late descriptor save\n");
	expect(await readFile(path, "utf8")).toBe("assistant\n");
	expect((await stat(path)).mode & 0o777).toBe(0o751);
});

test("delete rollback cannot overwrite a second newly created destination", async () => {
	const path = join(root, "delete.txt");
	await writeFile(path, "original\n");
	const exclusive = atomicRename.exclusive;
	const hook = spyOn(atomicRename, "exclusive").mockImplementation((source, target) => {
		if (source === path) writeFileSync(path, "editor before retirement\n");
		if (target === path) writeFileSync(path, "editor before rollback\n");
		exclusive(source, target);
	});
	let error: unknown;
	try {
		await fs.remove(path, undefined, sha256Hex("original\n"));
	} catch (caught) {
		error = caught;
	} finally {
		hook.mockRestore();
	}
	const directory = recoveryDirectory(error);
	expect(await readFile(path, "utf8")).toBe("editor before rollback\n");
	expect(await readFile(join(directory, "displaced"), "utf8")).toBe("editor before retirement\n");
	expect(await readFile(join(directory, "before"), "utf8")).toBe("original\n");
});

test("a source edit during move restores the prior destination without discarding the edit", async () => {
	const source = join(root, "source.txt");
	const target = join(root, "destination.txt");
	await writeFile(source, "source\n");
	await writeFile(target, "destination\n");
	const destinationEditor = await open(target, "a");
	const exclusive = atomicRename.exclusive;
	let injected = false;
	const hook = spyOn(atomicRename, "exclusive").mockImplementation((from, to) => {
		if (!injected && from === source) {
			injected = true;
			writeFileSync(source, "editor source\n");
		}
		exclusive(from, to);
	});
	try {
		await expect(
			fs.move(source, target, undefined, sha256Hex("source\n"), sha256Hex("destination\n")),
		).rejects.toThrow();
		expect(await readFile(source, "utf8")).toBe("editor source\n");
		expect(await readFile(target, "utf8")).toBe("destination\n");
		await destinationEditor.writeFile("late descriptor save\n");
		expect(await readFile(target, "utf8")).toBe("destination\nlate descriptor save\n");
	} finally {
		hook.mockRestore();
		await destinationEditor.close();
	}
});

test("offset reads bound returned bytes and compute truncation after the slice", async () => {
	const path = join(root, "bytes.bin");
	await writeFile(path, Uint8Array.from([0, 1, 2, 3, 4, 255]));
	expect(await fs.readBytes(path, 2, undefined, 2)).toEqual({
		bytes: Uint8Array.from([2, 3]),
		truncated: true,
	});
	expect(await fs.readBytes(path, 2, undefined, 4)).toEqual({
		bytes: Uint8Array.from([4, 255]),
		truncated: false,
	});
	expect(await fs.readBytes(path, 0, undefined, 5)).toEqual({ bytes: new Uint8Array(), truncated: true });
	expect(await fs.readBytes(path, 10, undefined, 6)).toEqual({ bytes: new Uint8Array(), truncated: false });
	await expect(fs.readBytes(path, 2, undefined, -1)).rejects.toThrow();
});

test("editable UTF-8 reads retain BOM bytes and never replace invalid byte sequences", async () => {
	const path = join(root, "unicode.txt");
	const bytes = Buffer.from("\ufeffπ tail\n");
	await writeFile(path, bytes);
	const complete = await readTextFile(fs, path, bytes.length);
	expect(Buffer.from(complete.text)).toEqual(bytes);
	const partial = await readTextFile(fs, path, 4);
	expect(partial.text).toBe("\ufeff");
	expect(partial.truncated).toBe(true);
	await writeFile(path, Uint8Array.from([0xc3, 0x28]));
	await expect(readTextFile(fs, path, 10)).rejects.toThrow(/UTF-8/);
});

test("cancellation after exchange still validates and recovers the displaced external version", async () => {
	const path = join(root, "cancelled.txt");
	await writeFile(path, "original\n");
	const controller = new AbortController();
	const exchange = atomicRename.exchange;
	let injected = false;
	const hook = spyOn(atomicRename, "exchange").mockImplementation((source, target) => {
		const interrupt = !injected && target === path;
		if (interrupt) {
			injected = true;
			writeFileSync(path, "external at cancellation\n");
		}
		exchange(source, target);
		if (interrupt) controller.abort();
	});
	let error: unknown;
	try {
		await fs.write(path, "assistant\n", controller.signal, sha256Hex("original\n"));
	} catch (caught) {
		error = caught;
	} finally {
		hook.mockRestore();
	}
	const directory = recoveryDirectory(error);
	expect(await readFile(path, "utf8")).toBe("external at cancellation\n");
	expect(await readFile(join(directory, "displaced"), "utf8")).toBe("assistant\n");
});

async function remoteFixture(
	helper: string,
	transport?: (
		argv: readonly string[],
		options: ExecOptions,
		run: () => Promise<ExecResult>,
	) => Promise<ExecResult>,
): Promise<RemoteFs> {
	const executor = new LocalExecutor(root);
	// Only the SSH transport is replaced. Every operation runs the actual remote
	// helper in a separate process against this disposable target directory.
	return new RemoteFs({
		host: "disposable-ssh-target",
		defaultCwd: root,
		helperPath: async () => helper,
		exec: (argv: readonly string[], options: ExecOptions) =>
			transport ? transport(argv, options, () => executor.exec(argv, options)) : executor.exec(argv, options),
		execBytes: executor.execBytes.bind(executor),
	} as unknown as RemoteExecutor);
}

test("remote helper enforces hash/create guards and supports byte-offset reads", async () => {
	const helper = join(root, "helper.sh");
	await writeFile(helper, REMOTE_HELPER_SOURCE);
	const remote = await remoteFixture(helper);
	const path = join(root, "remote.bin");
	await remote.write(path, Uint8Array.from([0, 1, 2, 3, 255]), undefined, null);
	const middle = await remote.readBytes(path, 2, undefined, 2);
	expect([...middle.bytes]).toEqual([2, 3]);
	expect(middle.truncated).toBe(true);
	const end = await remote.readBytes(path, 8, undefined, 4);
	expect([...end.bytes]).toEqual([255]);
	expect(end.truncated).toBe(false);
	await expect(remote.write(path, "overwritten", undefined, null)).rejects.toThrow();
	await expect(remote.write(path, "overwritten", undefined, sha256Hex("wrong"))).rejects.toThrow();
	expect(await readFile(path)).toEqual(Buffer.from([0, 1, 2, 3, 255]));
});

test("remote exchange rollback and create-only races both preserve external versions", async () => {
	const path = join(root, "remote-race.txt");
	const newPath = join(root, "remote-create-race.txt");
	const module = join(root, "atomic_helper.py");
	const driver = join(root, "remote-driver.py");
	const helper = join(root, "driver.sh");
	const metadataHelper = join(root, "metadata-helper.sh");
	await writeFile(path, "original\n");
	await writeFile(module, REMOTE_ATOMIC_SOURCE);
	await writeFile(
		driver,
		`import importlib.util, sys
spec = importlib.util.spec_from_file_location("atomic_helper", ${JSON.stringify(module)})
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
native = helper.rename_atomic
calls = 0
def exchange(source, target, swap):
    global calls
    if target == ${JSON.stringify(path)} and swap:
        calls += 1
        with open(target, "w") as editor:
            editor.write("editor one\\n" if calls == 1 else "editor two\\n")
    if target == ${JSON.stringify(newPath)} and not swap:
        with open(target, "w") as editor:
            editor.write("external creation\\n")
    native(source, target, swap)
helper.rename_atomic = exchange
try:
    helper.main()
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(2)
`,
	);
	await writeFile(metadataHelper, REMOTE_HELPER_SOURCE);
	await writeFile(`${metadataHelper}.atomic`, REMOTE_ATOMIC_SOURCE);
	await writeFile(
		helper,
		`#!/bin/sh\nif [ "$1" = write ]; then exec python3 ${shellQuote(driver)} "$@"; fi\nexec sh ${shellQuote(metadataHelper)} "$@"\n`,
	);
	const remote = await remoteFixture(helper);
	let error: unknown;
	try {
		await remote.write(path, "assistant\n", undefined, sha256Hex("original\n"));
	} catch (caught) {
		error = caught;
	}
	const directory = recoveryDirectory(error);
	expect(await readFile(join(directory, "before"), "utf8")).toBe("original\n");
	expect(await readFile(join(directory, "displaced"), "utf8")).toBe("editor two\n");
	expect(await readFile(path, "utf8")).toBe("editor one\n");
	await expect(remote.write(newPath, "assistant\n", undefined, null)).rejects.toThrow();
	expect(await readFile(newPath, "utf8")).toBe("external creation\n");
});

test("recovery of tracked files and ignored secrets stays outside git and build contexts", async () => {
	const executor = new LocalExecutor(root);
	const git = async (...args: string[]) => {
		const result = await executor.exec(["git", ...args]);
		if (result.code !== 0) throw new Error(result.stderr);
		return result.stdout;
	};
	await git("init", "-q");
	await writeFile(join(root, ".gitignore"), ".env\n");
	await writeFile(join(root, "a.txt"), "original\n");
	const secret = "ignored-secret-that-must-not-enter-any-build-context";
	await writeFile(join(root, ".env"), secret);
	await git("add", ".gitignore", "a.txt");
	await git(
		"-c",
		"user.name=Atomic Test",
		"-c",
		"user.email=atomic@example.invalid",
		"commit",
		"-qm",
		"initial",
	);
	await fs.write(join(root, "a.txt"), "edited\n", undefined, sha256Hex("original\n"));
	await fs.remove(join(root, ".env"), undefined, sha256Hex(secret));
	expect(await git("status", "--porcelain")).toBe(" M a.txt\n");
	await git("add", "-A");
	expect(await git("diff", "--cached", "--name-only")).toBe("a.txt\n");
	for (const entry of await fs.list(root, 20, true)) {
		if (entry.kind === "file") expect((await readFile(entry.path)).includes(Buffer.from(secret))).toBe(false);
	}
	const recovered = await recoveryDirectories();
	expect(recovered.length).toBe(2);
	for (const directory of recovered) {
		expect(directory.startsWith(`${root}/`)).toBe(false);
		const info = await lstat(directory);
		expect(info.uid).toBe(process.getuid!());
		expect(info.mode & 0o777).toBe(0o700);
	}
	expect(
		(await Promise.all(recovered.map((directory) => readFile(join(directory, "displaced"), "utf8")))).sort(),
	).toEqual([secret, "original\n"].sort());
});

test("create-only success and unsupported volume failures leave no staging payloads", async () => {
	const made = join(root, "created.txt");
	await fs.write(made, "created\n", undefined, null);
	expect(await recoveryDirectories()).toEqual([]);
	const path = join(root, "unsupported.txt");
	await writeFile(path, "original\n");
	const hook = spyOn(atomicRename, "exchange").mockImplementation(() => {
		throw Object.assign(new Error("Atomic swap is unsupported"), { code: "ENOTSUP" });
	});
	try {
		await expect(fs.write(path, "proposal\n", undefined, sha256Hex("original\n"))).rejects.toThrow();
	} finally {
		hook.mockRestore();
	}
	expect(await readFile(path, "utf8")).toBe("original\n");
	expect(await readFile(made, "utf8")).toBe("created\n");
	expect(await recoveryDirectories()).toEqual([]);
	expect((await readdir(root)).sort()).toEqual(["created.txt", "unsupported.txt"]);
});

test("a symlinked recovery root cannot receive a secret payload", async () => {
	const path = join(root, "private.txt");
	await writeFile(path, "secret\n");
	await mkdir(join(cache, "salam"), { recursive: true, mode: 0o700 });
	const exposed = join(root, "exposed-cache");
	await mkdir(exposed);
	await symlink(exposed, join(cache, "salam", "recovery"));
	await expect(fs.write(path, "replacement\n", undefined, sha256Hex("secret\n"))).rejects.toThrow();
	expect(await readFile(path, "utf8")).toBe("secret\n");
	expect(await readdir(exposed)).toEqual([]);
});

test("full recovery capacity refuses staging rather than pruning a live retained inode", async () => {
	const recoveryRoot = join(cache, "salam", "recovery");
	await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
	await Promise.all(
		Array.from({ length: 1024 }, (_, index) => mkdir(join(recoveryRoot, `entry-${index}`), { mode: 0o700 })),
	);
	const retained = join(recoveryRoot, "entry-0", "displaced");
	await writeFile(retained, "retained\n");
	const editor = await open(retained, "a");
	const path = join(root, "next.txt");
	await writeFile(path, "before\n");
	try {
		await expect(fs.write(path, "proposal\n", undefined, sha256Hex("before\n"))).rejects.toThrow(/capacity/);
		await editor.writeFile("late save\n");
	} finally {
		await editor.close();
	}
	expect(await readFile(path, "utf8")).toBe("before\n");
	expect(await readFile(retained, "utf8")).toBe("retained\nlate save\n");
	expect((await readdir(recoveryRoot)).length).toBe(1024);
});

test("an ambiguous syscall failure retains displaced user bytes instead of deleting them as staging", async () => {
	const path = join(root, "uncertain.txt");
	await writeFile(path, "original\n");
	const exchange = atomicRename.exchange;
	const hook = spyOn(atomicRename, "exchange").mockImplementation((source, target) => {
		exchange(source, target);
		throw Object.assign(new Error("I/O result was lost"), { code: "EIO" });
	});
	let error: unknown;
	try {
		await fs.write(path, "proposal\n", undefined, sha256Hex("original\n"));
	} catch (caught) {
		error = caught;
	} finally {
		hook.mockRestore();
	}
	expect((error as ToolFailure).details).toMatchObject({ publication: "unknown" });
	expect(await readFile(path, "utf8")).toBe("proposal\n");
	expect(await readFile(join(recoveryDirectory(error), "displaced"), "utf8")).toBe("original\n");
});

test("write rollback restores a write-only inode still held by an editor", async () => {
	const path = join(root, "active-writer.txt");
	await writeFile(path, "original\n");
	const exchange = atomicRename.exchange;
	let editor: number | undefined;
	const hook = spyOn(atomicRename, "exchange").mockImplementation((source, target) => {
		if (target === path && editor === undefined) {
			editor = openSync(path, "w");
			writeSync(editor, "external");
			chmodSync(path, 0o200);
		}
		exchange(source, target);
	});
	try {
		await expect(fs.write(path, "proposal\n", undefined, sha256Hex("original\n"))).rejects.toThrow();
		writeSync(editor!, " continues\n");
		await chmod(path, 0o600);
		expect(await readFile(path, "utf8")).toBe("external continues\n");
	} finally {
		hook.mockRestore();
		if (editor !== undefined) closeSync(editor);
	}
});

test("remove rollback restores the open editor inode instead of a snapshot copy", async () => {
	const path = join(root, "active-delete.txt");
	await writeFile(path, "original\n");
	const exclusive = atomicRename.exclusive;
	let editor: number | undefined;
	const hook = spyOn(atomicRename, "exclusive").mockImplementation((source, target) => {
		if (source === path && editor === undefined) {
			editor = openSync(path, "w");
			writeSync(editor, "external");
			chmodSync(path, 0o200);
		}
		exclusive(source, target);
	});
	try {
		await expect(fs.remove(path, undefined, sha256Hex("original\n"))).rejects.toThrow();
		writeSync(editor!, " continues\n");
		await chmod(path, 0o600);
		expect(await readFile(path, "utf8")).toBe("external continues\n");
	} finally {
		hook.mockRestore();
		if (editor !== undefined) closeSync(editor);
	}
});

for (const variant of ["truncated", "extra", "corrupted"] as const) {
	test(`remote ${variant} stdin is refused before both replace and create-only publication`, async () => {
		const helper = join(root, "helper.sh");
		await writeFile(helper, REMOTE_HELPER_SOURCE);
		const remote = await remoteFixture(helper, async (argv, options, run) => {
			if (argv[2] === "write") {
				const payload = Buffer.from(options.stdin as Uint8Array);
				if (variant === "truncated") options.stdin = payload.subarray(0, Math.floor(payload.length / 2));
				else if (variant === "extra") options.stdin = Buffer.concat([payload, Buffer.from("extra")]);
				else {
					payload[0] = payload[0]! ^ 0xff;
					options.stdin = payload;
				}
			}
			return run();
		});
		const existing = join(root, "existing.txt");
		const missing = join(root, "missing.txt");
		await writeFile(existing, "original\n");
		await expect(
			remote.write(existing, "complete proposal\n", undefined, sha256Hex("original\n")),
		).rejects.toThrow();
		await expect(remote.write(missing, "complete proposal\n", undefined, null)).rejects.toThrow();
		expect(await readFile(existing, "utf8")).toBe("original\n");
		expect(await Bun.file(missing).exists()).toBe(false);
		expect(await recoveryDirectories()).toEqual([]);
	});
}

test("a cancelled transport reports unknown even when a full remote payload committed", async () => {
	const helper = join(root, "helper.sh");
	await writeFile(helper, REMOTE_HELPER_SOURCE);
	const remote = await remoteFixture(helper, async (argv, _options, run) => ({
		...(await run()),
		aborted: argv[2] === "write",
	}));
	const path = join(root, "cancelled-transport.txt");
	await writeFile(path, "old\n");
	let error: unknown;
	try {
		await remote.write(path, "full new payload\n", undefined, sha256Hex("old\n"));
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ToolFailure);
	expect((error as ToolFailure).details).toMatchObject({ publication: "unknown" });
	expect((error as Error).message).toMatch(/outcome is unknown/);
	expect(await readFile(path, "utf8")).toBe("full new payload\n");
	expect(await readFile(join(recoveryDirectory(error), "displaced"), "utf8")).toBe("old\n");
});

test("remote full mode snapshots chain with guarded writes and chmod receipts", async () => {
	const helper = join(root, "helper.sh");
	await writeFile(helper, REMOTE_HELPER_SOURCE);
	const remote = await remoteFixture(helper);
	const path = join(root, "special-mode.txt");
	await writeFile(path, "old\n");
	await chmod(path, 0o2755);
	const before = await remote.stat(path);
	expect(before.mode).toBe(0o2755);
	await observeMutations(
		{
			observe: (_fs, mutation, apply) => {
				mutation.expectedModes = [before.mode];
				return apply();
			},
		},
		() => remote.write(path, "new\n", undefined, sha256Hex("old\n")),
	);
	expect((await remote.stat(path)).mode).toBe(0o2755);
	await remote.chmod(path, 0o4755, undefined, sha256Hex("new\n"));
	expect((await remote.stat(path)).mode).toBe(0o4755);
	expect(await readFile(path, "utf8")).toBe("new\n");
});

test("directory retirement rolls back an externally added child with the original inode", async () => {
	const path = join(root, "empty");
	await mkdir(path);
	const inode = (await stat(path)).ino;
	const exclusive = atomicRename.exclusive;
	const hook = spyOn(atomicRename, "exclusive").mockImplementation((source, target) => {
		if (source === path) writeFileSync(join(path, "external"), "editor data");
		exclusive(source, target);
	});
	try {
		await expect(fs.rmdir(path)).rejects.toThrow();
	} finally {
		hook.mockRestore();
	}
	expect((await stat(path)).ino).toBe(inode);
	expect(await readFile(join(path, "external"), "utf8")).toBe("editor data");
});

test("remote observed parents and directory entries preserve newline names and reject links", async () => {
	const helper = join(root, "helper.sh");
	await writeFile(helper, REMOTE_HELPER_SOURCE);
	const remote = await remoteFixture(helper);
	const path = join(root, "nested", "deep", "line\\nname");
	const mutated: string[] = [];
	await observeMutations(
		{
			async observe(_fs, mutation, apply) {
				mutated.push(mutation.path);
				return apply();
			},
		},
		() => remote.write(path, "bytes", undefined, null),
	);
	expect(mutated).toEqual([join(root, "nested"), join(root, "nested", "deep"), path]);
	expect(await remote.entries(join(root, "nested", "deep"))).toEqual([{ path, kind: "file" }]);
	await expect(remote.rmdir(join(root, "nested", "deep"))).rejects.toThrow();
	expect(await readFile(path, "utf8")).toBe("bytes");
	await remote.remove(path, undefined, sha256Hex("bytes"));
	await remote.rmdir(join(root, "nested", "deep"));
	await remote.mkdir(join(root, "nested", "deep"), undefined, 0o750);
	expect((await remote.stat(join(root, "nested", "deep"))).mode).toBe(0o750);
	await symlink(join(root, "nested"), join(root, "link"));
	await expect(remote.write(join(root, "link", "unsafe"), "no", undefined, null)).rejects.toThrow();
	expect(await Bun.file(join(root, "nested", "unsafe")).exists()).toBe(false);
});

test("remote tree operations move populated and empty descendants then recursively remove them", async () => {
	const helper = join(root, "helper.sh");
	await writeFile(helper, REMOTE_HELPER_SOURCE);
	const remote = await remoteFixture(helper);
	const source = join(root, "source");
	const destination = join(root, "parents", "destination");
	await mkdir(join(source, "empty"), { recursive: true });
	await writeFile(join(source, "file"), "remote payload");
	await chmod(join(source, "file"), 0o751);
	const workspace = new Workspace("remote-fixture", "target", new LocalExecutor(root), remote, true);
	const tool = createFileOperationTools({
		workspace: () => workspace,
		freshness: new FreshnessTracker(),
	} as unknown as ToolEnvironment)[0]!;
	const scoped: string[][] = [];
	const context: ToolContext = {
		cwd: root,
		agentId: "main",
		sessionId: "remote-test",
		signal: AbortSignal.any([]),
		emit: () => undefined,
		checkMutationPaths: async (paths) => {
			scoped.push(paths);
		},
	};
	const inspected = JSON.parse((await tool.execute({ op: "inspect", path: source }, context)).text);
	const moved = await tool.execute(
		{ op: "move", path: source, to: destination, expected_tree: inspected.tree_hash },
		context,
	);
	expect(moved.isError).not.toBe(true);
	expect(await readFile(join(destination, "file"), "utf8")).toBe("remote payload");
	expect((await stat(join(destination, "file"))).mode & 0o777).toBe(0o751);
	expect((await stat(join(destination, "empty"))).isDirectory()).toBe(true);
	expect(scoped[0]).toContain(join(source, "file"));
	expect(scoped[0]).toContain(join(destination, "file"));
	expect(scoped[0]).toContain(join(root, "parents"));
	const current = JSON.parse((await tool.execute({ op: "inspect", path: destination }, context)).text);
	const removed = await tool.execute(
		{ op: "remove", path: destination, recursive: true, expected_tree: current.tree_hash },
		context,
	);
	expect(removed.isError).not.toBe(true);
	expect((await remote.stat(destination)).kind).toBe("missing");
}, 15_000);
