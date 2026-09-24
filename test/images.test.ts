import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	attachmentFromPath,
	imagePathFrom,
	imageToken,
	referencedImages,
	sniffImage,
	toAttachment,
} from "../src/ui/images.ts";

/** A valid 1x1 PNG. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

test("image types are sniffed from magic bytes, not names", () => {
	expect(sniffImage(PNG)).toBe("image/png");
	expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
	expect(sniffImage(Buffer.from("GIF89a"))).toBe("image/gif");
	expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
	expect(sniffImage(Buffer.from("II*\0rest"))).toBe("image/tiff");
	expect(sniffImage(Buffer.from("hello world"))).toBeUndefined();
});

test("pasted paths are recognised in the shapes terminals paste them", () => {
	expect(imagePathFrom("/Users/me/Desktop/shot.png")).toBe("/Users/me/Desktop/shot.png");
	expect(imagePathFrom("/Users/me/Screen\\ Shot\\ 1.PNG ")).toBe("/Users/me/Screen Shot 1.PNG");
	expect(imagePathFrom("'/tmp/a b.jpg'")).toBe("/tmp/a b.jpg");
	expect(imagePathFrom("file:///tmp/a%20b.webp")).toBe("/tmp/a b.webp");
	expect(imagePathFrom("/tmp/notes.txt")).toBeUndefined();
	expect(imagePathFrom("relative/shot.png")).toBeUndefined();
	expect(imagePathFrom("/tmp/a.png\n/tmp/b.png")).toBeUndefined();
	expect(imagePathFrom("look at /tmp/a.png")).toBeUndefined();
});

test("only images whose tokens survive in the text are sent, in token order", () => {
	const one = { data: "1", mimeType: "image/png" };
	const two = { data: "2", mimeType: "image/png" };
	const three = { data: "3", mimeType: "image/png" };
	const images = new Map([
		[1, one],
		[2, two],
		[3, three],
	]);
	expect(referencedImages(`${imageToken(3)} vs ${imageToken(1)} again ${imageToken(3)}`, images)).toEqual([
		three,
		one,
	]);
	expect(referencedImages("no tokens", images)).toEqual([]);
});

test("small images attach as they are; non-images are refused", async () => {
	expect(await toAttachment(PNG)).toEqual({ data: PNG.toString("base64"), mimeType: "image/png" });
	await expect(toAttachment(Buffer.from("plain text"))).rejects.toThrow(/not a PNG/);
	const directory = await mkdtemp(join(tmpdir(), "salam-images-"));
	try {
		await writeFile(join(directory, "shot.png"), PNG);
		expect((await attachmentFromPath(join(directory, "shot.png")))?.mimeType).toBe("image/png");
		expect(await attachmentFromPath(join(directory, "missing.png"))).toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "darwin")(
	"TIFF and oversized screenshots are re-encoded under the limit",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "salam-images-"));
		try {
			const source = join(directory, "dot.png");
			await writeFile(source, PNG);
			const tiff = join(directory, "dot.tiff");
			execFileSync("/usr/bin/sips", ["-s", "format", "tiff", source, "--out", tiff], { stdio: "ignore" });
			expect((await toAttachment(await readFile(tiff))).mimeType).toBe("image/png");

			// Incompressible noise: a 1600x1600 PNG of it is far above the ~3.7 MB inline limit.
			const size = 1600;
			const rgba = new Uint8Array(size * size * 4);
			for (let offset = 0; offset < rgba.length; offset += 65_536)
				crypto.getRandomValues(rgba.subarray(offset, offset + 65_536));
			const raw = join(directory, "noise.png");
			await writeFile(raw, encodePng(size, rgba));
			const big = await readFile(raw);
			expect(big.length).toBeGreaterThan(4 * 1024 * 1024);
			const scaled = await toAttachment(big);
			expect(scaled.mimeType).toBe("image/jpeg");
			expect((scaled.data.length * 3) / 4).toBeLessThan(3.8 * 1024 * 1024);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

/** Minimal stored (uncompressed) PNG encoder, enough to make a large valid test image. */
function encodePng(size: number, rgba: Uint8Array): Buffer {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: Buffer) => {
		let c = 0xffffffff;
		for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(8 + data.length + 4);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc(body), 8 + data.length);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 6, 0, 0, 0], 8);
	const rows = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++)
		rows.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
	const data = Bun.deflateSync(rows, { level: 0 });
	const zlib = Buffer.concat([Buffer.from([0x78, 0x01]), Buffer.from(data), adler(rows)]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", zlib),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function adler(bytes: Buffer): Buffer {
	let a = 1;
	let b = 0;
	for (const byte of bytes) {
		a = (a + byte) % 65_521;
		b = (b + a) % 65_521;
	}
	const out = Buffer.alloc(4);
	out.writeUInt32BE(((b << 16) | a) >>> 0, 0);
	return out;
}
