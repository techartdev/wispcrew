/**
 * oauth-refresh-test.ts — one expired token means ONE refresh, however many ask.
 *
 * This is the most important of the session-collision invariants, and until
 * now it had no behavioural test. Refresh tokens ROTATE: the server issues a
 * new one and retires the old. Two concurrent turns that both decide the
 * token is expired would each call the refresh endpoint, and the loser would
 * persist a token the server has already invalidated — silently signing the
 * user out of WispCrew AND (for a borrowed credential) out of their CLI.
 *
 * The store serialises refreshes per vendor: the second caller chains onto
 * the first's promise and then re-reads what the first stored, so the
 * endpoint is hit exactly once.
 *
 * Offline: `fetch` is stubbed to count refresh calls; no network, no real
 * credentials.
 */
import {
  createNodeCrypto,
  resolveToken,
  saveCredential,
  setHost,
} from '@wispcrew/runtime';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-oauth-refresh-'));
  setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });

  console.log('\n[single-flight] one expired token, many callers, one refresh');
  {
    let refreshCalls = 0;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('platform.claude.com/v1/oauth/token')) {
        refreshCalls++;
        // Rotate: a fresh token each call, which is exactly why two concurrent
        // calls would be fatal — the second would persist a retired token.
        return new Response(
          JSON.stringify({
            access_token: `fresh-${refreshCalls}`,
            refresh_token: `rt-${refreshCalls}`,
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      // Expired, so resolveToken must refresh.
      saveCredential(dir, 'anthropic', {
        type: 'oauth',
        access: 'stale-access',
        refresh: 'stale-refresh',
        expires: Date.now() - 1,
      });

      const [a, b] = await Promise.all([
        resolveToken(dir, 'anthropic'),
        resolveToken(dir, 'anthropic'),
      ]);

      check('both callers got a credential', a !== undefined && b !== undefined,
        `a=${JSON.stringify(a)}, b=${JSON.stringify(b)}`);
      check('exactly one refresh happened', refreshCalls === 1, `${refreshCalls} refresh(es)`);

      // Both must hold the SAME token — the one that one refresh produced.
      // If the loser re-refreshed and persisted, it would differ.
      check('and both hold the same token', a?.access === b?.access,
        `${a?.access} vs ${b?.access}`);

      // The fresh token is not the stale one the store started with.
      check('the token actually rotated', a?.access !== 'stale-access', a?.access);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log('\n[per vendor] a claude refresh never steps on a chatgpt refresh');
  {
    let claudeCalls = 0;
    let gptCalls = 0;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('platform.claude.com/v1/oauth/token')) {
        claudeCalls++;
        return new Response(
          JSON.stringify({ access_token: 'claude-fresh', refresh_token: 'claude-rt', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('auth.openai.com/oauth/token')) {
        gptCalls++;
        return new Response(
          JSON.stringify({ access_token: 'gpt-fresh', refresh_token: 'gpt-rt', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      saveCredential(dir, 'anthropic', {
        type: 'oauth', access: 'claude-stale', refresh: 'claude-stale-rt', expires: Date.now() - 1,
      });
      saveCredential(dir, 'chatgpt', {
        type: 'oauth', access: 'gpt-stale', refresh: 'gpt-stale-rt', expires: Date.now() - 1,
      });

      await Promise.all([
        resolveToken(dir, 'anthropic'),
        resolveToken(dir, 'chatgpt'),
      ]);

      check('each vendor refreshed once', claudeCalls === 1 && gptCalls === 1,
        `claude=${claudeCalls}, gpt=${gptCalls}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });

  console.log('');
  if (failures > 0) {
    console.error(`OAUTH-REFRESH TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('OAUTH-REFRESH TEST PASSED\n');
}

main();
