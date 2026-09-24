import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rm,
	unlink,
	writeFile,
	type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicRename } from "./atomic-rename.ts";
import { errorText, ToolFailure } from "./util.ts";

export type CommittedFile =
	| { kind: "missing" }
	| { kind: "dir"; mode: number }
	| { kind: "file"; hash: string; size: number; mode: number };
export type MutationPublication = "unpublished" | "rolled-back" | "unknown";
type PresentFile = Extract<CommittedFile, { kind: "file" }> & { dev: number; ino: number };
interface WriteOptions {
	expectedMode?: number;
	mode?: number;
}
interface WriteReceipt {
	file: PresentFile;
	/** The original inode, not a snapshot: another editor may still hold it open. */
	displaced?: string;
	directory?: string;
}
interface Rollback {
	publication: MutationPublication;
	note: string;
}

// An entry-count bound is intentional: live descriptors can grow retained inodes
// at any time, so neither an age sweep nor a nominal byte quota makes deletion safe.
const RECOVERY_CAPACITY = 1024;
const UNPUBLISHED_RENAME_CODES: Record<string, true> = {
	EACCES: true,
	EEXIST: true,
	EINVAL: true,
	ENOTSUP: true,
	EOPNOTSUPP: true,
	ENOSYS: true,
	ENOENT: true,
	ENOTDIR: true,
	EISDIR: true,
	EXDEV: true,
	ENOTEMPTY: true,
	EPERM: true,
	ENOSPC: true,
	EDQUOT: true,
	EBUSY: true,
	EBADF: true,
	ENAMETOOLONG: true,
	ELOOP: true,
	EROFS: true,
};

function renameDefinitelyFailed(error: unknown): boolean {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	// In particular, EIO/transport-like errors are not proof of no publication.
	return typeof code === "string" && Object.hasOwn(UNPUBLISHED_RENAME_CODES, code);
}

export function requireExpectedHash(value: string | null, missingAllowed = true): void {
	if ((value === null && missingAllowed) || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)))
		return;
	throw new ToolFailure(
		`An explicit ${missingAllowed ? "SHA256 expected hash or null (create only)" : "SHA256 expected hash"} is required for every file mutation.`,
	);
}

export function mutationPublication(error: unknown): MutationPublication {
	const details = error instanceof ToolFailure ? error.details : undefined;
	if (details && typeof details === "object" && !Array.isArray(details)) {
		if (details.publication === "unpublished" || details.publication === "rolled-back")
			return details.publication;
	}
	return "unknown";
}

