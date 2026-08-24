/**
 * subscription-auth.ts — reuse a locally-installed AI CLI's sign-in.
 *
 * Claude Code and Codex CLI both let a *subscriber* work without an API key
 * by signing in with their account. Each stores the resulting OAuth tokens in
 * a well-known file. This module reads those files so GhostBot can offer the
 * same convenience.
 *
 * ## Read this before using it
 *
 * **Anthropic prohibits this.** Their Claude Code documentation was updated
 * to forbid using OAuth tokens from Free, Pro or Max subscriptions in
 * third-party products; enforcement can happen without warning, and the
 * account at risk is the user's. GhostBot therefore never enables this
 * silently — it must be switched on deliberately, and the UI says plainly
 * what is being risked.
 *
 * **OpenAI's position is different but undocumented for this use.** "Sign in
 * with ChatGPT" is a real product, but the subscription-billing path is
 * documented for OpenAI's own surfaces (ChatGPT app, Codex CLI, IDE
 * extension). Whether a third-party app may bill inference against a user's
 * ChatGPT subscription is not something we could establish.
 *
 * **These formats are undocumented and unversioned.** They belong to other
 * tools. A change breaks us with no notice, so every read is defensive and
 * failure is always reported as "sign-in unavailable", never as a crash.
 *
 * The honest alternative is an API key, which is why that remains the
 * default and the recommended path everywhere in the UI.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where each CLI keeps its credentials. */
const CLAUDE_CREDENTIALS = ['.claude', '.credentials.json'];
const CODEX_CREDENTIALS = ['.codex', 'auth.json'];

/**
 * Anthropic's public OAuth client (the one Claude Code and the desktop app
 * use) and its token endpoint.
 *
 * These are **not** guesses. An earlier draft of this file inferred
 * `console.anthropic.com/v1/oauth/token` from OAuth convention and it was
 * wrong. The correct values were taken from a working implementation — the
 * `dsh-claude-oauth` plugin — which mirrors the Claude Code CLI flow:
 * refresh is a POST to platform.claude.com carrying the client id.
 */
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

/**
 * A refreshed access token is treated as expiring five minutes early.
 *
 * The token is used for streaming turns that can run for minutes; expiring
 * mid-stream produces a confusing failure rather than a clean refresh.
 */
const EXPIRY_SAFETY_MS = 5 * 60 * 1000;

export type SubscriptionVendor = 'anthropic' | 'openai';

export interface SubscriptionAuth {
  vendor: SubscriptionVendor;
  accessToken: string;
  /** Epoch ms, when known. Absent means the file carried no expiry. */
  expiresAt?: number;
  /** e.g. "max", "pro" — display only. */
  plan?: string;
  /** OAuth scopes, when the file records them. */
  scopes?: string[];
  /** Which CLI the credentials came from, for the UI to name. */
  source: string;
}

/** Result of looking for a usable local sign-in. */
export type SubscriptionLookup =
  | { status: 'found'; auth: SubscriptionAuth }
  | { status: 'expired'; vendor: SubscriptionVendor; source: string; expiredAt: number }
  | { status: 'not-signed-in'; vendor: SubscriptionVendor; source: string }
  | { status: 'unavailable'; vendor: SubscriptionVendor; source: string; reason: string };

