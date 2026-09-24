import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { lstat, readdir, stat as statFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	chmodGuarded,
	chmodDirectoryGuarded,
	type CommittedFile,
	mkdirAtomic,
	rmdirAtomic,
	moveAtomic,
	removeAtomic,
	requireExpectedHash,
	writeAtomic,
} from "./atomic-io.ts";
import type { RemoteExecutor } from "./ssh.ts";
import { looksBinary } from "./text.ts";
import { sha256Hex, ToolFailure } from "./util.ts";

export type FileKind = "file" | "dir" | "other" | "missing";

export interface FileStat {
	kind: FileKind;
	size: number;
	mtimeMs: number;
	mode: number | undefined;
	/**
	 * True when the path itself is a symbolic link. `kind`, `size` and `mode`
	 * still describe the link's target, so a caller that must not follow a link
	 * has to check this flag explicitly.
	 */
	symlink?: boolean;
	/** sha256 of the file contents; present for regular files unless suppressed. */
	hash?: string;
}

export interface ReadBytesResult {
	bytes: Uint8Array;
	/** True when bytes remain after this bounded slice (not before its offset). */
	truncated: boolean;
}

export interface DirEntry {
	path: string;
	kind: "file" | "dir";
}

/**
 * Filesystem surface bound to one execution site. A remote session only ever
 * holds a `RemoteFs`, so there is no code path by which a remote tool call can
 * read or mutate a local file.
 */
export interface WorkspaceFs {
	stat(path: string, options?: { hash?: boolean; signal?: AbortSignal }): Promise<FileStat>;
	hash(path: string, signal?: AbortSignal): Promise<string>;
	readBytes(path: string, maxBytes: number, signal?: AbortSignal, offset?: number): Promise<ReadBytesResult>;
	/** Guarded replace/create. Recovery inodes stay in a private same-device cache outside the tree; failures report paths and publication certainty. */
	write(
		path: string,
		data: string | Uint8Array,
		signal: AbortSignal | undefined,
		expectedHash: string | null,
		mode?: number,
	): Promise<string>;
	mkdirp(path: string, signal?: AbortSignal): Promise<void>;
	mkdir(path: string, signal?: AbortSignal, mode?: number): Promise<void>;
	rmdir(path: string, signal?: AbortSignal, expectedMode?: number): Promise<void>;
	chmodDirectory(path: string, mode: number, signal?: AbortSignal, expectedMode?: number): Promise<void>;
	entries(path: string, signal?: AbortSignal): Promise<DirEntry[]>;
	remove(path: string, signal: AbortSignal | undefined, expectedHash: string): Promise<void>;
	move(
		from: string,
		to: string,
		signal: AbortSignal | undefined,
		expectedSourceHash: string,
		expectedDestinationHash: string | null,
	): Promise<void>;
	chmod(path: string, mode: number, signal: AbortSignal | undefined, expectedHash: string): Promise<void>;
	list(path: string, depth: number, hidden: boolean, signal?: AbortSignal): Promise<DirEntry[]>;
}

/**
 * One mutation a workspace is about to perform, described by every path it can
 * change. A write carries its payload size so an observer can decide whether it
 * is willing to let the change happen at all before any bytes move.
 */
export type FsMutation = (
	| {
			kind: "write";
			path: string;
			bytes: number;
			data?: Uint8Array;
			expectedHash: string | null;
			mode?: number;
	  }
	| { kind: "mkdir"; path: string; mode?: number }
	| { kind: "rmdir"; path: string; mode?: number }
	| { kind: "dirmode"; path: string; mode: number }
	| { kind: "remove"; path: string; expectedHash: string }
	| {
			kind: "move";
			path: string;
			to: string;
			expectedSourceHash: string;
			expectedDestinationHash: string | null;
	  }
) & {
	/** A checkpoint binds its captured permissions as well as the caller's content guard. */
	expectedModes?: (number | undefined)[];
	/** Exact committed states, never a later observation that could belong to an external editor. */
	committed?: CommittedFile[];
};

/**
 * Wrapped around every mutation a `WorkspaceFs` performs while it is installed.
 * The observer sees the operation before it runs, so it can record what is
 * about to be destroyed, and refuse a change it would not be able to undo.
 */
export interface FsMutationObserver {
	observe<T>(fs: WorkspaceFs, mutation: FsMutation, apply: () => Promise<T>): Promise<T>;
}

