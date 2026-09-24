import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageAttachment } from "../contracts.ts";

/**
 * Images pasted into the composer. Providers cap an inline image at 5 MB of
 * base64 (Anthropic) and scale anything past ~2000px down anyway, so a bigger
 * screenshot is re-encoded before it is attached rather than refused.
 */
const MAX_INLINE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 1024;
/** Largest source file accepted from a pasted path before any conversion. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const LONG_EDGE = 2000;

const MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** Types every provider accepts inline. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The image type from its magic bytes; the only trusted signal for pasted data. */
export function sniffImage(bytes: Uint8Array): string | undefined {
	const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
	if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6 && ascii(0, 4) === "GIF8") return "image/gif";
	if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	// macOS screenshots often reach the pasteboard as TIFF only.
	if (bytes.length >= 4 && (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*")) return "image/tiff";
	return undefined;
}

function run(file: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: 20_000 }, (error) => (error ? reject(error) : resolve()));
	});
}

function megabytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Bytes as an attachment: sniffed, and on macOS re-encoded with `sips` when
 * they are TIFF or exceed the inline limit (PNG first, then JPEG with the
 * long edge at 2000, 1400 and 1000px). Elsewhere such an image is refused
 * with a reason instead of silently dropped.
 */
export async function toAttachment(bytes: Uint8Array): Promise<ImageAttachment> {
	const mimeType = sniffImage(bytes);
	if (!mimeType) throw new Error("That is not a PNG, JPEG, GIF, WebP or TIFF image.");
	if (INLINE_TYPES.has(mimeType) && bytes.length <= MAX_INLINE_BYTES)
		return { data: Buffer.from(bytes).toString("base64"), mimeType };
	if (process.platform !== "darwin")
		throw new Error(
			INLINE_TYPES.has(mimeType)
				? `The image is ${megabytes(bytes.length)}; the limit is ${megabytes(MAX_INLINE_BYTES)}. Save a smaller copy and paste its path.`
				: `${mimeType} cannot be sent inline; save it as PNG or JPEG and paste its path.`,
		);
	const directory = await mkdtemp(join(tmpdir(), "salam-paste-"));
	try {
		const source = join(
			directory,
			`source.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length)}`,
		);
		await writeFile(source, bytes);
		const attempts: [format: "png" | "jpeg", edge: number | undefined][] = [
			["png", undefined],
			["jpeg", LONG_EDGE],
			["jpeg", 1400],
			["jpeg", 1000],
		];
		for (const [format, edge] of attempts) {
			const target = join(
				directory,
				`converted-${format}-${edge ?? "full"}.${format === "png" ? "png" : "jpg"}`,
			);
			await run("/usr/bin/sips", [
				...(edge ? ["-Z", String(edge)] : []),
				"-s",
				"format",
				format,
				source,
				"--out",
				target,
			]);
			const converted = await readFile(target);
			if (converted.length <= MAX_INLINE_BYTES)
				return {
					data: converted.toString("base64"),
					mimeType: format === "png" ? "image/png" : "image/jpeg",
				};
		}
		throw new Error("The image is still too large after scaling it down to 1000px.");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/**
 * A pasted string that names one image file: what terminals paste for a file
 * dragged in from Finder or copied there (quoted, backslash-escaped or a
 * file:// URL). Undefined for anything else, so ordinary text pastes normally.
 */
export function imagePathFrom(text: string): string | undefined {
	let value = text.trim();
	if (!value || value.includes("\n")) return undefined;
	if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
		value = value.slice(1, -1);
	else value = value.replace(/\\(.)/g, "$1");
	if (value.startsWith("file://")) {
		try {
			value = fileURLToPath(value);
		} catch {
			return undefined;
		}
	}
	if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
	if (!value.startsWith("/")) return undefined;
	return MIME_BY_EXTENSION[extname(value).toLowerCase()] ? value : undefined;
}

/** The attachment for a pasted image path, or undefined when it is not a readable image file. */
export async function attachmentFromPath(path: string): Promise<ImageAttachment | undefined> {
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return undefined;
	} catch {
		return undefined;
	}
	return toAttachment(await readFile(path));
}

/** `[Image #n]`, the composer's placeholder for attachment n. */
export function imageToken(index: number): string {
	return `[Image #${index}]`;
}

/**
 * The attachments a message still references, in the order their tokens
 * appear; a token the user deleted drops its image.
 */
export function referencedImages(
	text: string,
	images: ReadonlyMap<number, ImageAttachment>,
): ImageAttachment[] {
	const found: ImageAttachment[] = [];
	const seen = new Set<number>();
	for (const match of text.matchAll(/\[Image #(\d+)\]/g)) {
		const index = Number(match[1]);
		const image = images.get(index);
		if (image && !seen.has(index)) {
			seen.add(index);
			found.push(image);
		}
	}
	return found;
}
