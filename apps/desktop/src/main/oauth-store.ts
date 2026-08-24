/**
 * oauth-store.ts — persist subscription sign-ins, encrypted, and keep them fresh.
 *
 * OAuth credentials are stored in the same encrypted secrets store as API
 * keys (`safeStorage`, backed by the OS keychain), under one entry per
 * vendor. They never reach the renderer: the UI sees a status summary, and
 * the token itself is resolved in the main process at request time.
 *
 * Two behaviours matter more than they look:
 *
 *  - **Refresh is single-flight per vendor.** Refresh tokens rotate — the
 *    server issues a new one and retires the old. Two turns refreshing
 *    concurrently would race, and the loser would persist a token the server
 *    has already invalidated, silently signing the user out. Serialising
 *    means the second caller waits and then re-reads what the first stored.
 *
 *  - **A failed refresh clears the credential.** Leaving a dead token in
 *    place produces a confusing loop where every turn fails with an auth
 *    error; clearing it makes the UI say "signed out", which is both true
 *    and actionable.
 */
import {
  chatgptOAuth,
  claudeOAuth,
  describeUsage,
  type ChatGptCredential,
  type OAuthCredential,
  type UsageSnapshot,
} from '@ghostbot/llm';
import { getSecret, upsertSecrets, removeSecrets } from './secrets-store.js';
import { fileLog } from './filelog.js';

export type OAuthVendor = 'anthropic' | 'chatgpt';

/** One secrets-store key per vendor. */
const SECRET_KEYS: Record<OAuthVendor, string> = {
  anthropic: 'GHOSTBOT_OAUTH_ANTHROPIC',
  chatgpt: 'GHOSTBOT_OAUTH_CHATGPT',
};

/** What the UI is allowed to see — never the tokens themselves. */
export interface OAuthStatus {
  vendor: OAuthVendor;
  signedIn: boolean;
  /** e.g. "max", "plus". */
  plan?: string;
  /** Epoch ms of the access token's expiry. */
  expiresAt?: number;
  /** Quota as of the last request, when the provider reported any. */
  usage?: UsageSnapshot & { summary: string };
}

/**
 * Last known quota per vendor.
 *
 * Held in memory rather than persisted: it is a point-in-time reading that
 * goes stale, and showing a figure from a previous session as if it were
 * current would be worse than showing nothing.
 */
const lastUsage = new Map<OAuthVendor, UsageSnapshot>();

export function recordUsage(vendor: OAuthVendor, usage: UsageSnapshot): void {
  lastUsage.set(vendor, usage);
}

type StoredCredential = OAuthCredential | ChatGptCredential;

function read(userDataDir: string, vendor: OAuthVendor): StoredCredential | undefined {
  const raw = getSecret(userDataDir, SECRET_KEYS[vendor]);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as StoredCredential;
    return parsed && typeof parsed.access === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function write(userDataDir: string, vendor: OAuthVendor, credential: StoredCredential): void {
  upsertSecrets(userDataDir, [{ key: SECRET_KEYS[vendor], value: JSON.stringify(credential) }]);
}

export function signOut(userDataDir: string, vendor: OAuthVendor): void {
  removeSecrets(userDataDir, [SECRET_KEYS[vendor]]);
  fileLog('[oauth] signed out', vendor);
}

export function saveCredential(
  userDataDir: string,
  vendor: OAuthVendor,
  credential: StoredCredential,
): void {
  write(userDataDir, vendor, credential);
  fileLog('[oauth] signed in', vendor);
}

/** Status for the settings screen. */
export function status(userDataDir: string, vendor: OAuthVendor): OAuthStatus {
  const credential = read(userDataDir, vendor);
  if (!credential) return { vendor, signedIn: false };
  const usage = lastUsage.get(vendor);
  return {
    vendor,
    signedIn: true,
    plan: (credential as ChatGptCredential).plan,
    expiresAt: credential.expires,
    ...(usage ? { usage: { ...usage, summary: describeUsage(usage) } } : {}),
  };
}

export function allStatuses(userDataDir: string): OAuthStatus[] {
  return [status(userDataDir, 'anthropic'), status(userDataDir, 'chatgpt')];
}

/** In-flight refreshes, one chain per vendor (see the note at the top). */
const refreshChains = new Map<OAuthVendor, Promise<StoredCredential | undefined>>();

async function refreshNow(
  userDataDir: string,
  vendor: OAuthVendor,
  current: StoredCredential,
): Promise<StoredCredential | undefined> {
  try {
    const refreshed =
      vendor === 'anthropic'
        ? await claudeOAuth.refreshCredential(current as OAuthCredential)
        : await chatgptOAuth.refreshCredential(current as ChatGptCredential);
    write(userDataDir, vendor, refreshed);
    return refreshed;
  } catch (err) {
    // The refresh token is spent or revoked; a fresh sign-in is the only fix.
    fileLog('[oauth] refresh failed', vendor, (err as Error).message);
    signOut(userDataDir, vendor);
    return undefined;
  }
}

/**
 * The access token to use right now, refreshing first when it is near expiry.
 *
 * Returns undefined when there is no usable sign-in, which callers surface as
 * "sign in again" rather than a raw auth error.
 */
export async function resolveToken(
  userDataDir: string,
  vendor: OAuthVendor,
): Promise<StoredCredential | undefined> {
  const current = read(userDataDir, vendor);
  if (!current) return undefined;

  const expired =
    vendor === 'anthropic'
      ? claudeOAuth.isExpired(current as OAuthCredential)
      : chatgptOAuth.isExpired(current as ChatGptCredential);
  if (!expired) return current;

  /*
   * A borrowed CLI sign-in is stored without a refresh token on purpose (see
   * `oauthImportFromCli`): refreshing it would rotate the token and sign the
   * user out of their CLI. So an expired one is simply cleared, not renewed —
   * skipping a network call that could only fail, and leaving the UI honest
   * about no longer being signed in.
   */
  if (!current.refresh) {
    fileLog('[oauth] borrowed credential expired, clearing', vendor);
    signOut(userDataDir, vendor);
    return undefined;
  }

  const previous = refreshChains.get(vendor) ?? Promise.resolve(undefined);
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      // A concurrent refresh may already have stored a valid token while we
      // queued; prefer it rather than spending another refresh.
      const latest = read(userDataDir, vendor);
      if (!latest) return undefined;
      const stillExpired =
        vendor === 'anthropic'
          ? claudeOAuth.isExpired(latest as OAuthCredential)
          : chatgptOAuth.isExpired(latest as ChatGptCredential);
      return stillExpired ? refreshNow(userDataDir, vendor, latest) : latest;
    });

  refreshChains.set(
    vendor,
    run.catch(() => undefined),
  );
  return run;
}