/**
 * Scoped per async execution rather than per instance: workspaces (and their
 * filesystems) are cached and shared by every tool call, so the only correct
 * meaning of "the writes belonging to this call" is the dynamic extent of the
 * call itself.
 */
const mutationScope = new AsyncLocalStorage<FsMutationObserver>();

/** Runs `body` with `observer` watching every mutation it performs. */
export function observeMutations<T>(observer: FsMutationObserver, body: () => Promise<T>): Promise<T> {
	return mutationScope.run(observer, body);
}

/** Runs `body` outside any observer: putting a snapshot back is not a new mutation. */
export function unobserved<T>(body: () => Promise<T>): Promise<T> {
	return mutationScope.exit(body);
}

function observed<T>(fs: WorkspaceFs, mutation: FsMutation, apply: () => Promise<T>): Promise<T> {
	const observer = mutationScope.getStore();
	return observer ? observer.observe(fs, mutation, apply) : apply();
}

export interface TextFileRead {
	text: string;
	truncated: boolean;
	binary: boolean;
	bytesRead: number;
}

/** Decodes a bounded read, refusing to hand binary payloads to the model. */
export async function readTextFile(
	fs: WorkspaceFs,
	path: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<TextFileRead> {
	const { bytes, truncated } = await fs.readBytes(path, maxBytes, signal);
	if (looksBinary(bytes)) return { text: "", truncated, binary: true, bytesRead: bytes.length };
	try {
		return {
			text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated }),
			truncated,
			binary: false,
			bytesRead: bytes.length,
		};
	} catch {
		throw new ToolFailure(
			`${path} is not valid UTF-8 text. Refusing a lossy decode that could corrupt a later edit.`,
		);
	}
}

/**
 * Files above this size are not digested on stat. Nothing that large can be
 * rewritten in place anyway, and hashing it would read the whole file just to
 * answer a metadata question.
 */
export const HASH_SIZE_LIMIT = 64 * 1024 * 1024;

