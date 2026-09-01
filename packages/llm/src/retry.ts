/**
 * retry.ts — survive transient rate limits without pretending they aren't there.
 *
 * An agent turn is a chain of requests: think, call a tool, think again. A
 * single 429 in the middle kills the whole turn and loses the work already
 * done, which is a poor outcome when the limit would have cleared in a
 * second or two.
 *
 * ## What the providers actually do
 *
 * Measured, not assumed:
 *
 *  - **NVIDIA NIM** (free tier, ~40 RPM): 60 concurrent requests produced 49
 *    × 200 and 11 × 429. The 429 carries **no `Retry-After`** and no quota
 *    headers at all — body is just `{"status":429,"title":"Too Many
 *    Requests"}`. So a client-side schedule is the only option.
 *  - **Anthropic** sends `x-should-retry` but no reset time on the
 *    subscription path.
 *  - Most OpenAI-compatible providers do send `Retry-After`, which is always
 *    preferred when present — the server knows better than we do.
 *
 * ## Deliberate limits
 *
 * Retrying is only correct for *transient* failures. A 401 will never
 * succeed on retry, and retrying a 400 just repeats a malformed request. Only
 * 429 and 5xx are retried, and only a few times: an agent that silently
 * retries for a minute feels broken, so the cap is low enough that the user
 * sees an error rather than a hang.
 *
 * This is **not** a way to exceed a provider's limits. It smooths bursts
 * inside the allowance; it does not rotate keys or work around the tier.
 */

/**
 * HTTP statuses worth retrying. Everything else fails immediately.
 *
 * **404 is here on purpose.** It normally means "no such thing" and would
 * be pointless to retry — but NVIDIA's free tier answers 404 when a model
 * has no capacity, so the same name succeeds and fails minutes apart.
 * Measured on identical requests: `nemotron-3-super-120b-a12b` failed four
 * of six, while `nemotron-3-nano-30b-a3b` answered five of five.
 *
 * The cost of being wrong here is small and bounded — a genuinely
 * misspelled model spends a few hundred milliseconds before reporting the
 * same error. The cost of NOT retrying was a conversation that died
 * mid-turn and advised the user to change a model that works.
 */
const RETRYABLE = new Set([404, 429, 500, 502, 503, 504]);

/**
 * How many attempts a 404 gets, as against the rest.
 *
 * It is retryable because a busy model answers that way — but it is ALSO
 * how a provider says "that model is not mine", which never changes. Asking
 * NVIDIA for `gpt-5.6-terra` returns 404 and always will, and an agent
 * whose provider and model come from different vendors then spends the
 * whole retry schedule before saying anything. Measured after 404 was made
 * retryable: such an agent sat silent long enough to look wedged.
 *
 * One extra attempt covers a model that is merely busy. Past that, the
 * answer is not going to be different.
 */
const NOT_FOUND_ATTEMPTS = 2;

export interface RetryOptions {
  /** Attempts after the first. Default 3. */
  maxRetries?: number;
  /** First backoff step in ms; doubles each attempt. Default 1000. */
  baseDelayMs?: number;
  /** Never wait longer than this between attempts. Default 20s. */
  maxDelayMs?: number;
  /** Called before each wait, so the UI can say what is happening. */
  onRetry?: (info: { attempt: number; delayMs: number; status: number }) => void;
  signal?: AbortSignal;
}

/** Parse `Retry-After`, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * How long to wait before the next attempt.
 *
 * Exponential backoff with **full jitter**. The jitter matters more than it
 * looks: several agents (or several tool calls in one turn) that hit the same
 * limit would otherwise retry in lockstep and collide again at exactly the
 * same moment.
 */
export function backoffDelay(attempt: number, opts: RetryOptions = {}): number {
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 20_000;
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE.has(status);
}

/**
 * Is this error message a transient capacity problem rather than a real fault?
 *
 * Some providers return capacity errors **inside a 200 response**, so the
 * HTTP layer never sees them. NVIDIA does exactly this: under load the SSE
 * stream carries
 *
 *   data: {"error":{"message":"ResourceExhausted: Worker local total request
 *          limit reached (16/16)","type":"internal_server_error","code":500}}
 *
 * with HTTP 200. Treating that as a hard failure kills an agent turn for a
 * condition that clears in seconds, so the text is matched explicitly.
 *
 * Kept deliberately narrow: only phrases that unambiguously mean "busy, try
 * again". A broad match would silently retry genuine errors and turn a clear
 * failure into a mysterious delay.
 */
export function isTransientErrorMessage(message: string): boolean {
  return /resourceexhausted|too many requests|rate.?limit|capacity|overloaded|try again later|server is busy/i.test(
    message,
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Perform a request, retrying transient failures.
 *
 * Returns the final `Response` — including a failing one once retries are
 * exhausted, so the caller's existing error handling still applies and the
 * user sees the provider's own message rather than a generic "gave up".
 */
export async function fetchWithRetry(
  input: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);

    /*
     * A 404 gets fewer attempts than the rest — see `NOT_FOUND_ATTEMPTS`.
     * It covers a busy model, but it is also how a provider says "not
     * mine", and an agent configured with a model from another vendor
     * should say so quickly rather than sitting through the full schedule
     * looking wedged.
     */
    const ceiling = res.status === 404 ? Math.min(maxRetries, NOT_FOUND_ATTEMPTS) : maxRetries;

    if (res.ok || !isRetryableStatus(res.status) || attempt >= ceiling) return res;

    // The server's own advice wins when it gives any; NVIDIA's free tier
    // gives none, hence the fallback schedule.
    const advised = parseRetryAfter(res.headers.get('retry-after'));
    const delayMs = advised ?? backoffDelay(attempt, opts);

    opts.onRetry?.({ attempt: attempt + 1, delayMs, status: res.status });

    // Drain the body so the connection can be reused.
    await res.text().catch(() => '');
    await sleep(delayMs, opts.signal);
  }
}
