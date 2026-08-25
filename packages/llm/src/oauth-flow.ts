/**
 * oauth-flow.ts — sign in to Claude with a browser, no CLI required.
 *
 * This is the same flow the Claude Code CLI uses: PKCE (S256) against
 * Anthropic's public OAuth client, with the authorization code delivered to
 * Anthropic's own callback page, which the user pastes back.
 *
 * ## Why the user has to paste a code
 *
 * The obvious design for a desktop app is a loopback redirect
 * (`http://127.0.0.1:<port>/callback`) so the code arrives automatically.
 * That does not work here: the client id is registered with exactly one
 * redirect — `https://platform.claude.com/oauth/code/callback` — and
 * Anthropic rejects localhost redirects for it. The callback page therefore
 * shows the value and the user pastes it back, exactly as `claude login`
 * does. This is a constraint of the provider's registration, not a shortcut.
 *
 * ## Read this before enabling it
 *
 * **Anthropic prohibits third-party tools from using subscription OAuth
 * tokens.** Their Claude Code documentation says so explicitly, and
 * enforcement can arrive without warning against the *user's* account.
 * WispCrew therefore never turns this on by itself: it is opt-in, and the UI
 * states the risk. An API key remains the supported path.
 *
 * The endpoints and client id below are not guesses — an earlier draft
 * inferred them and was wrong. They match a working implementation of the
 * Claude Code flow.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Anthropic's public OAuth client (Claude Code / the desktop app). */
export const ANTHROPIC_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  /** The only redirect registered for this client; localhost is rejected. */
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  /** The scopes the Claude Code CLI requests. `user:inference` is the one
   *  that actually permits model calls. */
  scopes:
    'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers',
} as const;

/** How long one token request may take before we give up. */
const TOKEN_TIMEOUT_MS = 30_000;

/**
 * A refreshed token is treated as expiring five minutes early, so a long
 * streaming turn cannot die mid-flight on a token that lapsed after the
 * request began.
 */
const EXPIRY_SAFETY_MS = 5 * 60 * 1000;

export interface OAuthCredential {
  type: 'oauth';
  access: string;
  refresh: string;
  /** Epoch ms, already reduced by the safety margin. */
  expires: number;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** base64url without padding, as PKCE requires. */
function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Generate a PKCE verifier and its S256 challenge. */
export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Build the URL to open in the user's browser.
 *
 * `state` is the verifier, matching the reference flow: the callback page
 * echoes it back alongside the code, which lets the exchange prove the two
 * halves belong together.
 */
export function buildAuthorizeUrl(pkce: PkcePair): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: ANTHROPIC_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: ANTHROPIC_OAUTH.redirectUri,
    scope: ANTHROPIC_OAUTH.scopes,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.verifier,
  });
  return `${ANTHROPIC_OAUTH.authorizeUrl}?${params.toString()}`;
}

/**
 * Make sense of whatever the user pasted.
 *
 * The callback page shows `code#state`, but people paste the whole URL, or
 * just the code, or a query string. Accepting all of these avoids a
 * confusing "invalid code" for what is really a copy-paste variation — the
 * one failure mode guaranteed to make a sign-in flow feel broken.
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  // A full redirect URL, with the values in the query or the fragment.
  try {
    const url = new URL(value);
    const query = url.searchParams;
    const fragment = url.hash.startsWith('#') ? new URLSearchParams(url.hash.slice(1)) : null;
    const code = query.get('code') ?? fragment?.get('code') ?? undefined;
    const state = query.get('state') ?? fragment?.get('state') ?? undefined;
    if (code) return { code, state };
  } catch {
    // Not a URL; fall through to the simpler forms.
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined };
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
  }
  return { code: value };
}

/** POST a JSON body to the token endpoint, with useful errors. */
async function postToken(body: Record<string, string>, label: string): Promise<{
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}> {
  const res = await fetch(ANTHROPIC_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await res.text();

  if (!res.ok) {
    // `invalid_grant` almost always means the code expired — it is valid for
    // roughly a minute — or the wrong value was pasted. Say that, rather
    // than showing a bare 400.
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      if (parsed.error === 'invalid_grant') {
        detail =
          'the code was rejected. Codes expire after about a minute — start the sign-in again and paste the new code promptly.';
      } else if (parsed.error_description ?? parsed.error) {
        detail = parsed.error_description ?? parsed.error!;
      }
    } catch {
      /* keep the raw excerpt */
    }
    throw new Error(`${label} failed (HTTP ${res.status}): ${detail}`);
  }

  try {
    return JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`${label} returned a response that was not JSON: ${text.slice(0, 200)}`);
  }
}

/** Exchange the pasted authorization code for tokens. */
export async function exchangeAuthorizationCode(
  code: string,
  state: string,
  verifier: string,
): Promise<OAuthCredential> {
  const data = await postToken(
    {
      grant_type: 'authorization_code',
      client_id: ANTHROPIC_OAUTH.clientId,
      code,
      state,
      redirect_uri: ANTHROPIC_OAUTH.redirectUri,
      code_verifier: verifier,
    },
    'Sign-in',
  );
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Sign-in succeeded but returned no tokens.');
  }
  return {
    type: 'oauth',
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_SAFETY_MS,
  };
}

/** Exchange a refresh token for a fresh credential. */
export async function refreshCredential(current: OAuthCredential): Promise<OAuthCredential> {
  const data = await postToken(
    {
      grant_type: 'refresh_token',
      client_id: ANTHROPIC_OAUTH.clientId,
      refresh_token: current.refresh,
    },
    'Token refresh',
  );
  if (!data.access_token) throw new Error('Token refresh returned no access token.');
  return {
    type: 'oauth',
    access: data.access_token,
    // Refresh tokens rotate; keep the new one when given, or the old one is
    // retired and the next refresh fails.
    refresh: data.refresh_token ?? current.refresh,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_SAFETY_MS,
  };
}

/** True when the credential is missing, malformed, or due for refresh. */
export function isExpired(credential: OAuthCredential | undefined): boolean {
  if (!credential || typeof credential.access !== 'string') return true;
  return !Number.isFinite(credential.expires) || Date.now() >= credential.expires;
}