export class LocalFs implements WorkspaceFs {
	async stat(path: string, options: { hash?: boolean; signal?: AbortSignal } = {}): Promise<FileStat> {
		let symlink = false;
		try {
			const link = await lstat(path);
			symlink = link.isSymbolicLink();
			const info = symlink ? await statFile(path) : link;
			const kind: FileKind = info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";
			const result: FileStat = { kind, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode & 0o7777 };
			if (symlink) result.symlink = true;
			if (kind === "file" && options.hash !== false && info.size <= HASH_SIZE_LIMIT) {
				result.hash = await this.hash(path, options.signal);
			}
			return result;
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code === "ENOENT" ||
				(error as NodeJS.ErrnoException).code === "ENOTDIR"
			) {
				// A dangling symlink: the link is real even though its target is not.
				return { kind: "missing", size: 0, mtimeMs: 0, mode: undefined, ...(symlink ? { symlink } : {}) };
			}
			throw new ToolFailure(`Cannot stat ${path}: ${(error as Error).message}`);
		}
	}

	async hash(path: string, signal?: AbortSignal): Promise<string> {
		const hasher = new Bun.CryptoHasher("sha256");
		for await (const chunk of Bun.file(path).stream()) {
			if (signal?.aborted) throw new ToolFailure("Interrupted while hashing the file.");
			hasher.update(chunk);
		}
		return hasher.digest("hex");
	}

	async readBytes(
		path: string,
		maxBytes: number,
		signal?: AbortSignal,
		offset = 0,
	): Promise<ReadBytesResult> {
		checkReadRange(maxBytes, offset);
		signal?.throwIfAborted();
		const buffer = await Bun.file(path)
			.slice(offset, offset + maxBytes + 1)
			.arrayBuffer();
		signal?.throwIfAborted();
		const bytes = new Uint8Array(buffer);
		return { bytes: bytes.subarray(0, maxBytes), truncated: bytes.length > maxBytes };
	}

	async write(
		path: string,
		data: string | Uint8Array,
		signal: AbortSignal | undefined,
		expectedHash: string | null,
		mode?: number,
	): Promise<string> {
		requireExpectedHash(expectedHash);
		const payload = typeof data === "string" ? Buffer.from(data) : Uint8Array.from(data);
		await this.mkdirp(dirname(path), signal);
		const mutation: FsMutation = {
			kind: "write",
			path,
			bytes: payload.length,
			data: payload,
			expectedHash,
			mode,
		};
		return observed(this, mutation, async () => {
			const committed = await writeAtomic(path, payload, signal, expectedHash, {
				expectedMode: mutation.expectedModes?.[0],
				mode: mutation.mode,
			});
			mutation.committed = [committed];
			return committed.hash;
		});
	}

	async mkdirp(path: string, signal?: AbortSignal): Promise<void> {
		for (const missing of await missingParents(this, path, signal)) await this.mkdir(missing, signal);
	}

	mkdir(path: string, signal?: AbortSignal, mode?: number): Promise<void> {
		const mutation: FsMutation = { kind: "mkdir", path, mode };
		return observed(this, mutation, async () => {
			mutation.committed = [await mkdirAtomic(path, signal, mutation.mode)];
		});
	}

	rmdir(path: string, signal?: AbortSignal, expectedMode?: number): Promise<void> {
		const mutation: FsMutation = { kind: "rmdir", path, mode: expectedMode };
		return observed(this, mutation, async () => {
			await rmdirAtomic(path, signal, mutation.expectedModes?.[0] ?? expectedMode);
			mutation.committed = [{ kind: "missing" }];
		});
	}

	chmodDirectory(path: string, mode: number, signal?: AbortSignal, expectedMode?: number): Promise<void> {
		const mutation: FsMutation = { kind: "dirmode", path, mode, expectedModes: [expectedMode] };
		return observed(this, mutation, async () => {
			mutation.committed = [await chmodDirectoryGuarded(path, mode, signal, mutation.expectedModes?.[0])];
		});
	}

	async entries(path: string, signal?: AbortSignal): Promise<DirEntry[]> {
		signal?.throwIfAborted();
		const info = await lstat(path);
		if (!info.isDirectory()) throw new ToolFailure(`${path} is not a real directory.`);
		return (await readdir(path, { withFileTypes: true }))
			.map((entry) => ({
				path: join(path, entry.name),
				kind: entry.isDirectory() ? ("dir" as const) : ("file" as const),
			}))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	}

	remove(path: string, signal: AbortSignal | undefined, expectedHash: string): Promise<void> {
		requireExpectedHash(expectedHash, false);
		const mutation: FsMutation = { kind: "remove", path, expectedHash };
		return observed(this, mutation, async () => {
			await removeAtomic(path, signal, expectedHash, mutation.expectedModes?.[0]);
			mutation.committed = [{ kind: "missing" }];
		});
	}

	async move(
		from: string,
		to: string,
		signal: AbortSignal | undefined,
		expectedSourceHash: string,
		expectedDestinationHash: string | null,
	): Promise<void> {
		requireExpectedHash(expectedSourceHash, false);
		requireExpectedHash(expectedDestinationHash);
		await this.mkdirp(dirname(to), signal);
		const mutation: FsMutation = {
			kind: "move",
			path: from,
			to,
			expectedSourceHash,
			expectedDestinationHash,
		};
		return observed(this, mutation, async () => {
			const committed = await moveAtomic(
				from,
				to,
				signal,
				expectedSourceHash,
				expectedDestinationHash,
				mutation.expectedModes,
			);
			mutation.committed = from === to ? [committed, committed] : [{ kind: "missing" }, committed];
		});
	}

	async chmod(
		path: string,
		mode: number,
		signal: AbortSignal | undefined,
		expectedHash: string,
	): Promise<void> {
		requireExpectedHash(expectedHash, false);
		const info = await this.stat(path, { hash: false, signal });
		const mutation: FsMutation = { kind: "write", path, bytes: info.size, expectedHash, mode };
		await observed(this, mutation, async () => {
			mutation.committed = [
				await chmodGuarded(path, mode, signal, expectedHash, mutation.expectedModes?.[0]),
			];
		});
	}

	async list(path: string, depth: number, hidden: boolean): Promise<DirEntry[]> {
		const entries: DirEntry[] = [];
		const walk = async (directory: string, level: number): Promise<void> => {
			const found = await readdir(directory, { withFileTypes: true });
			for (const entry of found) {
				if (!hidden && entry.name.startsWith(".")) continue;
				const full = join(directory, entry.name);
				if (entry.isDirectory()) {
					entries.push({ path: full, kind: "dir" });
					if (level < depth) await walk(full, level + 1);
				} else {
					entries.push({ path: full, kind: "file" });
				}
			}
		};
		await walk(path, 1);
		return entries;
	}
}

function checkReadRange(maxBytes: number, offset: number): void {
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 0 ||
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(offset + maxBytes + 1)
	)
		throw new ToolFailure("Read byte offset and limit must be non-negative safe integers.");
}