/** Copies and hashes one open, no-follow descriptor. Never hashes a different inode than the saved bytes. */
async function capture(path: string, destination?: string, signal?: AbortSignal): Promise<PresentFile> {
	signal?.throwIfAborted();
	const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let output: FileHandle | undefined;
	try {
		const before = await input.stat();
		if (!before.isFile()) throw new ToolFailure(`${path} is not a regular file; refusing to change it.`);
		if (destination) output = await open(destination, "wx", 0o600);
		const hasher = new Bun.CryptoHasher("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let size = 0;
		for (;;) {
			signal?.throwIfAborted();
			const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			const chunk = buffer.subarray(0, bytesRead);
			hasher.update(chunk);
			if (output) await output.writeFile(chunk);
			size += bytesRead;
		}
		const after = await input.stat();
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
			throw new ToolFailure(`${path} changed while its bytes were being preserved.`);
		if (output) {
			await output.chmod(before.mode & 0o7777);
			await output.sync();
		}
		return {
			kind: "file",
			hash: hasher.digest("hex"),
			size,
			mode: before.mode & 0o7777,
			dev: before.dev,
			ino: before.ino,
		};
	} finally {
		try {
			await output?.close();
		} finally {
			await input.close();
		}
	}
}

async function expectFile(
	path: string,
	expectedHash: string | null,
	backup?: string,
	signal?: AbortSignal,
	expectedMode?: number,
): Promise<PresentFile | undefined> {
	if (expectedHash === null) {
		try {
			await lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		throw new ToolFailure(`${path} already exists; create-only mutation refused.`);
	}
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) throw new ToolFailure(`${path} is a symbolic link; refusing to change it.`);
	const current = await capture(path, backup, signal);
	if (current.hash !== expectedHash || (expectedMode !== undefined && current.mode !== expectedMode))
		throw new ToolFailure(
			`${path} changed on disk (expected ${expectedHash}, found ${current.hash}); mutation refused.`,
		);
	return current;
}

function within(path: string, directory: string): boolean {
	const suffix = relative(directory, path);
	return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

/** Every ancestor must prevent a different uid replacing our next path component. */
async function privateRoot(path: string, device: number): Promise<FileHandle> {
	const uid = process.getuid!();
	const parts = resolve(path).split(sep).filter(Boolean);
	let current: string = sep;
	for (const [index, part] of parts.entries()) {
		const parent = await lstat(current);
		if (
			!parent.isDirectory() ||
			(parent.uid !== uid && parent.uid !== 0) ||
			((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0)
		)
			throw new ToolFailure(
				`Recovery ancestor ${current} permits unsafe ownership or pathname substitution.`,
			);
		current = join(current, part);
		try {
			await mkdir(current, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const info = await lstat(current);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new ToolFailure(`Recovery path ${current} is not a real directory; symlinks are refused.`);
		if (index === parts.length - 1 && (info.uid !== uid || (info.mode & 0o077) !== 0 || info.dev !== device))
			throw new ToolFailure(
				`Recovery root ${current} must be owner-private (0700), owned by uid ${uid}, and on the destination filesystem.`,
			);
	}
	const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const actual = await handle.stat();
		const named = await lstat(path);
		if (
			actual.dev !== device ||
			actual.uid !== uid ||
			(actual.mode & 0o077) !== 0 ||
			named.dev !== actual.dev ||
			named.ino !== actual.ino ||
			named.isSymbolicLink()
		)
			throw new ToolFailure(`Recovery root ${path} changed while it was being opened.`);
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function recovery(path: string, operation: string, expectedHash: string | null): Promise<string> {
	const parent = await realpath(dirname(path));
	const device = (await lstat(parent)).dev;
	const boundaries = [parent];
	const cwd = await realpath(process.cwd());
	if (within(parent, cwd)) boundaries.push(cwd);
	let mount = parent;
	for (let ancestor = parent; ; ancestor = dirname(ancestor)) {
		try {
			await lstat(join(ancestor, ".git"));
			boundaries.push(ancestor);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const above = dirname(ancestor);
		if (above === ancestor) break;
		if ((await lstat(above)).dev !== device) break;
		mount = above;
	}
	const home = await realpath(homedir());
	const cache =
		process.env.XDG_CACHE_HOME || join(home, process.platform === "darwin" ? "Library/Caches" : ".cache");
	const candidates = [join(cache, "salam", "recovery"), join(mount, `.salam-recovery-${process.getuid!()}`)];
	const refused: string[] = [];
	for (const root of candidates) {
		if (!isAbsolute(root) || boundaries.some((boundary) => within(root, boundary))) {
			refused.push(`${root}: inside the working tree`);
			continue;
		}
		try {
			// Do not create a cache on another filesystem just to reject it afterwards.
			let existing = root;
			while (true) {
				try {
					if ((await lstat(existing)).dev !== device) throw new ToolFailure("different filesystem");
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					existing = dirname(existing);
				}
			}
		} catch (error) {
			refused.push(`${root}: ${errorText(error)}`);
			continue;
		}
		// An unsafe existing same-device cache is a hard refusal, not a reason to
		// silently choose another location and hide evidence of substitution.
		const handle = await privateRoot(root, device);
		try {
			const entries = new Set(await readdir(root));
			for (let slot = 0; slot < RECOVERY_CAPACITY; slot++) {
				const name = `entry-${slot}`;
				if (entries.has(name)) continue;
				const actual = await handle.stat();
				const named = await lstat(root);
				if (named.isSymbolicLink() || named.dev !== actual.dev || named.ino !== actual.ino)
					throw new ToolFailure(`Recovery root ${root} was substituted.`);
				const directory = join(root, name);
				try {
					await mkdir(directory, { mode: 0o700 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
					throw error;
				}
				try {
					await writeFile(
						join(directory, "manifest.json"),
						JSON.stringify({
							path: resolve(path),
							operation,
							expectedHash,
							createdAt: new Date().toISOString(),
							retention:
								"Retained inodes may still have open writers. No automatic pruning; inspect before manual removal.",
						}) + "\n",
						{ flag: "wx", mode: 0o600 },
					);
					return directory;
				} catch (error) {
					await rm(directory, { recursive: true, force: true }).catch(() => undefined);
					throw error;
				}
			}
			throw new ToolFailure(
				`Recovery capacity reached (${RECOVERY_CAPACITY} retained operations) at ${root}. No new staging was created. Inspect and manually remove only recovery entries whose editor descriptors are closed and whose data is no longer needed; salam never prunes displaced inodes automatically.`,
				{ recoveryPaths: [root] },
			);
		} finally {
			await handle.close();
		}
	}
	throw new ToolFailure(
		`No safe owner-private same-filesystem recovery location exists outside the working tree. ${refused.join("; ")}. Nothing was published.`,
	);
}

function recoveryPaths(error: unknown): string[] {
	const details = error instanceof ToolFailure ? error.details : undefined;
	return details &&
		typeof details === "object" &&
		!Array.isArray(details) &&
		Array.isArray(details.recoveryPaths)
		? details.recoveryPaths.filter((value): value is string => typeof value === "string")
		: [];
}

function failure(
	path: string,
	reason: unknown,
	directories: string[],
	publication: MutationPublication,
	recoveryNote = "",
): ToolFailure {
	const paths = [...new Set([...directories, ...recoveryPaths(reason)])];
	const state =
		publication === "unpublished"
			? "Nothing was published."
			: publication === "rolled-back"
				? "The mutation was rolled back; external changes were preserved."
				: "Publication outcome is uncertain; inspect the destination before retrying.";
	return new ToolFailure(
		`Cannot safely change ${path}: ${errorText(reason)}. ${state} ${recoveryNote}${paths.length ? `Recovery paths outside the working tree (owner-private; never automatically pruned): ${paths.map((value) => JSON.stringify(value)).join(", ")}. Retained inodes may have live editor descriptors; inspect before manual removal.` : "Unpublished staging was removed."}`,
		{ recoveryPaths: paths, publication },
	);
}

/** Only use for entries that have never been public. Never unlink a displaced inode. */
async function discardStaging(directory: string | undefined): Promise<string[]> {
	if (!directory) return [];
	try {
		await rm(directory, { recursive: true, force: true });
		return [];
	} catch {
		return [directory];
	}
}

/** Exchange restores the very inode an editor holds; a second racing save is retained. */
async function rollbackWrite(path: string, displaced: string, proposed: PresentFile): Promise<Rollback> {
	try {
		const now = await capture(path);
		if (
			now.dev !== proposed.dev ||
			now.ino !== proposed.ino ||
			now.hash !== proposed.hash ||
			now.mode !== proposed.mode
		)
			return {
				publication: "unknown",
				note: `Rollback left the destination alone because it changed again; displaced entry: ${JSON.stringify(displaced)}. `,
			};
		atomicRename.exchange(displaced, path);
		const again = await capture(displaced).catch(() => undefined);
		return again?.dev === proposed.dev &&
			again.ino === proposed.ino &&
			again.hash === proposed.hash &&
			again.mode === proposed.mode
			? {
					publication: "rolled-back",
					note: `Rollback restored the displaced inode itself; the previously published proposal remains at ${JSON.stringify(displaced)}. `,
				}
			: {
					publication: "unknown",
					note: `Rollback raced another save; its displaced inode remains at ${JSON.stringify(displaced)}, and the earlier displaced inode is back at ${JSON.stringify(path)}. `,
				};
	} catch (error) {
		return {
			publication: "unknown",
			note: `Rollback could not finish (${errorText(error)}); the displaced entry remains at ${JSON.stringify(displaced)}. `,
		};
	}
}

async function commitWrite(
	path: string,
	expectedHash: string | null,
	signal: AbortSignal | undefined,
	options: WriteOptions,
	prepare: (stage: string, mode: number | undefined) => Promise<void>,
): Promise<WriteReceipt> {
	let directory: string | undefined;
	let exchanged = false;
	let commitAttempted = false;
	let proposed: PresentFile | undefined;
	try {
		requireExpectedHash(expectedHash);
		signal?.throwIfAborted();
		atomicRename.ensureSupported();
		directory = await recovery(path, "write", expectedHash);
		const displaced = join(directory, "displaced");
		const original = await expectFile(
			path,
			expectedHash,
			join(directory, "before"),
			signal,
			options.expectedMode,
		);
		await prepare(displaced, options.mode ?? original?.mode);
		proposed = await capture(displaced, undefined, signal);
		signal?.throwIfAborted();
		commitAttempted = true;
		if (expectedHash === null) {
			atomicRename.exclusive(displaced, path);
			// The directory now contains metadata only, never a formerly public inode.
			await discardStaging(directory);
			return { file: proposed };
		}
		atomicRename.exchange(displaced, path);
		exchanged = true;
		// Finish validation/recovery even if the caller was cancelled after exchange.
		const actual = await capture(displaced);
		if (actual.hash !== expectedHash || actual.mode !== original!.mode)
			throw new ToolFailure(
				`An external version was displaced at commit (expected ${expectedHash}, found ${actual.hash}); this write did not succeed.`,
			);
		await unlink(join(directory, "before")).catch(() => undefined);
		return { file: proposed, displaced, directory };
	} catch (error) {
		const uncertain = commitAttempted && !exchanged && !renameDefinitelyFailed(error);
		const rollback =
			exchanged && proposed ? await rollbackWrite(path, join(directory!, "displaced"), proposed) : undefined;
		const paths = exchanged || uncertain ? [directory!] : await discardStaging(directory);
		throw failure(
			path,
			error,
			paths,
			rollback?.publication ?? (uncertain ? "unknown" : "unpublished"),
			rollback?.note,
		);
	}
}

export async function writeAtomic(
	path: string,
	data: string | Uint8Array,
	signal: AbortSignal | undefined,
	expectedHash: string | null,
	options: WriteOptions = {},
): Promise<PresentFile> {
	return (
		await commitWrite(path, expectedHash, signal, options, async (stage, mode) => {
			const output = await open(stage, "wx", 0o666);
			try {
				await output.writeFile(data);
				if (mode !== undefined) await output.chmod(mode);
				await output.sync();
			} finally {
				await output.close();
			}
		})
	).file;
}

async function retireAtomic(
	path: string,
	signal: AbortSignal | undefined,
	expectedHash: string,
	expectedMode?: number,
): Promise<string> {
	let directory: string | undefined;
	let retired = false;
	let retireAttempted = false;
	try {
		requireExpectedHash(expectedHash, false);
		signal?.throwIfAborted();
		atomicRename.ensureSupported();
		directory = await recovery(path, "remove", expectedHash);
		const displaced = join(directory, "displaced");
		const original = await expectFile(path, expectedHash, join(directory, "before"), signal, expectedMode);
		signal?.throwIfAborted();
		retireAttempted = true;
		atomicRename.exclusive(path, displaced);
		retired = true;
		const actual = await capture(displaced);
		if (actual.hash !== expectedHash || actual.mode !== original!.mode)
			throw new ToolFailure(
				`An external version arrived before deletion (expected ${expectedHash}, found ${actual.hash}).`,
			);
		await unlink(join(directory, "before")).catch(() => undefined);
		return directory;
	} catch (error) {
		let publication: MutationPublication =
			retireAttempted && !renameDefinitelyFailed(error) ? "unknown" : "unpublished";
		let note = "";
		if (retired) {
			publication = "unknown";
			try {
				atomicRename.exclusive(join(directory!, "displaced"), path);
				publication = "rolled-back";
				note = "The displaced inode itself was put back using create-if-absent. ";
			} catch (rollbackError) {
				note = `Rollback did not overwrite the destination (${errorText(rollbackError)}); the displaced inode remains at ${JSON.stringify(join(directory!, "displaced"))}. `;
			}
		}
		throw failure(
			path,
			error,
			publication === "unknown" ? [directory!] : await discardStaging(directory),
			publication,
			note,
		);
	}
}

export async function removeAtomic(
	path: string,
	signal: AbortSignal | undefined,
	expectedHash: string,
	expectedMode?: number,
): Promise<void> {
	await retireAtomic(path, signal, expectedHash, expectedMode);
}

export async function moveAtomic(
	from: string,
	to: string,
	signal: AbortSignal | undefined,
	expectedSourceHash: string,
	expectedDestinationHash: string | null,
	expectedModes: (number | undefined)[] = [],
): Promise<PresentFile> {
	let directory: string | undefined;
	let publication: MutationPublication = "unpublished";
	try {
		requireExpectedHash(expectedSourceHash, false);
		requireExpectedHash(expectedDestinationHash);
		signal?.throwIfAborted();
		atomicRename.ensureSupported();
		directory = await recovery(from, "move", expectedSourceHash);
		const source = await expectFile(
			from,
			expectedSourceHash,
			join(directory, "source-before"),
			signal,
			expectedModes[0],
		);
		await expectFile(to, expectedDestinationHash, undefined, signal, expectedModes[1]);
		if (from === to) {
			await discardStaging(directory);
			return source!;
		}
		let written: WriteReceipt;
		try {
			written = await commitWrite(
				to,
				expectedDestinationHash,
				signal,
				{ expectedMode: expectedModes[1], mode: source!.mode },
				async (stage, mode) => {
					await copyFile(join(directory!, "source-before"), stage, constants.COPYFILE_EXCL);
					await chmod(stage, mode!);
				},
			);
		} catch (error) {
			publication = mutationPublication(error);
			throw error;
		}
		publication = "unknown";
		try {
			await removeAtomic(from, signal, expectedSourceHash, source!.mode);
		} catch (error) {
			let rollback: Rollback;
			const destinationRecovery = written.directory ? [written.directory] : [];
			if (written.displaced) rollback = await rollbackWrite(to, written.displaced, written.file);
			else {
				try {
					const retired = await retireAtomic(to, undefined, written.file.hash, written.file.mode);
					destinationRecovery.push(retired);
					rollback = {
						publication: "rolled-back",
						note: `The completed create-only destination was conditionally retired; its previously published inode remains at ${JSON.stringify(retired)}. `,
					};
				} catch (rollbackError) {
					throw failure(
						from,
						rollbackError,
						[directory, ...destinationRecovery, ...recoveryPaths(error)],
						"unknown",
						`Source retirement failed: ${errorText(error)}. `,
					);
				}
			}
			publication =
				mutationPublication(error) !== "unknown" && rollback.publication === "rolled-back"
					? "rolled-back"
					: "unknown";
			throw failure(from, error, destinationRecovery, publication, rollback.note);
		}
		await discardStaging(directory);
		return written.file;
	} catch (error) {
		throw failure(
			from,
			error,
			publication === "unknown" && directory ? [directory] : await discardStaging(directory),
			publication,
		);
	}
}

/** chmod through an open descriptor never follows a replacement symlink or chmods a replacement inode. */
export async function chmodGuarded(
	path: string,
	mode: number,
	signal: AbortSignal | undefined,
	expectedHash: string,
	expectedMode?: number,
): Promise<PresentFile> {
	let file: FileHandle | undefined;
	let changed = false;
	try {
		requireExpectedHash(expectedHash, false);
		if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)
			throw new ToolFailure("File mode must be an integer between 0 and 07777.");
		signal?.throwIfAborted();
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const before = await file.stat();
		if (!before.isFile()) throw new ToolFailure(`${path} is not a regular file.`);
		if (expectedMode !== undefined && (before.mode & 0o7777) !== expectedMode)
			throw new ToolFailure(`${path} permissions changed before its mode could be restored.`);
		const hasher = new Bun.CryptoHasher("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let size = 0;
		for (;;) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			hasher.update(buffer.subarray(0, bytesRead));
			size += bytesRead;
		}
		const after = await file.stat();
		if (
			hasher.digest("hex") !== expectedHash ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new ToolFailure(`${path} changed before its mode could be restored.`);
		signal?.throwIfAborted();
		await file.chmod(mode);
		changed = true;
		return { kind: "file", hash: expectedHash, size, mode, dev: before.dev, ino: before.ino };
	} catch (error) {
		throw failure(path, error, [], changed ? "unknown" : "unpublished");
	} finally {
		try {
			await file?.close();
		} catch (error) {
			throw failure(path, error, [], changed ? "unknown" : "unpublished");
		}
	}
}

/** Publish a staged directory so its exact mode is fixed before it becomes visible. */
export async function mkdirAtomic(
	path: string,
	signal?: AbortSignal,
	mode = 0o777 & ~process.umask(),
): Promise<Extract<CommittedFile, { kind: "dir" }>> {
	let directory: string | undefined;
	let attempted = false;
	try {
		signal?.throwIfAborted();
		atomicRename.ensureSupported();
		directory = await recovery(path, "mkdir", null);
		const stage = join(directory, "directory");
		await mkdir(stage, { mode });
		await chmod(stage, mode);
		signal?.throwIfAborted();
		attempted = true;
		atomicRename.exclusive(stage, path);
		await discardStaging(directory);
		return { kind: "dir", mode };
	} catch (error) {
		const uncertain = attempted && !renameDefinitelyFailed(error);
		throw failure(
			path,
			error,
			uncertain && directory ? [directory] : await discardStaging(directory),
			uncertain ? "unknown" : "unpublished",
		);
	}
}

/** Retire only an empty, unchanged directory; never unlink an unknown descendant. */
export async function rmdirAtomic(path: string, signal?: AbortSignal, expectedMode?: number): Promise<void> {
	let directory: string | undefined;
	let retired = false;
	let attempted = false;
	try {
		signal?.throwIfAborted();
		atomicRename.ensureSupported();
		const before = await lstat(path);
		if (!before.isDirectory() || (expectedMode !== undefined && (before.mode & 0o7777) !== expectedMode))
			throw new ToolFailure(`${path} is not the expected directory.`);
		if ((await readdir(path)).length)
			throw new ToolFailure(`${path} is not empty; refusing to remove unreviewed descendants.`);
		directory = await recovery(path, "rmdir", null);
		signal?.throwIfAborted();
		attempted = true;
		const displaced = join(directory, "displaced");
		atomicRename.exclusive(path, displaced);
		retired = true;
		const after = await lstat(displaced);
		if (
			!after.isDirectory() ||
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			(after.mode & 0o7777) !== (before.mode & 0o7777) ||
			(await readdir(displaced)).length
		)
			throw new ToolFailure(`${path} changed before directory retirement.`);
		// Retain even empty retired inodes: another process may hold a directory fd.
	} catch (error) {
		let publication: MutationPublication =
			attempted && !renameDefinitelyFailed(error) ? "unknown" : "unpublished";
		let note = "";
		if (retired) {
			publication = "unknown";
			try {
				atomicRename.exclusive(join(directory!, "displaced"), path);
				publication = "rolled-back";
			} catch (rollbackError) {
				note = `Directory rollback refused to overwrite a replacement: ${errorText(rollbackError)}. `;
			}
		}
		throw failure(
			path,
			error,
			publication === "unknown" && directory ? [directory] : await discardStaging(directory),
			publication,
			note,
		);
	}
}

export async function chmodDirectoryGuarded(
	path: string,
	mode: number,
	signal?: AbortSignal,
	expectedMode?: number,
): Promise<Extract<CommittedFile, { kind: "dir" }>> {
	let file: FileHandle | undefined;
	let changed = false;
	try {
		if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)
			throw new ToolFailure("Invalid directory mode.");
		signal?.throwIfAborted();
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
		const info = await file.stat();
		if (!info.isDirectory() || (expectedMode !== undefined && (info.mode & 0o7777) !== expectedMode))
			throw new ToolFailure(`${path} is not the expected directory.`);
		signal?.throwIfAborted();
		await file.chmod(mode);
		changed = true;
		return { kind: "dir", mode };
	} catch (error) {
		throw failure(path, error, [], changed ? "unknown" : "unpublished");
	} finally {
		await file?.close();
	}
}
