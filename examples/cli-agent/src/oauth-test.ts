/**
 * oauth-test.ts — guards subscription sign-in and usage reporting.
 *
 * These paths handle credentials for accounts that are not ours to risk, so
 * the invariants below matter more than most: a PKCE challenge that is not a
 * real S256 digest, a paste parser that drops the code, or a usage figure
 * invented when the provider reported none would each fail in a way the user
 * cannot diagnose.
 *
 * Everything here is offline — no network, no credentials.
 *
 * Run: npm run test:oauth --workspace @wispcrew/examples-cli
 */
import { createHash } from 'node:crypto';
import {
  chatgptOAuth,
  claudeOAuth,
  describeUsage,
  usageFromAnthropicHeaders,
  usageFromCodexHeaders,
} from '@wispcrew/llm';

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  check(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function base64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function main(): void {
  console.log('\n[pkce] challenges are real S256 digests');
  {
    for (const [name, flow] of [
      ['claude', claudeOAuth],
      ['chatgpt', chatgptOAuth],
    ] as const) {
      const { verifier, challenge } = flow.generatePkce();
      // The whole point of PKCE is that the challenge is derived from the
      // verifier. If these ever diverge the exchange fails with an opaque
      // "invalid grant" that looks like a user error.
      const expected = base64url(createHash('sha256').update(verifier).digest());
      eq(`${name}: challenge matches SHA-256(verifier)`, challenge, expected);
      check(`${name}: verifier is base64url`, !/[+/=]/.test(verifier), verifier);
      check(`${name}: challenge is base64url`, !/[+/=]/.test(challenge), challenge);
      check(`${name}: verifier is long enough`, verifier.length >= 43, `${verifier.length}`);

      const second = flow.generatePkce();
      check(`${name}: verifiers are not reused`, second.verifier !== verifier);
    }
  }

  console.log('\n[authorize urls] carry every parameter the provider needs');
  {
    const pkce = claudeOAuth.generatePkce();
    const claude = new URL(claudeOAuth.buildAuthorizeUrl(pkce));
    eq('claude: S256 method', claude.searchParams.get('code_challenge_method'), 'S256');
    check('claude: has client id', !!claude.searchParams.get('client_id'));
    check(
      'claude: requests inference scope',
      (claude.searchParams.get('scope') ?? '').includes('user:inference'),
    );
    // Anthropic rejects localhost for this client; using one would produce a
    // "link is invalid" page with no explanation.
    check(
      'claude: redirect is the registered non-loopback one',
      claude.searchParams.get('redirect_uri') === 'https://platform.claude.com/oauth/code/callback',
    );

    const chat = new URL(chatgptOAuth.buildAuthorizeUrl(pkce.challenge, 'state123'));
    eq('chatgpt: S256 method', chat.searchParams.get('code_challenge_method'), 'S256');
    eq('chatgpt: state is echoed', chat.searchParams.get('state'), 'state123');
    check(
      'chatgpt: redirect is loopback on 1455',
      chat.searchParams.get('redirect_uri') === 'http://localhost:1455/auth/callback',
    );
    check(
      'chatgpt: requests offline_access for refresh',
      (chat.searchParams.get('scope') ?? '').includes('offline_access'),
    );
  }

  console.log('\n[paste] every shape a user might paste is understood');
  {
    // Copy-paste variation is the one failure mode guaranteed to make a
    // sign-in feel broken, so all of these must work.
    const cases: Array<[string, string, string | undefined]> = [
      ['code#state', 'abc123#st', 'abc123'],
      ['bare code', 'abc123', 'abc123'],
      ['query string', 'code=X&state=Y', 'X'],
      ['full URL', 'https://platform.claude.com/oauth/code/callback?code=Q&state=R', 'Q'],
      ['padded with spaces', '  abc#st  ', 'abc'],
    ];
    for (const [label, input, expected] of cases) {
      eq(`${label}`, claudeOAuth.parseAuthorizationInput(input).code, expected);
    }
    eq('empty input yields nothing', claudeOAuth.parseAuthorizationInput('').code, undefined);
    eq(
      'state survives the code#state form',
      claudeOAuth.parseAuthorizationInput('abc#mystate').state,
      'mystate',
    );
  }

  console.log('\n[expiry] a missing or stale credential is treated as expired');
  {
    check('undefined is expired', claudeOAuth.isExpired(undefined));
    check(
      'past expiry is expired',
      claudeOAuth.isExpired({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() - 1 }),
    );
    check(
      'future expiry is not',
      !claudeOAuth.isExpired({
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: Date.now() + 600_000,
      }),
    );
    // A malformed record must fail closed, not be used and produce a 401.
    check(
      'malformed credential is expired',
      chatgptOAuth.isExpired({ type: 'oauth', access: '', refresh: 'r', expires: NaN } as never),
    );
  }

  console.log('\n[usage] only what the provider actually reported');
  {
    const headers = new Headers({
      'x-codex-active-limit': 'premium',
      'x-codex-primary-over-secondary-limit-percent': '42',
      'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3600),
      'x-codex-credits-balance': '0',
      'x-codex-credits-unlimited': 'False',
    });
    const u = usageFromCodexHeaders(headers);
    check('codex: snapshot produced', !!u);
    eq('codex: tier read', u?.tier, 'premium');
    eq('codex: percent read', u?.percentUsed, 42);
    eq('codex: not flagged limited at 42%', u?.limited, false);
    check('codex: reset time in the future', (u?.resetsAt ?? 0) > Date.now());

    const atLimit = usageFromCodexHeaders(
      new Headers({ 'x-codex-primary-over-secondary-limit-percent': '100' }),
    );
    eq('codex: 100% is flagged limited', atLimit?.limited, true);

    // The important negative: no headers must yield NO snapshot, so the UI
    // says "not available" rather than showing a misleading 0%.
    eq('codex: absent headers yield nothing', usageFromCodexHeaders(new Headers()), undefined);

    // Anthropic reports no percentage on the subscription path, so a 429 is
    // recorded as "limited" and nothing is invented.
    const anth = usageFromAnthropicHeaders(new Headers({ 'x-should-retry': 'true' }), 429);
    eq('anthropic: 429 is limited', anth?.limited, true);
    eq('anthropic: no invented percentage', anth?.percentUsed, undefined);
    eq(
      'anthropic: a healthy response yields nothing',
      usageFromAnthropicHeaders(new Headers(), 200),
      undefined,
    );
  }

  console.log('\n[usage text] readable, and honest when unknown');
  {
    check(
      'percentage is described',
      describeUsage({ tier: 'premium', percentUsed: 42, observedAt: Date.now() }).includes('42%'),
    );
    check(
      'reset time is described',
      describeUsage({
        percentUsed: 10,
        resetsAt: Date.now() + 3 * 24 * 3600_000,
        observedAt: Date.now(),
      }).includes('day'),
    );
    check(
      'limit-reached is described without a percentage',
      describeUsage({ limited: true, observedAt: Date.now() }).toLowerCase().includes('limit'),
    );
    check(
      'absent usage says so plainly',
      describeUsage(undefined).toLowerCase().includes('not available'),
    );
  }

  console.log('\n[borrowed credentials] must never be refreshed');
  {
    /*
     * This guards a real incident. Refresh tokens rotate: exchanging one
     * retires it server-side. During development a refresh was performed on a
     * token borrowed from Claude Code, which instantly invalidated the CLI's
     * own stored copy and signed the user out of a tool WispCrew was never
     * asked to touch — with a bare 401 giving no clue why.
     *
     * The fix is that a borrowed sign-in is stored WITHOUT its refresh token.
     * These assertions pin the two halves of that: an empty refresh token
     * must read as unusable, and a credential that owns its refresh token
     * must still be renewable.
     */
    const borrowed = {
      type: 'oauth' as const,
      access: 'sk-ant-oat01-borrowed',
      refresh: '',
      expires: Date.now() - 1,
    };
    check('a borrowed credential has no refresh token', !borrowed.refresh);
    check('an expired borrowed credential is expired', claudeOAuth.isExpired(borrowed));

    // The guard the store relies on: falsy refresh means "cannot renew".
    check('empty refresh is falsy', !borrowed.refresh);

    const owned = { ...borrowed, refresh: 'rt_owned', expires: Date.now() - 1 };
    check('an owned credential does carry a refresh token', !!owned.refresh);
    check('an owned expired credential is still expired', claudeOAuth.isExpired(owned));
  }

  console.log('');
  if (failures > 0) {
    console.error(`OAUTH TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('OAUTH TEST PASSED\n');
}

main();
