/**
 * usage-limits.ts — read subscription quota from provider responses.
 *
 * A subscription has limits, and hitting one with no warning is the single
 * most frustrating way for this feature to fail: the turn just stops working
 * and nothing explains why or for how long.
 *
 * ## Where the numbers come from
 *
 * There is **no usage endpoint**. Every plausible one
 * (`/codex/usage`, `/codex/rate_limits`, `/codex/credits`,
 * `/accounts/check`) returns 403, and the SSE stream carries no
 * rate-limit events — both checked directly. The only source is the
 * response headers of a real request, which means usage is known *after*
 * a turn rather than before one. That is acceptable: the moment a user
 * cares about their remaining quota is right after using some of it.
 *
 * The Codex headers observed live:
 *
 *   x-codex-active-limit                          e.g. "premium"
 *   x-codex-primary-over-secondary-limit-percent  percentage used
 *   x-codex-primary-reset-after-seconds           seconds until reset
 *   x-codex-primary-reset-at                      unix seconds
 *   x-codex-credits-balance / -has-credits / -unlimited
 *
 * Anthropic sends `anthropic-ratelimit-*` headers on API-key requests, and
 * on the subscription path returns 429 with `x-should-retry` when the plan
 * limit is reached — so its quota is reported as "limited / not limited"
 * rather than a percentage. Claiming more precision than the provider gives
 * would be inventing numbers.
 */

/** What the UI can show about a subscription's remaining quota. */
export interface UsageSnapshot {
  /** Which plan tier the limit applies to, when the provider names it. */
  tier?: string;
  /** 0-100, when the provider reports a percentage. */
  percentUsed?: number;
  /** When the window resets (epoch ms). */
  resetsAt?: number;
  /** True when the provider says the limit is currently exceeded. */
  limited?: boolean;
  /** Pay-as-you-go credit balance, for plans that expose one. */
  creditsBalance?: number;
  creditsUnlimited?: boolean;
  /** When this snapshot was taken (epoch ms). */
  observedAt: number;
}

function num(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read a snapshot from Codex backend response headers.
 *
 * Returns undefined when none of the headers are present, so a provider that
 * stops sending them degrades to "no usage information" rather than showing
 * a misleading zero.
 */
export function usageFromCodexHeaders(headers: Headers): UsageSnapshot | undefined {
  const tier = headers.get('x-codex-active-limit') ?? undefined;
  const percentUsed = num(headers.get('x-codex-primary-over-secondary-limit-percent'));
  const resetAfter = num(headers.get('x-codex-primary-reset-after-seconds'));
  const resetAtSeconds = num(headers.get('x-codex-primary-reset-at'));
  const balance = num(headers.get('x-codex-credits-balance'));
  const unlimited = headers.get('x-codex-credits-unlimited');

  if (
    tier === undefined &&
    percentUsed === undefined &&
    resetAfter === undefined &&
    balance === undefined
  ) {
    return undefined;
  }

  // Prefer the absolute reset time; fall back to the relative one, which is
  // immune to clock skew between the machine and the server.
  const resetsAt =
    resetAtSeconds !== undefined
      ? resetAtSeconds * 1000
      : resetAfter !== undefined
        ? Date.now() + resetAfter * 1000
        : undefined;

  return {
    tier,
    percentUsed,
    resetsAt,
    limited: percentUsed !== undefined ? percentUsed >= 100 : undefined,
    creditsBalance: balance,
    creditsUnlimited: unlimited === 'True' || unlimited === 'true',
    observedAt: Date.now(),
  };
}

/**
 * Read what Anthropic exposes.
 *
 * The subscription path gives no percentage — only whether the limit is
 * currently hit — so the snapshot says exactly that and nothing more.
 */
export function usageFromAnthropicHeaders(
  headers: Headers,
  status: number,
): UsageSnapshot | undefined {
  const resetHeader =
    headers.get('anthropic-ratelimit-unified-reset') ??
    headers.get('anthropic-ratelimit-requests-reset');
  const retryAfter = num(headers.get('retry-after'));

  const limited = status === 429;
  if (!limited && !resetHeader && retryAfter === undefined) return undefined;

  let resetsAt: number | undefined;
  if (resetHeader) {
    const asNumber = Number(resetHeader);
    // The header is either unix seconds or an ISO timestamp depending on
    // which variant the endpoint sends.
    resetsAt = Number.isFinite(asNumber) ? asNumber * 1000 : Date.parse(resetHeader) || undefined;
  } else if (retryAfter !== undefined) {
    resetsAt = Date.now() + retryAfter * 1000;
  }

  return { limited, resetsAt, observedAt: Date.now() };
}

/** A short, honest sentence for the UI. */
export function describeUsage(u: UsageSnapshot | undefined): string {
  if (!u) return 'Usage information is not available for this provider.';

  const parts: string[] = [];
  if (u.percentUsed !== undefined) {
    parts.push(`${Math.round(u.percentUsed)}% of your ${u.tier ?? 'plan'} limit used`);
  } else if (u.limited) {
    parts.push('Plan limit reached');
  } else if (u.tier) {
    parts.push(`On the ${u.tier} limit`);
  }

  if (u.resetsAt !== undefined) {
    const ms = u.resetsAt - Date.now();
    if (ms > 0) parts.push(`resets ${formatDuration(ms)}`);
  }
  if (u.creditsUnlimited) parts.push('unlimited credits');
  else if (u.creditsBalance !== undefined && u.creditsBalance > 0) {
    parts.push(`${u.creditsBalance} credits`);
  }

  return parts.length ? parts.join(' · ') : 'Usage information is not available.';
}

/** "in 4 days", "in 3 hours", "in 12 minutes". */
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}
