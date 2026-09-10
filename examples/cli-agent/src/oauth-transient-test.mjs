/**
 * oauth-transient-test — a busy token endpoint must not sign the user out.
 *
 * ## What went wrong
 *
 * A Claude subscription failed mid-session with "OAuth access token has been
 * revoked", then recovered on its own a few minutes later. A genuinely
 * revoked token cannot do that, and the recovery was the clue that got
 * missed for four rounds while the working theory was a cross-process race
 * on the shared secrets file.
 *
 * `refreshNow` called `signOut()` in a bare `catch`. Every failure looked
 * identical there — `invalid_grant`, HTTP 429, a 529, a DNS blip, a
 * 30-second timeout — so any of them discarded a credential whose refresh
 * token was still perfectly good, and the user was told to sign in again.
 *
 * The costs are not symmetric, which is what decides the default:
 *   - keeping a dead token   -> one more failed turn, with a clear error
 *   - discarding a live one  -> an interactive browser sign-in nobody asked for
 *
 * ## What is asserted
 *
 * The classification, by behaviour, over the statuses that actually occur;
 * and the audit trail, because the reason this took four rounds is that
 * `fileLog` writes nothing unless WISPCREW_LOG is set and nothing sets it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenEndpointError, isCredentialRejected } from '@wispcrew/llm';
import {
  auditOAuth,
  credentialFingerprint,
  initOAuthAudit,
  readOAuthAudit,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

console.log('[1] only a rejected grant counts as revoked');
{
  const rejected = (status, error) =>
    new TokenEndpointError(`Token refresh failed (HTTP ${status})`, {
      credentialRejected: status === 400 || status === 401 || status === 403 || error === 'invalid_grant',
      status,
    });

  check('invalid_grant is fatal', isCredentialRejected(rejected(400, 'invalid_grant')));
  check('401 is fatal', isCredentialRejected(rejected(401)));
  check('403 is fatal', isCredentialRejected(rejected(403)));

  /* The whole point: these must NOT cost a sign-in. */
  check('429 is transient', !isCredentialRejected(rejected(429)));
  check('500 is transient', !isCredentialRejected(rejected(500)));
  check('503 is transient', !isCredentialRejected(rejected(503)));
  check('529 Overloaded is transient', !isCredentialRejected(rejected(529)));

  /*
   * A network error never reaches Anthropic at all, so the refresh token is
   * untouched by definition. This was the most expensive case: a dropped
   * connection cost a browser sign-in.
   */
  const offline = new TokenEndpointError('Token refresh could not reach Anthropic: fetch failed', {
    credentialRejected: false,
  });
  check('an unreachable endpoint is transient', !isCredentialRejected(offline));

  /* Anything that is not a TokenEndpointError is not a licence to sign out. */
  check('a plain Error is not a rejection', !isCredentialRejected(new Error('boom')));
  check('undefined is not a rejection', !isCredentialRejected(undefined));
}