function parseFields(output: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of output.split("\n")) {
		if (line.length === 0) continue;
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		fields[line.slice(0, tab)] = line.slice(tab + 1);
	}
	return fields;
}

export class RemoteFs implements WorkspaceFs {
	constructor(private readonly executor: RemoteExecutor) {}

	private async helperArgv(args: readonly string[], signal?: AbortSignal): Promise<string[]> {
		return ["/bin/sh", await this.executor.helperPath(signal), ...args];
	}

	private async run(args: readonly string[], signal: AbortSignal | undefined, stdin?: string | Uint8Array) {
		const mutation = ["write", "remove", "move", "chmod", "mkdir", "rmdir", "dirmode"].includes(args[0]!);
		let argv: string[];
		try {
			argv = await this.helperArgv(args, signal);
			signal?.throwIfAborted();
		} catch (error) {
			if (!mutation) throw error;
			throw new ToolFailure(
				`${this.executor.host}: filesystem helper did not start: ${error instanceof Error ? error.message : String(error)}. Nothing was published.`,
				{ publication: "unpublished" },
			);
		}
		// Absolute paths do not depend on cwd. Separately pass the workspace boundary
		// so a private cache can never land in an unfiltered project/build context.
		const result = await this.executor
			.exec(argv, {
				signal,
				stdin,
				timeoutMs: 120_000,
				cwd: "/",
				env: this.executor.defaultCwd ? { SALAM_WORKSPACE: this.executor.defaultCwd } : undefined,
			})
			.catch((error: unknown) => {
				if (!mutation) throw error;
				throw new ToolFailure(
					`${this.executor.host}: ${error instanceof Error ? error.message : String(error)}. Remote publication outcome is unknown because the transport did not return a terminal receipt. Inspect the destination and private recovery cache before retrying.`,
					{ publication: "unknown", host: this.executor.host },
				);
			});
		if (result.code !== 0 || result.aborted || result.timedOut) {
			const reason = result.stderr.trim() || result.spawnError || `helper exited with ${result.code}`;
			const recoveryPaths = remoteRecoveryPaths(result.stdout);
			const terminal = parseFields(result.stdout).publication;
			const publication =
				!result.aborted && !result.timedOut && (terminal === "unpublished" || terminal === "rolled-back")
					? terminal
					: "unknown";
			const outcome =
				mutation && publication === "unknown"
					? " Remote publication outcome is unknown: a fully uploaded operation may finish after cancellation, timeout, or transport loss. Inspect the destination and private recovery cache before retrying; incomplete payloads are never published."
					: "";
			throw new ToolFailure(
				`${this.executor.host}: ${reason}${outcome}${recoveryPaths.length ? ` Recovery paths on ${this.executor.host} (outside the working tree; never automatically pruned): ${recoveryPaths.map((path) => JSON.stringify(path)).join(", ")}.` : ""}`,
				{ recoveryPaths, host: this.executor.host, publication },
			);
		}
		return result;
	}

	async stat(path: string, options: { hash?: boolean; signal?: AbortSignal } = {}): Promise<FileStat> {
		const result = await this.run(
			["stat", path, options.hash === false ? "nohash" : "hash", String(HASH_SIZE_LIMIT)],
			options.signal,
		);
		const fields = parseFields(result.stdout);
		const kind = (fields.kind ?? "missing") as FileKind;
		const symlink = fields.symlink === "1";
		if (kind === "missing")
			return { kind, size: 0, mtimeMs: 0, mode: undefined, ...(symlink ? { symlink } : {}) };
		const stat: FileStat = {
			kind,
			size: Number(fields.size ?? 0),
			mtimeMs: Number(fields.mtime ?? 0) * 1000,
			mode: fields.mode ? Number.parseInt(fields.mode, 8) : undefined,
		};
		if (symlink) stat.symlink = true;
		if (fields.hash) stat.hash = fields.hash;
		return stat;
	}

	async hash(path: string, signal?: AbortSignal): Promise<string> {
		const result = await this.run(["hash", path], signal);
		const digest = result.stdout.trim();
		if (!/^[0-9a-f]{64}$/.test(digest))
			throw new ToolFailure(`Unexpected hash output for ${path}: ${digest}`);
		return digest;
	}

