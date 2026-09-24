import type { Arguments, Json } from "../contracts.ts";

/** Error whose message is safe and useful to hand straight back to the model. */
export class ToolFailure extends Error {
	readonly details: Json | undefined;
	constructor(message: string, details?: Json) {
		super(message);
		this.name = "ToolFailure";
		this.details = details;
	}
}

export function errorText(error: unknown): string {
	if (error instanceof ToolFailure) return error.message;
	if (error instanceof Error) return error.message || error.name;
	return String(error);
}

export function argString(args: Arguments, key: string, fallback?: string): string {
	const value = args[key];
	if (value === undefined || value === null) {
		if (fallback !== undefined) return fallback;
		throw new ToolFailure(`Missing required argument \`${key}\`.`);
	}
	if (typeof value !== "string")
		throw new ToolFailure(`Argument \`${key}\` must be a string, received ${typeof value}.`);
	return value;
}

export function argOptionalString(args: Arguments, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string")
		throw new ToolFailure(`Argument \`${key}\` must be a string, received ${typeof value}.`);
	return value;
}

export function argInt(args: Arguments, key: string, fallback: number, min: number, max: number): number {
	const value = args[key];
	if (value === undefined || value === null) return fallback;
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value)
				: Number.NaN;
	if (!Number.isFinite(numeric)) throw new ToolFailure(`Argument \`${key}\` must be a number.`);
	const rounded = Math.trunc(numeric);
	if (rounded < min || rounded > max) {
		throw new ToolFailure(`Argument \`${key}\` must be between ${min} and ${max}, received ${rounded}.`);
	}
	return rounded;
}

export function argBool(args: Arguments, key: string, fallback: boolean): boolean {
	const value = args[key];
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new ToolFailure(`Argument \`${key}\` must be a boolean.`);
}

/**
 * POSIX single-quote quoting: the only string form every shell reproduces
 * byte-for-byte. Every remote argv element passes through here before it is
 * concatenated into the single command string ssh hands to the login shell.
 */
export function shellQuote(value: string): string {
	if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function sha256Hex(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data as Uint8Array).digest("hex");
}

/** Short collision-resistant id for temp files, control sockets and artifacts. */
export function randomToken(length = 10): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const byte of bytes) out += alphabet[byte % alphabet.length];
	return out;
}

export function formatBytes(count: number): string {
	if (count < 1024) return `${count} B`;
	if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
	return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

/** Batches rapid streaming chunks so the UI is never flooded by a chatty process. */
export class EmitThrottle {
	private buffer = "";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(
		private readonly sink: (text: string) => void,
		private readonly intervalMs = 120,
		private readonly maxBuffered = 4096,
	) {}

	push(chunk: string): void {
		if (this.closed || chunk.length === 0) return;
		this.buffer += chunk;
		if (this.buffer.length >= this.maxBuffered) {
			this.flush();
			return;
		}
		this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
	}

	flush(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.buffer.length === 0) return;
		const payload = this.buffer;
		this.buffer = "";
		try {
			this.sink(payload);
		} catch {
			// A failing UI sink must never break a tool call.
		}
	}

	close(): void {
		this.flush();
		this.closed = true;
	}
}
