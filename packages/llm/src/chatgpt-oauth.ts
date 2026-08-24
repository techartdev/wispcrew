/**
 * chatgpt-oauth.ts — sign in to ChatGPT with a browser, no CLI required.
 *
 * Unlike the Claude flow, this one needs **no paste step**: OpenAI's client
 * accepts a loopback redirect, so GhostBot runs a one-shot local server, the
 * browser is redirected straight back to it, and the code never touches the
 * clipboard.
 *
 * ## Where these values come from
 *
 * Every parameter was established from a primary source, because none of
 * this is documented for third-party use:
 *
 *  - **Endpoints** — OpenAI's own OIDC discovery document at
 *    `auth.openai.com/.well-known/openid-configuration`, which advertises
 *    `authorization_endpoint`, `token_endpoint`, `S256` PKCE and the
 *    `authorization_code` + `refresh_token` grants.
 *  - **Client id** — read from the `client_id` claim inside a real Codex
 *    access token.
 *  - **Scopes and the two extra flags** (`id_token_add_organizations`,
 *    `codex_cli_simplified_flow`) — extracted as literal strings from the
 *    Codex binary.
 *  - **Loopback port 1455** — observed directly: launching `codex login`
 *    binds `127.0.0.1:1455`.
 *
 * Probing the authorize endpoint with a scripted request returns 403 for
 * every input, so the redirect could not be discovered that way; the binary
 * and the live process supplied it instead.
 *
 * ## Read this before enabling it
 *
 * OpenAI documents "Sign in with ChatGPT" for its own surfaces. Whether a
 * third-party app may bill inference against a user's subscription is not
 * documented, and the endpoint this token is used against is private and
 * unversioned. An API key remains the supported path; this is opt-in.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export const CHATGPT_OAUTH = {
  /** Codex's public client, from the `client_id` claim of a real token. */
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  /** From OpenAI's OIDC discovery document. */
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  /** Codex binds this port for the loopback redirect (observed live). */
  port: 1455,
  redirectPath: '/auth/callback',
  /** Exactly the scope string found in the Codex binary. */
  scopes: 'openid profile email offline_access',
} as const;

export function redirectUri(): string {
  return `http://localhost:${CHATGPT_OAUTH.port}${CHATGPT_OAUTH.redirectPath}`;
}

const TOKEN_TIMEOUT_MS = 30_000;
/** A refreshed token is treated as expiring early so a long turn cannot lapse mid-stream. */
const EXPIRY_SAFETY_MS = 5 * 60 * 1000;
/** How long the browser flow may stay open before we stop waiting. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface ChatGptCredential {
  type: 'oauth';
  access: string;
  refresh: string;
  /** Epoch ms, already reduced by the safety margin. */
  expires: number;
  /** Required by the subscription endpoint alongside the token. */
  accountId?: string;
  /** e.g. "plus", "pro" — display only. */
  plan?: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Pull the account id and plan out of a ChatGPT access token.
 *
 * The subscription endpoint requires `chatgpt-account-id`, and the token
 * itself is the authoritative source — reading it from the claims means a
 * token obtained by any route carries what it needs.
 */
export function claimsFromToken(jwt: string): { accountId?: string; plan?: string } {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return {};
    const normalised = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    return {
      accountId: typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined,
      plan: typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined,
    };
  } catch {
    return {};
  }
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: CHATGPT_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: CHATGPT_OAUTH.scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // Both flags appear in the Codex binary next to the scope string. The
    // first makes the id_token carry organization claims; the second selects
    // the simplified consent flow. Omitting them risks a consent screen the
    // client is not registered for.
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  return `${CHATGPT_OAUTH.authorizeUrl}?${params.toString()}`;
}

/** Exchange or refresh, with errors a user can act on. */
async function postToken(
  body: Record<string, string>,
  label: string,
): Promise<{ access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number }> {
  const res = await fetch(CHATGPT_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      if (parsed.error === 'invalid_grant') {
        detail = 'the authorization expired or was already used — start the sign-in again.';
      } else if (parsed.error_description ?? parsed.error) {
        detail = parsed.error_description ?? parsed.error!;
      }
    } catch {
      /* keep the excerpt */
    }
    throw new Error(`${label} failed (HTTP ${res.status}): ${detail}`);
  }
  try {
    return JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`${label} returned a response that was not JSON.`);
  }
}