	async readBytes(
		path: string,
		maxBytes: number,
		signal?: AbortSignal,
		offset = 0,
	): Promise<ReadBytesResult> {
		checkReadRange(maxBytes, offset);
		signal?.throwIfAborted();
		const argv = await this.helperArgv(["read", path, String(maxBytes + 1), String(offset)], signal);
		const result = await this.executor.execBytes(argv, {
			signal,
			timeoutMs: 180_000,
			maxCaptureBytes: maxBytes + 1024,
			cwd: "/",
		});
		if (result.code !== 0) {
			const reason = result.stderr.trim() || `helper exited with ${result.code}`;
			throw new ToolFailure(`${this.executor.host}: ${reason}`);
		}
		signal?.throwIfAborted();
		return {
			bytes: result.stdout.subarray(0, maxBytes),
			truncated: result.stdout.length > maxBytes || result.truncated,
		};
	}

	async write(
		path: string,
		data: string | Uint8Array,
		signal: AbortSignal | undefined,
		expectedHash: string | null,
		mode?: number,
	): Promise<string> {
		requireExpectedHash(expectedHash);
		const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Uint8Array.from(data);
		await this.mkdirp(dirname(path), signal);
		const mutation: FsMutation = {
			kind: "write",
			path,
			bytes: payload.length,
			data: payload,
			expectedHash,
			mode,
		};
		return observed(this, mutation, async () => {
			const payloadHash = sha256Hex(payload);
			const result = await this.run(
				[
					"write",
					path,
					expectedHash ?? "missing",
					modeArgument(mutation.expectedModes?.[0]),
					modeArgument(mutation.mode),
					String(payload.length),
					payloadHash,
				],
				signal,
				payload,
			);
			const committed = confirmedFile(result.stdout, path);
			if (committed.hash !== payloadHash || committed.size !== payload.length)
				throw new ToolFailure(
					`Remote write of ${path} did not confirm the requested bytes. Inspect the destination before retrying.`,
					{ publication: "unknown", recoveryPaths: remoteRecoveryPaths(result.stdout) },
				);
			mutation.committed = [committed];
			return committed.hash;
		});
	}

	async mkdirp(path: string, signal?: AbortSignal): Promise<void> {
		for (const missing of await missingParents(this, path, signal)) await this.mkdir(missing, signal);
	}

	mkdir(path: string, signal?: AbortSignal, mode?: number): Promise<void> {
		const mutation: FsMutation = { kind: "mkdir", path, mode };
		return observed(this, mutation, async () => {
			const result = await this.run(["mkdir", path, modeArgument(mutation.mode)], signal);
			const receipt = parseFields(result.stdout);
			if (receipt.kind !== "dir" || !/^[0-7]{1,4}$/.test(receipt.mode ?? ""))
				throw new ToolFailure(`Remote mkdir of ${path} returned no directory receipt.`, {
					publication: "unknown",
				});
			mutation.committed = [{ kind: "dir", mode: Number.parseInt(receipt.mode!, 8) }];
		});
	}

	rmdir(path: string, signal?: AbortSignal, expectedMode?: number): Promise<void> {
		const mutation: FsMutation = { kind: "rmdir", path, mode: expectedMode };
		return observed(this, mutation, async () => {
			await this.run(["rmdir", path, modeArgument(mutation.expectedModes?.[0] ?? expectedMode)], signal);
			mutation.committed = [{ kind: "missing" }];
		});
	}

	chmodDirectory(path: string, mode: number, signal?: AbortSignal, expectedMode?: number): Promise<void> {
		const mutation: FsMutation = { kind: "dirmode", path, mode, expectedModes: [expectedMode] };
		return observed(this, mutation, async () => {
			await this.run(
				["dirmode", path, modeArgument(mode), modeArgument(mutation.expectedModes?.[0])],
				signal,
			);
			mutation.committed = [{ kind: "dir", mode }];
		});
	}

	async entries(path: string, signal?: AbortSignal): Promise<DirEntry[]> {
		const result = await this.run(["entries", path], signal);
		return JSON.parse(result.stdout) as DirEntry[];
	}

	remove(path: string, signal: AbortSignal | undefined, expectedHash: string): Promise<void> {
		requireExpectedHash(expectedHash, false);
		const mutation: FsMutation = { kind: "remove", path, expectedHash };
		return observed(this, mutation, async () => {
			await this.run(["remove", path, expectedHash, modeArgument(mutation.expectedModes?.[0])], signal);
			mutation.committed = [{ kind: "missing" }];
		});
	}

