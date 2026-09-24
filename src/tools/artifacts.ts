import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { clipText } from "./text.ts";
import { formatBytes, randomToken, ToolFailure } from "./util.ts";

/**
 * Artifacts always live on the machine running the harness, never on an SSH
 * target, so they are addressed by scheme rather than by filesystem path: a
 * remote session must be able to recover a spilled result without the path
 * accidentally resolving against the remote root.
 */
export const ARTIFACT_SCHEME = "artifact://";

export interface StoredArtifact {
	/** `artifact://<session>/<file>` — what tools report and `read` accepts. */
	uri: string;
	/** Absolute local path, for callers that already know they are local. */
	path: string;
	bytes: number;
}

export interface BoundedText {
	/** What the model sees: always within budget. */
	text: string;
	clipped: boolean;
	totalLines: number;
	/** `artifact://` URI of the complete copy; present only when clipped. */
	artifact?: string;
	artifactPath?: string;
}

export interface BoundOptions {
	sessionId: string;
	/** Short kebab label that ends up in the artifact filename. */
	label: string;
	maxLines?: number;
	maxChars?: number;
}

const DEFAULT_MAX_LINES = 400;
const DEFAULT_MAX_CHARS = 48_000;
const SAFE_SEGMENT = /[^A-Za-z0-9_.-]/g;

/**
 * Durable spillover for oversized output. Anything the model is not shown is
 * still written to `<home>/artifacts`, so every truncation is recoverable and
 * nothing is ever silently dropped.
 *
 * Shared deliberately: the runtime stores its own large payloads (agent
 * transcripts, history dumps) in the same namespace so `read` recovers them all
 * through one mechanism.
 */
export class ArtifactStore {
	readonly root: string;
	private readonly ensured = new Set<string>();

	constructor(home: string) {
		this.root = join(home, "artifacts");
	}

	async store(sessionId: string, label: string, body: string | Uint8Array): Promise<StoredArtifact> {
		const session = sessionId.replaceAll(SAFE_SEGMENT, "_") || "session";
		const safeLabel = label.replaceAll(SAFE_SEGMENT, "-") || "output";
		const directory = join(this.root, session);
		if (!this.ensured.has(directory)) {
			await mkdir(directory, { recursive: true });
			this.ensured.add(directory);
		}
		const name = `${Date.now()}-${safeLabel}-${randomToken(6)}.txt`;
		const path = join(directory, name);
		const bytes = await Bun.write(path, body);
		return { uri: `${ARTIFACT_SCHEME}${session}/${name}`, path, bytes };
	}

	/**
	 * Maps an `artifact://` URI back to a local path, refusing anything that
	 * would escape the artifact root. Returns undefined for non-artifact input so
	 * callers can fall through to ordinary path handling.
	 */
	resolve(uri: string): string | undefined {
		if (!uri.startsWith(ARTIFACT_SCHEME)) return undefined;
		const segments = uri.slice(ARTIFACT_SCHEME.length).split("/").filter(Boolean);
		if (segments.length === 0) throw new ToolFailure(`Malformed artifact reference: ${uri}`);
		for (const segment of segments) {
			if (segment === "." || segment === ".." || segment.includes("\\")) {
				throw new ToolFailure(`Malformed artifact reference: ${uri}`);
			}
		}
		const path = join(this.root, ...segments);
		if (path !== this.root && !path.startsWith(this.root + sep)) {
			throw new ToolFailure(`Artifact reference escapes the artifact store: ${uri}`);
		}
		return path;
	}

	async bound(text: string, options: BoundOptions): Promise<BoundedText> {
		const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
		const clip = clipText(text, maxLines, maxChars);
		if (!clip.clipped) return { text: clip.text, clipped: false, totalLines: clip.totalLines };
		const artifact = await this.store(options.sessionId, options.label, text);
		const notice = `\n[output truncated: showing ${clip.shownLines} of ${clip.totalLines} lines, ${formatBytes(Buffer.byteLength(text))} total — recover the full output with read ${artifact.uri}]`;
		return {
			text: clip.text + notice,
			clipped: true,
			totalLines: clip.totalLines,
			artifact: artifact.uri,
			artifactPath: artifact.path,
		};
	}
}
