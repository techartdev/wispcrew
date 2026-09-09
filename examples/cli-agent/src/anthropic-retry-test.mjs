/**
 * anthropic-retry-test — a transient Anthropic failure must not kill a turn.
 *
 * Two faults, found when a turn died mid-sentence with the single word
 * "Overloaded" while doing nothing unusual:
 *
 *  1. `RETRYABLE` in retry.ts listed 404, 429, 500, 502, 503, 504 — which
 *     reads like a complete set, and is not. Anthropic's overload status is
 *     **529**, not an IANA-registered code, so it fell straight through to
 *     "fail immediately".
 *
 *  2. The Anthropic adapter never retried ANYTHING. retry.ts existed, the
 *     OpenAI-compatible adapter used it, and this one called bare `fetch`.
 *     So even a 503 or a 429-with-`x-should-retry` ended the turn.
 *
 * Both are asserted here: the status table by behaviour, the wiring by
 * source, because a unit test of `isRetryableStatus` passes happily while
 * the adapter that ignores it stays broken. That exact combination has
 * already shipped in this repo once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRetryableStatus, backoffDelay, parseRetryAfter } from '@wispcrew/llm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

console.log('[1] 529 Overloaded is transient');
{
  check('529 is retryable', isRetryableStatus(529));

  /* The neighbours, so a blanket "retry everything" cannot pass this. */
  check('503 still retryable', isRetryableStatus(503));
  check('429 still retryable', isRetryableStatus(429));
  check('401 is not', !isRetryableStatus(401), 'a bad key never recovers');
  check('400 is not', !isRetryableStatus(400), 'a malformed request never recovers');
  check('403 is not', !isRetryableStatus(403));
}

console.log('\n[2] the Anthropic adapter actually retries');
{
  const src = fs.readFileSync(path.join(root, 'packages/llm/src/anthropic.ts'), 'utf8');

  check('it imports fetchWithRetry', /import \{[^}]*fetchWithRetry/.test(src));
  check('and uses it for the messages call', /await fetchWithRetry\(/.test(src));

  /*
   * No bare `fetch(` left on the request path. Written as a count rather
   * than a boolean so a second call site added later trips it.
   */
  const bare = (src.match(/await fetch\(/g) ?? []).length;
  check('no bare fetch remains', bare === 0, `${bare} bare call(s)`);

  check('a pause can be reported', /onRetry/.test(src), 'a silent retry looks like a hang');
}

console.log('\n[3] backoff is bounded and jittered');
{
  /*
   * Jitter is not cosmetic here: several agents in a room hit the same
   * limit in the same second, and a fixed schedule makes them collide again
   * on every attempt.
   */
  const spread = new Set(Array.from({ length: 40 }, () => backoffDelay(3)));
  check('successive delays differ', spread.size > 5, `${spread.size} distinct values`);

  const capped = Array.from({ length: 40 }, () => backoffDelay(12, { maxDelayMs: 20_000 }));
  check('and never exceed the cap', Math.max(...capped) <= 20_000, `max ${Math.max(...capped)}ms`);
  check('never negative', Math.min(...capped) >= 0);
}

console.log('\n[4] Retry-After is honoured in both forms');
{
  check('seconds', parseRetryAfter('30') === 30_000);
  const soon = new Date(Date.now() + 5_000).toUTCString();
  const parsed = parseRetryAfter(soon);
  check('an HTTP date', parsed !== undefined && parsed <= 5_000 && parsed > 0, String(parsed));
  check('absent', parseRetryAfter(null) === undefined);
  check('nonsense is ignored', parseRetryAfter('later') === undefined);
}

console.log('');
if (failures) {
  console.log(`ANTHROPIC-RETRY TEST FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('ANTHROPIC-RETRY TEST PASSED');