function toCredential(data: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}, fallbackRefresh?: string): ChatGptCredential {
  if (!data.access_token) throw new Error('Sign-in returned no access token.');
  const refresh = data.refresh_token ?? fallbackRefresh;
  if (!refresh) throw new Error('Sign-in returned no refresh token.');
  const { accountId, plan } = claimsFromToken(data.access_token);
  return {
    type: 'oauth',
    access: data.access_token,
    refresh,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_SAFETY_MS,
    accountId,
    plan,
  };
}

export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
): Promise<ChatGptCredential> {
  const data = await postToken(
    {
      grant_type: 'authorization_code',
      client_id: CHATGPT_OAUTH.clientId,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    },
    'Sign-in',
  );
  return toCredential(data);
}

export async function refreshCredential(current: ChatGptCredential): Promise<ChatGptCredential> {
  const data = await postToken(
    {
      grant_type: 'refresh_token',
      client_id: CHATGPT_OAUTH.clientId,
      refresh_token: current.refresh,
      scope: CHATGPT_OAUTH.scopes,
    },
    'Token refresh',
  );
  // Refresh tokens rotate; keep the new one or the next refresh fails.
  return toCredential(data, current.refresh);
}

export function isExpired(credential: ChatGptCredential | undefined): boolean {
  if (!credential || typeof credential.access !== 'string') return true;
  return !Number.isFinite(credential.expires) || Date.now() >= credential.expires;
}

/** What a caller needs to drive the browser half of the flow. */
export interface PendingLogin {
  authorizeUrl: string;
  /** Resolves with the credential once the browser redirects back. */
  completed: Promise<ChatGptCredential>;
  /** Abandon the attempt and release the port. */
  cancel(): void;
}

/**
 * Start the loopback flow: bind the port, return the URL to open, and wait.
 *
 * The port is fixed at 1455 because that is what the client's redirect is
 * registered for — it cannot be chosen freely. If it is already in use
 * (usually `codex login` running in another window) that is reported
 * plainly, since the alternative is a silent hang.
 */
export async function startLogin(): Promise<PendingLogin> {
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(16));

  let server: Server | undefined;
  let settle: ((c: ChatGptCredential) => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    server?.close();
  };

  const completed = new Promise<ChatGptCredential>((resolve, reject) => {
    settle = (c) => {
      cleanup();
      resolve(c);
    };
    fail = (e) => {
      cleanup();
      reject(e);
    };
  });

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${CHATGPT_OAUTH.port}`);
    if (!url.pathname.startsWith(CHATGPT_OAUTH.redirectPath)) {
      res.writeHead(404).end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    const page = (title: string, body: string) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;background:#0f1115;color:#e6e9ef;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center"><h2>${title}</h2><p style="color:#98a1b0">${body}</p></div>`;

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Sign-in cancelled', 'You can close this tab.'));
      fail?.(new Error(`Sign-in was cancelled or denied (${error}).`));
      return;
    }
    // A mismatched state means the response does not belong to this attempt;
    // rejecting it is what makes the loopback redirect safe against another
    // page on the machine firing a forged callback.
    if (!code || returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Sign-in failed', 'The response did not match this request.'));
      fail?.(new Error('The sign-in response did not match this request.'));
      return;
    }

    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(page('Signed in to GhostBot', 'You can close this tab and return to the app.'));

    exchangeAuthorizationCode(code, verifier)
      .then((credential) => settle?.(credential))
      .catch((e: Error) => fail?.(e));
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', (e: NodeJS.ErrnoException) => {
      reject(
        e.code === 'EADDRINUSE'
          ? new Error(
              `Port ${CHATGPT_OAUTH.port} is already in use. Close any running \`codex login\` and try again.`,
            )
          : e,
      );
    });
    server!.listen(CHATGPT_OAUTH.port, '127.0.0.1', resolve);
  });

  timer = setTimeout(() => fail?.(new Error('Sign-in timed out. Try again.')), LOGIN_TIMEOUT_MS);

  return {
    authorizeUrl: buildAuthorizeUrl(challenge, state),
    completed,
    cancel: () => fail?.(new Error('Sign-in cancelled.')),
  };
}
