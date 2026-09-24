import type { Usage } from "@oh-my-pi/pi-ai";
import { resolveUsedFraction } from "@oh-my-pi/pi-ai/usage";
import type { ModelChoice, ProviderUsage } from "../contracts.ts";
import type { AuxUsageRecord, StoredEntry } from "./store.ts";

export interface UsageSource {
	label: string;
	selection: ModelChoice;
	history: readonly StoredEntry[];
	extra: readonly AuxUsageRecord[];
}

interface Totals {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	tokens: number;
	cost: number;
}

function empty(): Totals {
	return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, tokens: 0, cost: 0 };
}
function finite(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) ? value : 0;
}
function add(total: Totals, usage: Usage): void {
	total.requests++;
	total.input += finite(usage.input);
	total.output += finite(usage.output);
	total.cacheRead += finite(usage.cacheRead);
	total.cacheWrite += finite(usage.cacheWrite);
	total.reasoning += finite(usage.reasoningTokens);
	total.tokens += finite(usage.totalTokens);
	total.cost += finite(usage.cost?.total);
}
const number = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function formatSessionUsage(sources: readonly UsageSource[]): string {
	const total = empty();
	const rows: string[] = [];
	let auxiliary = 0;
	for (const source of sources) {
		const own = empty();
		for (const { entry } of source.history) {
			if (entry.kind === "message" && entry.message.role === "assistant") {
				add(own, entry.message.usage);
				add(total, entry.message.usage);
			}
		}
		for (const entry of source.extra) {
			add(own, entry.usage);
			add(total, entry.usage);
			auxiliary++;
		}
		rows.push(
			`${source.label} · ${source.selection.provider}/${source.selection.model}: ${number(own.requests)} requests, ${number(own.tokens)} tokens`,
		);
	}
	const prompt = total.input + total.cacheRead + total.cacheWrite;
	const hit = prompt > 0 ? `${((total.cacheRead / prompt) * 100).toFixed(1)}%` : "n/a";
	return [
		"Session usage — recorded requests, including child agents",
		...rows,
		`Total: ${number(total.requests)} requests (${auxiliary} auxiliary: recap/compaction/web fetch/web search), ${number(total.tokens)} tokens`,
		`Input uncached: ${number(total.input)} · output: ${number(total.output)}`,
		`Cache read: ${number(total.cacheRead)} · cache write: ${number(total.cacheWrite)} · prompt cache hit: ${hit}`,
		...(total.reasoning > 0
			? [`Reasoning: ${number(total.reasoning)} tokens (already included in output)`]
			: []),
		total.cost > 0
			? `Catalog cost estimate: $${total.cost.toFixed(6)} — not a subscription charge or invoice.`
			: "Cost estimate: unavailable or unpriced; this does not imply unlimited/free quota.",
		"Provider quota is account-wide, not this session's token total. Requests whose provider supplies no usage cannot be counted.",
	].join("\n");
}

export function formatProviderUsage(usage: ProviderUsage): string {
	if (!usage.report)
		return `${usage.provider}: usage unavailable — ${usage.unavailable ?? "the provider returned no quota report"}`;
	const report = usage.report;
	const rows = [`${usage.provider} — account quota · fetched ${new Date(report.fetchedAt).toLocaleString()}`];
	if (report.notes?.length) rows.push(...report.notes);
	if (!report.limits.length) rows.push("No quota windows reported; this does not mean unlimited quota.");
	for (const limit of report.limits) {
		const amount = limit.amount;
		const fraction = resolveUsedFraction(limit);
		const values: string[] = [];
		if (fraction !== undefined && Number.isFinite(fraction))
			values.push(`${(fraction * 100).toFixed(1)}% used`);
		if (amount.used !== undefined && amount.limit !== undefined)
			values.push(`${number(amount.used)} / ${number(amount.limit)} ${amount.unit}`);
		else if (amount.used !== undefined && amount.unit !== "percent")
			values.push(`${number(amount.used)} ${amount.unit} used`);
		if (amount.remaining !== undefined) values.push(`${number(amount.remaining)} ${amount.unit} remaining`);
		if (!values.length) values.push("utilization not supplied");
		if (limit.window?.resetsAt !== undefined && Number.isFinite(limit.window.resetsAt)) {
			values.push(
				`${limit.window.resetLabel ?? "resets"} ${new Date(limit.window.resetsAt).toLocaleString()}`,
			);
		}
		if (limit.status && limit.status !== "unknown") values.push(limit.status);
		rows.push(`  ${limit.label}: ${values.join(" · ")}`);
		if (limit.notes?.length) rows.push(...limit.notes.map((note) => `    ${note}`));
	}
	return rows.join("\n");
}