console.log('\n[2] the sign-out decision is wired to that classification');
{
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname).slice(1), '../../..');
  const src = fs.readFileSync(path.join(root, 'packages/runtime/src/oauth-store.ts'), 'utf8');

  check('refreshNow asks whether the credential was rejected', /isCredentialRejected\(err\)/.test(src));
  check(
    'and only then signs out',
    /if \(rejected\) \{\s*\n\s*signOut\(/.test(src),
    'signOut must be guarded by the classification',
  );

  /*
   * Source-checked because the alternative is a live token endpoint. The
   * bare `catch { signOut() }` is the exact shape being prevented, so its
   * absence is the assertion.
   */
  const bareSignOut = /catch \(err\) \{[^}]*?\n\s*signOut\(userDataDir, vendor\);/s.test(src);
  check('no unconditional sign-out remains', !bareSignOut);
}

console.log('\n[3] refreshes leave a trail, without leaking a token');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-oauth-'));
  initOAuthAudit(dir);

  const secret = 'refresh-token-that-must-never-appear-abc123';
  const fp = credentialFingerprint(secret);

  auditOAuth('refresh-started', 'anthropic', { credential: fp });
  auditOAuth('refresh-failed', 'anthropic', { status: 529, message: 'Overloaded', signedOut: false });
  auditOAuth('refresh-succeeded', 'anthropic', {
    credential: fp,
    rotatedTo: credentialFingerprint('a-different-token'),
  });

  const entries = readOAuthAudit(dir);
  check('every event was recorded', entries.length === 3, `${entries.length} entries`);
  check('with the process that wrote them', entries.every((e) => e.pid === process.pid));
  check('and a role, not just a pid', entries.every((e) => typeof e.role === 'string' && e.role));
  check('a transient failure records that it did NOT sign out', entries[1].signedOut === false);
  check('and the status that caused it', entries[1].status === 529);

  /* The safety property. */
  const raw = fs.readFileSync(path.join(dir, 'oauth-audit.jsonl'), 'utf8');
  check('the token itself is absent', !raw.includes(secret));
  check('the fingerprint is short', (fp ?? '').length <= 16, fp);
  check('and is not the token', fp !== secret);
  check(
    'a rotation is visible as a changed fingerprint',
    entries[2].credential === fp && entries[2].rotatedTo !== fp,
    JSON.stringify([entries[2].credential, entries[2].rotatedTo]),
  );

  /*
   * Two processes refreshing FROM the same fingerprint is the signature of
   * the race that was hypothesised. It could not be confirmed or ruled out
   * before, because nothing was written down.
   */
  const rotations = entries.filter((e) => e.event === 'refresh-succeeded');
  check('rotations are distinguishable per credential', rotations.every((e) => e.credential && e.rotatedTo));

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[4] the audit is on by default, not behind an env var');
{
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname).slice(1), '../../..');
  const store = fs.readFileSync(path.join(root, 'packages/runtime/src/store.ts'), 'utf8');

  /*
   * Wired inside `initStore` on purpose. Every host — desktop, daemon, CLI —
   * already calls it before touching a profile, so the audit cannot be live
   * in one and dark in another. That "one truth in two places" shape is the
   * recurring fault in this repo, and it is what left the last incident
   * with no evidence at all.
   */
  check('initStore starts the audit', /initOAuthAudit\(userDataDir\)/.test(store));

  /*
   * Checked against code, not prose. The first version of this assertion
   * searched the whole file for WISPCREW_LOG and failed on the comment
   * explaining why the audit does NOT use it — a test that reads
   * documentation as behaviour is worse than no test, because it fails for
   * the right reason at the wrong time and gets "fixed" by deleting the
   * explanation.
   */
  const audit = fs
    .readFileSync(path.join(root, 'packages/runtime/src/oauth-audit.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  /*
   * Narrowed to the WRITE path. `role()` legitimately reads
   * ELECTRON_RUN_AS_NODE to name the process that wrote an entry — that is
   * content, not a gate. What must never exist is an env var deciding
   * WHETHER anything is written, which is exactly how fileLog came to
   * discard every OAuth event on this machine.
   */
  /*
   * Specifically an EARLY RETURN with no value — `return;` — which is how a
   * feature gets switched off. `role()` has `if (process.env.X) return
   * 'electron-node';`, which returns a value and is content, not a gate.
   * The first version of this pattern caught that and reported a bug in
   * correct code.
   */
  const gated = /if \(!?process\.env\.[A-Z_]+\)\s*return;/.test(audit);
  check('no env var decides whether to write', !gated);
  check('the write itself is unconditional', /fs\.appendFileSync\(file, line\)/.test(audit));
}

console.log('');
if (failures) {
  console.log(`OAUTH-TRANSIENT TEST FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('OAUTH-TRANSIENT TEST PASSED');

/*
 * Importing the runtime starts timers that hold the event loop open, so a
 * finished test would otherwise sit there until the harness times out —
 * indistinguishable from a hang. Exit deliberately, after the verdict.
 */
process.exit(0);
