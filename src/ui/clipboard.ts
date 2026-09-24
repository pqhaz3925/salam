import { createClipboard, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core";
import type { CliRenderer, ClipboardService, ClipboardWriteResult } from "@opentui/core";
import { truncate } from "./text.ts";

/**
 * Copies text selected inside the UI to the system clipboard.
 *
 * With mouse reporting on, a drag is delivered to salam instead of starting a
 * native terminal selection, so the terminal's own Cmd+C has nothing to copy
 * (macOS Terminal.app also consumes Cmd+C itself). Locally the text goes to
 * the OS pasteboard through OpenTUI's native host clipboard; over SSH, or
 * when no host clipboard is available, it is sent to the terminal as OSC 52.
 */
export interface SelectionCopier {
	/** Resolves to a short, truthful status line for the activity row. */
	copy(text: string): Promise<string>;
	dispose(): Promise<void>;
}

function amount(text: string): string {
	const lines = text.split("\n").length;
	return lines > 1 ? `${lines} lines` : `${text.length} char${text.length === 1 ? "" : "s"}`;
}

/** What actually happened to a clipboard write, never claiming more than the backends reported. */
export function describeCopy(text: string, result: ClipboardWriteResult): string {
	if (result.host.status === "written") return `copied ${amount(text)}`;
	const { terminal } = result;
	if (terminal.status === "attempted")
		return terminal.capability === "supported"
			? `copied ${amount(text)} via terminal`
			: `sent ${amount(text)} to terminal clipboard (OSC 52, unconfirmed)`;
	const host =
		result.host.status === "failed"
			? truncate(result.host.error.message, 48)
			: result.host.status === "not-attempted"
				? "remote session"
				: result.host.status;
	const osc =
		terminal.status === "not-attempted"
			? terminal.capability === "unsupported"
				? "OSC 52 unsupported"
				: "OSC 52 not tried"
			: "OSC 52 write failed";
	return `copy failed: ${host}; ${osc}`;
}

export function createSelectionCopier(renderer: CliRenderer): SelectionCopier {
	const terminal = createRendererClipboardAdapter(renderer);
	let service: ClipboardService | undefined;
	let hostError: string | undefined;
	try {
		service = createClipboard({ host: createHostClipboard(), terminal });
	} catch (error) {
		hostError = error instanceof Error ? error.message : String(error);
	}
	return {
		async copy(text) {
			if (text.length === 0) return "nothing selected";
			try {
				if (service)
					return describeCopy(text, await service.writeText(text, { destination: "best-available" }));
				return describeCopy(text, {
					host: { status: "failed", error: new Error(hostError ?? "host clipboard unavailable") },
					terminal: terminal.writeText(text, "clipboard"),
				});
			} catch (error) {
				return `copy failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
		async dispose() {
			await service?.dispose();
		},
	};
}