function homeFile(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

/**
 * Rewrite a credentials file **in place**, preserving everything we did not
 * set.
 *
 * This file belongs to another program. Three precautions, each for a
 * failure that would break the *user's other tools* rather than GhostBot:
 *
 *  1. **Merge, never replace.** Unknown fields are carried through verbatim,
 *     so a future CLI version storing extra state does not lose it.
 *  2. **Atomic write.** Temp file plus rename — a crash mid-write must not
 *     truncate the file and log the user out of their CLI.
 *  3. **One-time backup.** The original is copied to `<name>.ghostbot-backup`
 *     before the first modification, so there is always a way back.
 */
function updateCredentialsFile(
  file: string,
  mutate: (json: Record<string, unknown>) => Record<string, unknown>,
): boolean {
  try {
    const current = readJsonSafe(file);
    if (!current) return false;

    const backup = `${file}.ghostbot-backup`;
    if (!fs.existsSync(backup)) {
      try {
        fs.copyFileSync(file, backup);
      } catch {
        // A failed backup is not fatal, but proceed only because the write
        // itself is atomic; the user still has the original until rename.
      }
    }

    const next = mutate(current);
    const tmp = `${file}.ghostbot-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Parse JSON defensively; these files belong to other programs. */
function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Look for a Claude Code sign-in.
 *
 * The file records `subscriptionType` and `scopes`; `user:inference` is the
 * scope that actually permits model calls, so its absence is reported rather
 * than discovered later as a confusing 403.
 */
export function findAnthropicSubscription(): SubscriptionLookup {
  const source = 'Claude Code';
  const file = homeFile(...CLAUDE_CREDENTIALS);
  if (!fs.existsSync(file)) return { status: 'not-signed-in', vendor: 'anthropic', source };

  const json = readJsonSafe(file);
  const oauth = json?.claudeAiOauth as Record<string, unknown> | undefined;
  const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';
  if (!token) {
    return {
      status: 'unavailable',
      vendor: 'anthropic',
      source,
      reason: 'No access token found — sign in with `claude` first.',
    };
  }

  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return { status: 'expired', vendor: 'anthropic', source, expiredAt: expiresAt };
  }

  const scopes = Array.isArray(oauth?.scopes) ? (oauth.scopes as string[]) : undefined;
  if (scopes && !scopes.includes('user:inference')) {
    return {
      status: 'unavailable',
      vendor: 'anthropic',
      source,
      reason: 'This sign-in does not carry the inference scope needed to run a model.',
    };
  }

  return {
    status: 'found',
    auth: {
      vendor: 'anthropic',
      accessToken: token,
      expiresAt,
      plan: typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
      scopes,
      source,
    },
  };
}

/**
 * Look for a Codex CLI sign-in.
 *
 * `auth_mode` distinguishes a ChatGPT sign-in from a plain stored API key;
 * only the former is a subscription sign-in.
 */
export function findOpenAiSubscription(): SubscriptionLookup {
  const source = 'Codex CLI';
  const file = homeFile(...CODEX_CREDENTIALS);
  if (!fs.existsSync(file)) return { status: 'not-signed-in', vendor: 'openai', source };

  const json = readJsonSafe(file);
  const mode = typeof json?.auth_mode === 'string' ? json.auth_mode : '';
  const tokens = json?.tokens as Record<string, unknown> | undefined;
  const token = typeof tokens?.access_token === 'string' ? tokens.access_token : '';

  if (!token) {
    return {
      status: 'unavailable',
      vendor: 'openai',
      source,
      reason: 'No access token found — sign in with `codex` first.',
    };
  }
  if (mode && mode !== 'chatgpt') {
    return {
      status: 'unavailable',
      vendor: 'openai',
      source,
      reason: `Codex is using "${mode}" authentication, not a ChatGPT sign-in.`,
    };
  }

  return { status: 'found', auth: { vendor: 'openai', accessToken: token, source } };
}

export function findSubscription(vendor: SubscriptionVendor): SubscriptionLookup {
  return vendor === 'anthropic' ? findAnthropicSubscription() : findOpenAiSubscription();
}

/* ------------------------------------------------------------------ */
/* Token refresh                                                       */
/* ------------------------------------------------------------------ */

/**
 * OAuth client ids, read from the tokens themselves rather than hard-coded.
 *
 * A refresh must be presented with the same client the token was issued to.
 * Codex's `id_token` carries that in its `aud` claim, so we recover it from
 * the credentials instead of embedding a constant that would silently rot
 * when the CLI rotates its registration.
 */
function clientIdFromJwt(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const normalised = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
      aud?: string | string[];
    };
    const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    return typeof aud === 'string' && aud ? aud : null;
  } catch {
    return null;
  }
}

/** How close to expiry we refresh, so a long turn does not die mid-flight. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function needsRefresh(auth: SubscriptionAuth): boolean {
  if (auth.expiresAt === undefined) return false;
  return auth.expiresAt - REFRESH_MARGIN_MS <= Date.now();
}

/**
 * Exchange a refresh token for a new access token and persist it.
 *
 * Returns the refreshed auth, or null when refresh is not possible — the
 * caller then tells the user to re-run the CLI, which is always a valid
 * fallback and never leaves them stuck.
 *
 * Refresh happens against the vendor's own token endpoint using the client
 * id the token was issued to, exactly as the owning CLI would do it.
 */
/**
 * In-flight refreshes, one chain per vendor.
 *
 * Refresh tokens usually rotate: the server issues a new one and invalidates
 * the old. Two concurrent turns refreshing at once would race, and the loser
 * would persist a token the server has already retired — signing the user
 * out of their *CLI* as well as GhostBot. Serialising per vendor makes the
 * second caller wait and then re-read the freshly stored credential.
 */
const refreshChains = new Map<SubscriptionVendor, Promise<SubscriptionAuth | null>>();

export async function refreshSubscription(
  vendor: SubscriptionVendor,
): Promise<SubscriptionAuth | null> {
  const previous = refreshChains.get(vendor) ?? Promise.resolve(null);
  const run = previous
    .catch(() => null)
    .then(async () => {
      // A concurrent refresh may already have committed a valid token while
      // we waited; prefer it over spending another refresh.
      const existing = findSubscription(vendor);
      if (existing.status === 'found' && !needsRefresh(existing.auth)) return existing.auth;
      return vendor === 'anthropic' ? refreshAnthropic() : refreshOpenAi();
    });
  refreshChains.set(
    vendor,
    run.catch(() => null),
  );
  return run;
}

/**
 * The access token to use right now, refreshing first when it is near expiry.
 *
 * Returns null when no usable sign-in exists — the caller then falls back to
 * an API key, or tells the user to run the CLI once.
 */
export async function resolveSubscriptionToken(
  vendor: SubscriptionVendor,
): Promise<string | null> {
  const found = findSubscription(vendor);
  if (found.status === 'found' && !needsRefresh(found.auth)) return found.auth.accessToken;
  const refreshed = await refreshSubscription(vendor);
  return refreshed?.accessToken ?? null;
}

async function refreshAnthropic(): Promise<SubscriptionAuth | null> {
  const file = homeFile(...CLAUDE_CREDENTIALS);
  const json = readJsonSafe(file);
  const oauth = json?.claudeAiOauth as Record<string, unknown> | undefined;
  const refreshToken = typeof oauth?.refreshToken === 'string' ? oauth.refreshToken : '';
  if (!refreshToken) return null;

  // A refresh token has its own, longer expiry; once that passes only a
  // fresh sign-in helps.
  const refreshExpiry =
    typeof oauth?.refreshTokenExpiresAt === 'number' ? oauth.refreshTokenExpiresAt : undefined;
  if (refreshExpiry !== undefined && refreshExpiry <= Date.now()) return null;

  try {
    const res = await fetch(ANTHROPIC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: ANTHROPIC_CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) return null;

    const expiresAt = body.expires_in
      ? Date.now() + body.expires_in * 1000 - EXPIRY_SAFETY_MS
      : undefined;
    updateCredentialsFile(file, (current) => {
      const existing = (current.claudeAiOauth ?? {}) as Record<string, unknown>;
      return {
        ...current,
        claudeAiOauth: {
          ...existing,
          accessToken: body.access_token,
          ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        },
      };
    });

    const found = findAnthropicSubscription();
    return found.status === 'found' ? found.auth : null;
  } catch {
    return null;
  }
}

async function refreshOpenAi(): Promise<SubscriptionAuth | null> {
  const file = homeFile(...CODEX_CREDENTIALS);
  const json = readJsonSafe(file);
  const tokens = json?.tokens as Record<string, unknown> | undefined;
  const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : '';
  const idToken = typeof tokens?.id_token === 'string' ? tokens.id_token : '';
  if (!refreshToken) return null;

  const clientId = clientIdFromJwt(idToken);
  if (!clientId) return null;

  try {
    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
    };
    if (!body.access_token) return null;

    updateCredentialsFile(file, (current) => {
      const existing = (current.tokens ?? {}) as Record<string, unknown>;
      return {
        ...current,
        tokens: {
          ...existing,
          access_token: body.access_token,
          ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
          ...(body.id_token ? { id_token: body.id_token } : {}),
        },
        last_refresh: new Date().toISOString(),
      };
    });

    const found = findOpenAiSubscription();
    return found.status === 'found' ? found.auth : null;
  } catch {
    return null;
  }
}

/** Both vendors, for the settings screen. */
export function findAllSubscriptions(): SubscriptionLookup[] {
  return [findAnthropicSubscription(), findOpenAiSubscription()];
}

/**
 * A short, honest sentence for the UI.
 *
 * Never claims more than is known: "detected" rather than "connected",
 * because whether the vendor will honour the token is only knowable by
 * trying it.
 */
export function describeLookup(l: SubscriptionLookup): string {
  switch (l.status) {
    case 'found':
      return l.auth.plan
        ? `${l.auth.source} sign-in detected (${l.auth.plan} plan).`
        : `${l.auth.source} sign-in detected.`;
    case 'expired':
      return `${l.source} sign-in has expired — run it once to refresh.`;
    case 'not-signed-in':
      return `${l.source} is not signed in on this machine.`;
    case 'unavailable':
      return `${l.source}: ${l.reason}`;
  }
}

/**
 * The warning shown wherever this can be enabled.
 *
 * Deliberately blunt. A user who turns this on should understand that the
 * account they are risking is their own, and that GhostBot cannot protect
 * them from a vendor policy decision.
 */
export const SUBSCRIPTION_AUTH_WARNING =
  'Uses the sign-in from a CLI already installed on this machine, instead of an API key. ' +
  'Anthropic prohibits third-party tools from using Claude subscription tokens and may ' +
  'suspend accounts without warning; OpenAI does not document this use for third-party ' +
  'apps. These credential formats belong to other programs and can change at any time. ' +
  'An API key is the supported option.';
