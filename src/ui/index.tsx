import { CliRenderEvents, addDefaultParsers, createCliRenderer } from "@opentui/core";
import type { CliRenderer, CliRendererErrorEvent, KeyEvent } from "@opentui/core";
import { render, useKeyboard } from "@opentui/solid";
import { ErrorBoundary, createSignal } from "solid-js";
import type { AppController, AppSnapshot } from "../contracts.ts";
import { App } from "./App.tsx";
import { createSelectionCopier } from "./clipboard.ts";
import { resolveSyntaxAssets } from "./syntax.ts";
import { createTranscript } from "./transcript.tsx";

/** Coalescing window for runtime events; one repaint per window while streaming. */
const FRAME_MS = 33;

function describe(error: unknown): string {
	if (error instanceof Error) return error.stack ?? error.message;
	return String(error);
}

function FatalNotice(props: { error: unknown; exit: () => void }) {
	// The app's own key handler died with the tree this fallback replaced.
	useKeyboard((key: KeyEvent) => {
		if ((key.ctrl && (key.name === "c" || key.name === "d")) || key.name === "escape") props.exit();
	});
	return (
		<box flexDirection="column" width="100%">
			<text fg="#cc6b60" wrapMode="word" width="100%" content={`salam ui error: ${describe(props.error)}`} />
			<text fg="#8a8a8a" wrapMode="word" width="100%" content="press ctrl+c to exit" />
		</box>
	);
}

/**
 * Mounts the terminal UI.
 *
 * The alternate screen owns the entire conversation viewport. Streamed and
 * settled output share persistent reactive rows above a pinned composer.
 * Resolves once the user exits or the runtime signals `exit`, after the
 * terminal has been restored and the runtime has closed, so the caller can
 * print to the normal screen.
 */
export async function startUI(
	controller: AppController,
	onSignal?: (signal: NodeJS.Signals) => void,
): Promise<void> {
	// Grammars must be registered before the first code block starts the parser worker.
	const syntax = resolveSyntaxAssets();
	addDefaultParsers(syntax.parsers);
	let renderer: CliRenderer;
	try {
		renderer = await createCliRenderer({
			screenMode: "alternate-screen",
			exitOnCtrlC: false,
			// Mouse reporting drives wheel/trackpad scrolling and text selection.
			// Focus stays owned by the app (composer or open picker): with
			// autoFocus a click in the transcript would focus the scrollbox and
			// silently detach typing from the composer.
			useMouse: true,
			autoFocus: false,
			consoleMode: "disabled",
			openConsoleOnError: false,
			targetFps: 30,
		});
	} catch (error) {
		process.stderr.write(`salam: could not start the terminal UI: ${describe(error)}\n`);
		throw error;
	}

	const transcript = createTranscript();
	if (syntax.missing.length > 0)
		transcript.notice(`syntax highlighting unavailable for ${syntax.missing.join("; ")}`, true);
	const copier = createSelectionCopier(renderer);
	const [snapshot, setSnapshot] = createSignal<AppSnapshot>(controller.snapshot(), { equals: false });

	let pending: Timer | undefined;
	let unsubscribe: (() => void) | undefined;
	let finished = false;
	const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>();
	// DESTROY fires inside the renderer's final teardown, which restores the
	// terminal synchronously right after it; anything awaiting this promise runs
	// on the restored screen (a destroy requested mid-frame finishes later).
	const { promise: restored, resolve: resolveRestored } = Promise.withResolvers<void>();
	renderer.once(CliRenderEvents.DESTROY, resolveRestored);
	const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
		(signal) => [signal, () => onSignal?.(signal)] as const,
	);
	for (const [signal, handler] of signalHandlers) process.on(signal, handler);

	const publish = () => {
		pending = undefined;
		if (finished) return;
		setSnapshot(controller.snapshot());
	};

	const exit = () => {
		if (finished) return;
		finished = true;
		// Once the renderer restores cooked mode, another interrupt must retain
		// its default action even while runtime shutdown is still pending.
		for (const [signal, handler] of signalHandlers) process.off(signal, handler);
		clearTimeout(pending);
		unsubscribe?.();
		try {
			controller.cancel();
		} catch {
			// cancelling an idle runtime must never block teardown
		}
		if (!renderer.isDestroyed) renderer.destroy();
		void Promise.allSettled([
			restored,
			controller
				.close()
				.catch((error: unknown) => process.stderr.write(`salam: runtime close failed: ${describe(error)}\n`)),
			copier
				.dispose()
				.catch((error: unknown) =>
					process.stderr.write(`salam: clipboard close failed: ${describe(error)}\n`),
				),
		]).finally(resolveExit);
	};

	unsubscribe = controller.subscribe((event) => {
		if (event.type === "exit") {
			exit();
			return;
		}
		if (pending !== undefined) return;
		pending = setTimeout(publish, FRAME_MS);
	});

	renderer.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) => {
		transcript.notice(`render error: ${event.error.message}`, true);
	});
	renderer.once(CliRenderEvents.DESTROY, exit);

	const home = process.env.HOME ?? "";

	try {
		await render(
			() => (
				<ErrorBoundary fallback={(error: unknown) => <FatalNotice error={error} exit={exit} />}>
					<App
						controller={controller}
						transcript={transcript}
						snapshot={snapshot}
						home={home}
						exit={exit}
						copy={copier.copy}
					/>
				</ErrorBoundary>
			),
			renderer,
		);
	} catch (error) {
		if (!renderer.isDestroyed) renderer.destroy();
		unsubscribe?.();
		await copier.dispose().catch(() => {});
		process.stderr.write(`salam: could not mount the terminal UI: ${describe(error)}\n`);
		throw error;
	}

	await exited;
}
