/**
 * errors.ts — turn provider failures into something a user can act on.
 *
 * Raw failures are hostile: an HTTP 401 arrives as a wall of JSON, and a
 * wrong base URL arrives as the single word "fetch failed". Neither tells
 * someone what to change. Since WispCrew's whole premise is that you bring
 * your own provider, misconfiguration is the *expected* first-run state, not
 * an edge case — so these messages are part of the product.
 *
 * Each message says what happened and what to do next, and keeps a short
 * excerpt of the original so a bug report is still diagnosable.
 */

/** Network-level failure kinds we can recognise from a thrown Error. */
function networkHint(err: Error, baseUrl: string): string | null {
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  const code = cause?.code ?? '';
  const message = `${err.message} ${code}`.toLowerCase();

  const isLocal = /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/.test(baseUrl);

  if (message.includes('econnrefused') || message.includes('fetch failed')) {
    return isLocal
      ? `Could not reach ${baseUrl}. Is the local server running? ` +
          'For Ollama, start it with `ollama serve`; for LM Studio, start the local server from its Developer tab.'
      : `Could not reach ${baseUrl}. Check the Base URL in Settings and your internet connection.`;
  }
  if (message.includes('enotfound') || message.includes('eai_again')) {
    return `The host in ${baseUrl} could not be resolved. Check the Base URL for a typo.`;
  }
  if (message.includes('certificate') || message.includes('self-signed')) {
    return `The TLS certificate for ${baseUrl} was rejected. If this is a private endpoint, it needs a certificate your system trusts.`;
  }
  if (message.includes('timeout') || message.includes('etimedout')) {
    return `${baseUrl} did not respond in time. The provider may be slow or unreachable.`;
  }
  if (err.name === 'AbortError') return null; // user pressed Stop; not an error
  return null;
}

/** Pull a provider's own `error.message` out of a JSON error body. */
function extractApiMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const msg = parsed.error?.message ?? parsed.message;
    return typeof msg === 'string' && msg.trim() ? msg.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Build a human-facing message for an HTTP status from a chat endpoint.
 *
 * `label` is the provider's display name, so "Groq rejected the API key"
 * reads correctly regardless of which endpoint is configured.
 */
export function describeHttpFailure(
  status: number,
  body: string,
  label: string,
  model: string,
): string {
  const detail = extractApiMessage(body);
  const suffix = detail ? ` (${detail})` : '';

  switch (status) {
    case 401:
    case 403:
      return `${label} rejected the API key. Open Settings and check the key is correct and still active${suffix}`;
    /*
     * 404 is not only "no such model".
     *
     * NVIDIA's free tier answers 404 when a model has no capacity right
     * now, so the same name succeeds and fails minutes apart — measured at
     * 2 of 6 for `nemotron-3-super-120b-a12b` while `nemotron-3-nano-30b-a3b`
     * was 5 of 5. Telling someone to pick a different model is the wrong
     * advice for a model that works: they change a good setting and the
     * next failure looks like a different bug.
     *
     * Retried before this is ever shown (see `withRetry`), so by the time
     * it appears the endpoint has refused several times.
     */
    case 404:
      return (
        `${label} would not serve the model "${model}" — it may be unavailable right now, ` +
        `or the name may be wrong. Some free tiers answer this way when a model is busy${suffix}`
      );
    case 429:
      return `${label} is rate-limiting or you are out of quota. Wait a moment, or check your billing and usage${suffix}`;
    case 400:
      return (
        `${label} rejected the request${suffix}. ` +
        'This often means the model does not support something the request used — ' +
        'try a different model in Settings, or remove any attachments.'
      );
    case 413:
      return `The request was too large for ${label}. Try removing attachments or clearing the conversation${suffix}`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `${label} had a server error (HTTP ${status}). This is on their side — try again shortly${suffix}`;
    default:
      return `${label} returned HTTP ${status}${suffix || `: ${body.slice(0, 200)}`}`;
  }
}

/**
 * Convert any thrown provider error into an actionable message.
 *
 * Returns null for a user-initiated abort, which is not a failure and should
 * not be shown as one.
 */
export function describeProviderError(
  err: unknown,
  ctx: { label: string; baseUrl: string; model: string },
): string | null {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'AbortError') return null;

  const hint = networkHint(err, ctx.baseUrl);
  if (hint) return hint;

  // Our adapters throw with the status and body embedded; recover them so the
  // user gets the friendly form rather than the raw dump.
  const m = /HTTP (\d{3}):\s*([\s\S]*)$/.exec(err.message);
  if (m) {
    return describeHttpFailure(Number(m[1]), m[2] ?? '', ctx.label, ctx.model);
  }

  return err.message;
}
