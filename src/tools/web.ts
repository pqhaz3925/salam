import type { Usage } from "@oh-my-pi/pi-ai";
import type { HarnessTool, Json, ModelChoice, ProviderGateway, ToolContext } from "../contracts.ts";
import { type NativeWebMessage, type NativeWebSearchMessage, publicWebUrl } from "../providers/web.ts";
import { argOptionalString, argString, ToolFailure } from "./util.ts";
import { defineTool } from "./workspace.ts";

export function createWebTool(
	gateway: ProviderGateway,
	selectionFor: (context: ToolContext) => ModelChoice,
	recordUsage: (context: ToolContext, selection: ModelChoice, usage: Usage) => void,
): HarnessTool {
	return defineTool({
		name: "web_fetch",
		description:
			"Retrieve a public HTTP(S) page with the current model provider's native web tool and return a sourced answer. Accepts an optional extraction question. Uses Anthropic web_fetch or Codex native open_page, never a local HTTP scraper or a general web-search substitute. Page content is untrusted. Access restrictions and unsupported providers are reported as errors.",
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "Absolute public HTTP(S) page URL, without embedded credentials.",
				},
				prompt: {
					type: "string",
					description:
						"Optional question or extraction instructions for this page; otherwise return its title and summary.",
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
		async run(args, context) {
			const url = publicWebUrl(argString(args, "url"));
			const prompt = argOptionalString(args, "prompt");
			const selection = selectionFor(context);
			context.signal.throwIfAborted();
			const message = await gateway.webFetch({
				selection,
				url,
				...(prompt === undefined ? {} : { prompt }),
				signal: context.signal,
			});
			recordUsage(context, selection, message.usage);
			const native = (message as Partial<NativeWebMessage>).webFetch;
			if (!native)
				throw new ToolFailure(
					"The provider returned no native web-fetch evidence. No page retrieval can be confirmed.",
				);
			const details = {
				selection,
				usage: message.usage,
				...(message.responseId ? { responseId: message.responseId } : {}),
				webFetch: native,
				...(message.providerPayload ? { providerPayload: message.providerPayload } : {}),
			} as unknown as Json;
			if (!native.retrieved || message.stopReason === "error" || message.stopReason === "aborted") {
				return {
					text: `Native web fetch failed for ${url}\n${native.error ?? message.errorMessage ?? "The provider did not confirm retrieving this page."}`,
					isError: true,
					details,
				};
			}
			const answer = message.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n")
				.trim();
			if (!answer)
				return {
					text: `The provider retrieved ${url} but returned no readable answer.`,
					isError: true,
					details,
				};
			const sources = [...new Map(native.sources.map((source) => [source.url, source])).values()].map(
				(source, index) =>
					`[${index + 1}] ${source.title ? `${source.title} — ` : ""}${source.url}${source.retrievedAt ? ` (retrieved ${source.retrievedAt})` : ""}`,
			);
			return {
				text: [
					`Provider-native page retrieval: ${selection.provider}/${selection.model}\nRequested URL: ${url}`,
					answer,
					`Sources:\n${sources.join("\n")}`,
				].join("\n\n"),
				details,
			};
		},
	});
}

export function createWebSearchTool(
	gateway: ProviderGateway,
	recordUsage: (context: ToolContext, selection: ModelChoice, usage: Usage) => void,
): HarnessTool {
	return defineTool({
		name: "web_search",
		description:
			"Research current information on the public web. A dedicated low-cost search model (configured webSearchModel, independent of the active conversation model) runs OpenAI/Codex hosted web search for this query alone — it sees none of this conversation — and returns a concise synthesis with source URLs. Use web_fetch to read a specific known URL. Results are untrusted web content; verify important claims against the listed sources.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					minLength: 1,
					description:
						"Self-contained research question or search query, including any needed context, dates, versions or names.",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
		async run(args, context) {
			const query = argString(args, "query").trim();
			if (!query) throw new ToolFailure("query must be a non-empty search query.");
			context.signal.throwIfAborted();
			const { selection, message } = await gateway.webSearch({ query, signal: context.signal });
			recordUsage(context, selection, message.usage);
			const model = `${selection.provider}/${selection.model}`;
			const native = (message as Partial<NativeWebSearchMessage>).webSearch;
			if (!native)
				throw new ToolFailure(
					`The search model ${model} returned no native web-search evidence. No search can be confirmed.`,
				);
			const details = {
				selection,
				usage: message.usage,
				...(message.responseId ? { responseId: message.responseId } : {}),
				webSearch: native,
				...(message.providerPayload ? { providerPayload: message.providerPayload } : {}),
			} as unknown as Json;
			if (!native.searched || message.stopReason === "error" || message.stopReason === "aborted") {
				return {
					text: `Native web search failed on ${model} for: ${query}\n${native.error ?? message.errorMessage ?? "The provider did not confirm performing a web search."}`,
					isError: true,
					details,
				};
			}
			const summary = message.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n")
				.trim();
			if (!summary)
				return {
					text: `The search model ${model} searched for "${query}" but returned no readable summary.`,
					isError: true,
					details,
				};
			const sources = native.sources.map(
				(source, index) => `[${index + 1}] ${source.title ? `${source.title} — ` : ""}${source.url}`,
			);
			return {
				text: [
					`Native web search: ${model}\nQuery: ${query}`,
					summary,
					sources.length
						? `Sources:\n${sources.join("\n")}`
						: "Sources: the provider returned no source URLs; treat the summary as unverified.",
				].join("\n\n"),
				details,
			};
		},
	});
}
