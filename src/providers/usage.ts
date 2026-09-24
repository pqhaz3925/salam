import type {
	UsageCredential,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "@oh-my-pi/pi-ai/usage";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";
import { devinUsageProvider } from "@oh-my-pi/pi-ai/usage/devin";
import { openaiCodexUsageProvider } from "@oh-my-pi/pi-ai/usage/openai-codex";
import type { ProviderKind, ProviderProfile, ProviderUsage } from "../contracts";
import type { Credential } from "./auth";

/**
 * Read-only subscription quota endpoints. Each fetcher issues plain reads of the
 * account's own limit windows; none of them redeems a banked reset, clears a
 * window, or spends an allowance. Custom endpoints have no quota API at all.
 */
export const usageFetchers: Partial<Record<ProviderKind, UsageProvider>> = {
	anthropic: claudeUsageProvider,
	"openai-codex": openaiCodexUsageProvider,
	devin: devinUsageProvider,
};
const deadlineMs = 20_000;

export function usageUnavailable(provider: string, reason: string): ProviderUsage {
	return { provider, fetchedAt: Date.now(), unavailable: reason };
}

/** Salam normalizes every credential to one bearer string; the fetchers take it in their own slot. */
function usageCredential(kind: ProviderKind, credential: Credential): UsageCredential {
	// Devin's seat-management endpoint authenticates the CLI session token itself.
	if (kind === "devin") return { type: "api_key", apiKey: credential.apiKey };
	return {
		type: "oauth",
		accessToken: credential.apiKey,
		...(credential.accountId ? { accountId: credential.accountId } : {}),
	};
}

/** Quota output is rendered in the transcript: account, org, and project identity stay out of it. */
function publicLimit(limit: UsageLimit): UsageLimit {
	const scope = limit.scope;
	return {
		id: limit.id,
		label: limit.label,
		scope: {
			provider: scope.provider,
			...(scope.modelId === undefined ? {} : { modelId: scope.modelId }),
			...(scope.tier === undefined ? {} : { tier: scope.tier }),
			...(scope.windowId === undefined ? {} : { windowId: scope.windowId }),
			...(scope.shared === undefined ? {} : { shared: scope.shared }),
			...(scope.sharedGroup === undefined ? {} : { sharedGroup: scope.sharedGroup }),
		},
		...(limit.window ? { window: limit.window } : {}),
		amount: limit.amount,
		...(limit.status ? { status: limit.status } : {}),
		...(limit.notes ? { notes: limit.notes } : {}),
	};
}

function redact(error: unknown, credential: Credential): string {
	let message = error instanceof Error ? error.message : String(error);
	for (const secret of [credential.apiKey, credential.accountId]) {
		if (secret) message = message.replaceAll(secret, "[credential redacted]");
	}
	return message;
}

/**
 * One bounded, cancellable read of the provider's own quota endpoint. A missing
 * endpoint, a refused credential, a timeout, or an empty answer is reported as
 * explicitly unavailable; no window is ever invented as zero-used or unlimited
 * on the provider's behalf.
 */
export async function fetchProviderUsage(
	provider: string,
	profile: ProviderProfile,
	credential: Credential,
	fetcher: UsageProvider,
	signal: AbortSignal,
): Promise<ProviderUsage> {
	signal.throwIfAborted();
	const deadline = new AbortController();
	const timer = setTimeout(
		() => deadline.abort(new DOMException("Usage request timed out.", "TimeoutError")),
		deadlineMs,
	);
	// Devin's quota lives on the Cascade seat-management host, never on the api.devin.ai
	// endpoint stored with the credential (that one only mints session tokens) nor on a
	// configured inference base, so its fetcher keeps its own default.
	const baseUrl = profile.kind === "devin" ? undefined : (profile.baseUrl ?? credential.baseUrl);
	const params: UsageFetchParams = {
		provider: fetcher.id,
		credential: usageCredential(profile.kind, credential),
		signal: AbortSignal.any([signal, deadline.signal]),
		...(baseUrl ? { baseUrl } : {}),
	};
	const expired = `The ${provider} quota endpoint did not answer within ${deadlineMs / 1000} seconds.`;
	try {
		if (fetcher.supports && !fetcher.supports(params))
			return usageUnavailable(
				provider,
				`The ${provider} credential from ${credential.source} is not a subscription token its quota endpoint accepts.`,
			);
		let report: UsageReport | null;
		try {
			report = await fetcher.fetchUsage(params, { fetch: globalThis.fetch });
		} catch (error) {
			signal.throwIfAborted();
			if (deadline.signal.aborted) return usageUnavailable(provider, expired);
			return usageUnavailable(provider, redact(error, credential));
		}
		signal.throwIfAborted();
		if (deadline.signal.aborted) return usageUnavailable(provider, expired);
		if (!report || report.limits.length === 0)
			return usageUnavailable(
				provider,
				`${provider} returned no quota data: the endpoint answered without a limit window for this account.`,
			);
		const planType = report.metadata?.planType;
		return {
			provider,
			fetchedAt: Date.now(),
			report: {
				provider: report.provider,
				fetchedAt: report.fetchedAt,
				limits: report.limits.map(publicLimit),
				...(report.resetCredits ? { resetCredits: report.resetCredits } : {}),
				...(report.notes ? { notes: report.notes } : {}),
				...(typeof planType === "string" ? { metadata: { planType } } : {}),
			},
		};
	} finally {
		clearTimeout(timer);
	}
}