	async move(
		from: string,
		to: string,
		signal: AbortSignal | undefined,
		expectedSourceHash: string,
		expectedDestinationHash: string | null,
	): Promise<void> {
		requireExpectedHash(expectedSourceHash, false);
		requireExpectedHash(expectedDestinationHash);
		await this.mkdirp(dirname(to), signal);
		const mutation: FsMutation = {
			kind: "move",
			path: from,
			to,
			expectedSourceHash,
			expectedDestinationHash,
		};
		return observed(this, mutation, async () => {
			const result = await this.run(
				[
					"move",
					from,
					to,
					expectedSourceHash,
					expectedDestinationHash ?? "missing",
					modeArgument(mutation.expectedModes?.[0]),
					modeArgument(mutation.expectedModes?.[1]),
				],
				signal,
			);
			const committed = confirmedFile(result.stdout, to);
			if (committed.hash !== expectedSourceHash)
				throw new ToolFailure(`Remote move to ${to} did not confirm the source bytes.`);
			mutation.committed = from === to ? [committed, committed] : [{ kind: "missing" }, committed];
		});
	}

	async chmod(
		path: string,
		mode: number,
		signal: AbortSignal | undefined,
		expectedHash: string,
	): Promise<void> {
		requireExpectedHash(expectedHash, false);
		const info = await this.stat(path, { hash: false, signal });
		const mutation: FsMutation = { kind: "write", path, bytes: info.size, expectedHash, mode };
		await observed(this, mutation, async () => {
			const result = await this.run(
				["chmod", path, modeArgument(mode), expectedHash, modeArgument(mutation.expectedModes?.[0])],
				signal,
			);
			const committed = confirmedFile(result.stdout, path);
			if (committed.hash !== expectedHash || committed.mode !== mode)
				throw new ToolFailure(`Remote chmod of ${path} did not confirm the requested state.`);
			mutation.committed = [committed];
		});
	}

	async list(path: string, depth: number, hidden: boolean, signal?: AbortSignal): Promise<DirEntry[]> {
		const result = await this.run(["list", path, String(depth), hidden ? "1" : "0"], signal);
		const entries: DirEntry[] = [];
		for (const line of result.stdout.split("\n")) {
			if (line.length < 3) continue;
			const kind = line[0] === "d" ? "dir" : "file";
			entries.push({ path: line.slice(2), kind });
		}
		return entries;
	}
}

function remoteRecoveryPaths(output: string): string[] {
	const paths = new Set<string>();
	for (const line of output.split("\n")) {
		const tab = line.indexOf("\t");
		const field = line.slice(0, tab);
		if (field !== "recovery" && field !== "released") continue;
		try {
			const path: unknown = JSON.parse(line.slice(tab + 1));
			if (typeof path === "string") {
				if (field === "recovery") paths.add(path);
				else paths.delete(path);
			}
		} catch {
			// A channel may close partway through the last metadata line.
		}
	}
	return [...paths];
}

function modeArgument(mode: number | undefined): string {
	return mode === undefined ? "" : mode.toString(8);
}

function confirmedFile(output: string, path: string): Extract<CommittedFile, { kind: "file" }> {
	const fields = parseFields(output);
	const hash = fields.hash ?? "";
	const size = Number(fields.size);
	const mode = Number.parseInt(fields.mode ?? "", 8);
	if (
		!/^[0-9a-f]{64}$/.test(hash) ||
		!Number.isSafeInteger(size) ||
		size < 0 ||
		!Number.isInteger(mode) ||
		mode < 0 ||
		mode > 0o7777
	)
		throw new ToolFailure(
			`Remote mutation of ${path} did not confirm its exact committed state. Inspect the destination before retrying.`,
			{ publication: "unknown", recoveryPaths: remoteRecoveryPaths(output) },
		);
	return { kind: "file", hash, size, mode };
}

/** Missing ancestors up to the nearest existing directory, shallowest first. */
export async function missingParents(fs: WorkspaceFs, path: string, signal?: AbortSignal): Promise<string[]> {
	const missing: string[] = [];
	for (let current = path; ; current = dirname(current)) {
		const info = await fs.stat(current, { hash: false, signal });
		if (info.symlink || (info.kind !== "missing" && info.kind !== "dir"))
			throw new ToolFailure(`${current} is not a real directory; refusing unsafe parent traversal.`);
		if (info.kind === "dir") break;
		if (info.kind === "missing") missing.push(current);
		if (dirname(current) === current) break;
	}
	return missing.reverse();
}
