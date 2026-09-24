import { dlopen, read } from "bun:ffi";
import { Buffer } from "node:buffer";
import { getSystemErrorName } from "node:util";
import { ToolFailure } from "./util.ts";

type Rename = (from: string, to: string, exchange: boolean) => void;
let nativeRename: Rename | undefined;

/** No ordinary-rename fallback: unsupported kernels/filesystems must leave both names intact. */
function loadRename(): Rename {
	if (process.platform === "darwin") {
		const library = dlopen("/usr/lib/libSystem.B.dylib", {
			renamex_np: { args: ["cstring", "cstring", "u32"], returns: "i32" },
			__error: { args: [], returns: "ptr" },
		});
		return (from, to, exchange) => {
			const result = library.symbols.renamex_np(
				Buffer.from(`${from}\0`),
				Buffer.from(`${to}\0`),
				exchange ? 2 : 4,
			);
			if (result !== 0) failRename(read.i32(library.symbols.__error()!), from, to);
		};
	}
	if (process.platform === "linux") {
		const muslArch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
		const failures: string[] = [];
		for (const name of ["libc.so.6", `/lib/ld-musl-${muslArch}.so.1`]) {
			try {
				const library = dlopen(name, {
					renameat2: { args: ["i32", "cstring", "i32", "cstring", "u32"], returns: "i32" },
					__errno_location: { args: [], returns: "ptr" },
				});
				return (from, to, exchange) => {
					const result = library.symbols.renameat2(
						-100,
						Buffer.from(`${from}\0`),
						-100,
						Buffer.from(`${to}\0`),
						exchange ? 2 : 1,
					);
					if (result !== 0) failRename(read.i32(library.symbols.__errno_location()!), from, to);
				};
			} catch (error) {
				failures.push(`${name}: ${(error as Error).message}`);
			}
		}
		throw new ToolFailure(
			`Neither the glibc nor musl atomic rename interface is available: ${failures.join("; ")}`,
		);
	}
	throw new ToolFailure(
		`Safe filesystem mutations require Darwin renamex_np or Linux renameat2; ${process.platform} is unsupported.`,
	);
}

function failRename(errno: number, from: string, to: string): never {
	const code = getSystemErrorName(-errno);
	const error = new Error(`Atomic rename ${from} -> ${to}: ${code}`) as NodeJS.ErrnoException;
	error.code = code;
	throw error;
}

function ensureSupported(): void {
	try {
		nativeRename ??= loadRename();
	} catch (error) {
		throw new ToolFailure(
			`Safe atomic filesystem operations are unavailable: ${(error as Error).message}. Nothing was replaced.`,
		);
	}
}

function rename(from: string, to: string, exchange: boolean): void {
	if (from.includes("\0") || to.includes("\0")) throw new ToolFailure("File paths cannot contain NUL bytes.");
	ensureSupported();
	nativeRename!(from, to, exchange);
}

/** Synchronous syscalls: callers can validate the displaced inode, not a stale pathname check. */
export const atomicRename = {
	ensureSupported,
	exchange(from: string, to: string): void {
		rename(from, to, true);
	},
	exclusive(from: string, to: string): void {
		rename(from, to, false);
	},
};
