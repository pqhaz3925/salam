import type { StyledText, TextRenderable } from "@opentui/core";
import { createRenderEffect } from "solid-js";

/**
 * A single styled row.
 *
 * `@opentui/solid`'s reconciler stringifies the `text` and `content` props
 * before handing them to the renderable, so `<text content={styled} />` reaches
 * the terminal as `[object Object]`. Chunk arrays only survive when they are
 * assigned to `TextRenderable.content`, which also latches the renderable onto
 * its manual styled-text path instead of the child-node path.
 *
 * The assignment is a render effect created from the ref, so it is applied
 * synchronously while the element is being built. Scrollback blocks are
 * rendered and measured inside a single `writeSolidToScrollback` call that is
 * itself nested in an outer update, so a deferred (user) effect would land
 * after the snapshot had already been captured.
 */
export function StyledLine(props: {
	content: StyledText;
	wrapMode: "none" | "char" | "word";
	width?: number | "auto" | `${number}%`;
}) {
	return (
		<text
			ref={(node: TextRenderable) => {
				createRenderEffect(() => {
					node.content = props.content;
				});
			}}
			wrapMode={props.wrapMode}
			width={props.width}
		/>
	);
}
