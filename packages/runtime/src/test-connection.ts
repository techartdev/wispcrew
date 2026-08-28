/**
 * test-connection.ts — does the configured provider actually answer?
 *
 * The difference between "configured" and "working". A key can be present,
 * well-formed and wrong; a base URL can point at nothing; a subscription can
 * have expired. Finding that out from a failed agent turn is a poor way to
 * learn it, which is why this exists as its own check.
 *
 * Moved out of the desktop bridge so the CLI can offer it too. A headless
 * machine is exactly where this matters most — there is no settings panel to
 * show a red dot, and the first symptom would otherwise be an agent that
 * produces nothing.
 *
 * The two comments below record failures that actually shipped, and both
 * would have returned quietly with the wrong answer.
 */
import { configFromPreset, createProvider, describeProviderError } from '@wispcrew/llm';
import { host } from './host.js';
import { resolveToken, type OAuthVendor } from './oauth-store.js';
import { providerSecretKey } from './provider-keys.js';
import { readSecrets } from './secrets-store.js';

export interface ConnectionTest {
  ok: boolean;
  error?: string;
  latencyMs?: number;
}

export async function testConnection(cfg: {
  presetId: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): Promise<ConnectionTest> {
  const started = Date.now();
  const dataDir = host().dataDir;

  try {
    /*
     * Resolve the credential exactly as a real turn does.
     *
     * A subscription preset authenticates with an OAuth token and, for
     * ChatGPT, an account id — neither of which is an API key. Reading only
     * the key made this report "the ChatGPT sign-in is missing its account
     * id" for a sign-in that worked perfectly in conversation: a false
     * failure, and a confusing one, because the advice it offered ("sign in
     * again") could not have helped.
     */
    const vendor: OAuthVendor | null =
      cfg.presetId === 'chatgpt-subscription'
        ? 'chatgpt'
        : cfg.presetId === 'claude-subscription'
          ? 'anthropic'
          : null;

    let key: string | undefined;
    let accountId: string | undefined;

    if (vendor) {
      const credential = await resolveToken(dataDir, vendor);
      if (!credential) {
        return {
          ok: false,
          error:
            vendor === 'chatgpt'
              ? 'Not signed in to ChatGPT. Sign in, then test again.'
              : 'Not signed in to Claude. Sign in, then test again.',
        };
      }
      key = credential.access;
      // `null` and `undefined` mean the same thing here — no account id —
      // but the preset builder only accepts one of them.
      accountId = (credential as { accountId?: string | null }).accountId ?? undefined;
    } else {
      /*
       * Fall back to the stored key, so testing needs no retyping.
       *
       * Resolved per provider, then the legacy shared name. Reading only the
       * legacy one made this report "needs an API key" for a provider whose
       * key was present and working — migration had moved it to
       * WISPCREW_KEY_<preset>, and this path had not been updated to look
       * there.
       */
      const secrets = readSecrets(dataDir);
      key =
        cfg.apiKey ||
        secrets[providerSecretKey(cfg.presetId)] ||
        secrets.WISPCREW_API_KEY ||
        process.env.WISPCREW_API_KEY;
    }

    const preset = {
      ...configFromPreset(cfg.presetId, {
        apiKey: key,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
      }),
      ...(accountId ? { accountId } : {}),
    };

    const provider = createProvider(preset);
    const check = provider.validate();
    if (!check.ok) return { ok: false, error: check.error };

    let sawDone = false;
    let failure = '';

    // One tiny non-streaming request: enough to prove the endpoint answers
    // and authenticates, cheap enough to run whenever someone wonders.
    for await (const chunk of provider.chat({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
      stream: false,
    })) {
      if (chunk.kind === 'done') sawDone = true;
      else if (chunk.kind === 'error') failure = chunk.message;
    }

    /*
     * An error anywhere in the stream is a failure, even when `done`
     * follows it.
     *
     * The old loop set `ok = true` on `done` and cleared the message — but
     * closing a stream with `done` after an error is the normal way to end
     * one, so the error was erased. That is how "The provider answered" was
     * reported for a model returning 404: the configuration passed its own
     * check and then failed every real turn, which is worse than no check
     * at all.
     */
    const ok = sawDone && failure === '';
    const error = failure || (sawDone ? '' : 'No response from the endpoint.');

    return { ok, error: error || undefined, latencyMs: Date.now() - started };
  } catch (err) {
    /*
     * A misconfiguration is explained rather than dumped.
     *
     * This is exactly where someone is trying to find out what is wrong, so
     * "connect ECONNREFUSED 127.0.0.1:11434" becomes "start Ollama".
     */
    const target = configFromPreset(cfg.presetId, {
      model: cfg.model,
      baseUrl: cfg.baseUrl,
    });
    /*
     * `describeProviderError` returns null when it has nothing better to say
     * than the original message — so fall back to that rather than reporting
     * a failure with no reason at all.
     */
    const described = describeProviderError(err, target);
    return { ok: false, error: described ?? (err as Error).message };
  }
}
