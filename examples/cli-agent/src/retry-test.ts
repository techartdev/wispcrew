/**
 * retry-test.ts — guards rate-limit handling.
 *
 * Two properties matter and pull in opposite directions:
 *
 *  - **Recover from transient limits.** A free tier (NVIDIA's is ~40 requests
 *    per minute) rate-limits routinely, and a single 429 mid-turn would
 *    otherwise discard everything the agent had already done.
 *  - **Never retry a permanent failure.** Retrying a 401 or a malformed 400
 *    cannot succeed; it just turns a clear error into a mysterious delay.
 *
 * Run: npm run test:retry --workspace @wispcrew/examples-cli
 */
import {
  backoffDelay,
  isRetryableStatus,
  isTransientErrorMessage,
  parseRetryAfter,
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

function main(): void {
  console.log('\n[statuses] only transient failures are retried');
  {
    for (const status of [429, 500, 502, 503, 504]) {
      check(`${status} is retryable`, isRetryableStatus(status));
    }

    /*
     * 404 joined them, against the obvious reading.
     *
     * It normally means "no such thing", and this suite used to pin it as
     * permanent. Then NVIDIA's free tier was measured answering 404 when a
     * model is merely BUSY: four failures in six identical requests for
     * `nemotron-3-super-120b-a12b`, while `nemotron-3-nano-30b-a3b`
     * answered five of five. A conversation died mid-turn and told the user
     * to change a model that works.
     *
     * Retrying a genuinely missing model costs a few hundred milliseconds
     * before the same error. Not retrying cost a working feature.
     */
    check('404 is retryable, because it is not only "no such model"',
      isRetryableStatus(404));

    // The important half. A retried 401 wastes the user's time and never
    // succeeds; a retried 400 repeats the same malformed request.
    for (const status of [400, 401, 403, 413, 422]) {
      check(`${status} is NOT retryable`, !isRetryableStatus(status));
    }
  }

  console.log('\n[in-stream errors] capacity failures hidden inside a 200');
  {
    /*
     * Observed live on NVIDIA: under load the SSE stream carries
     *   {"error":{"message":"ResourceExhausted: Worker local total request
     *    limit reached (16/16)","type":"internal_server_error","code":500}}
     * with HTTP 200, so the status-based path never sees it.
     */
    check(
      'ResourceExhausted is transient',
      isTransientErrorMessage('ResourceExhausted: Worker local total request limit reached (16/16)'),
    );
    check('rate limit wording is transient', isTransientErrorMessage('Rate limit exceeded'));
    check('overloaded is transient', isTransientErrorMessage('Server overloaded, try again later'));
    check('capacity is transient', isTransientErrorMessage('insufficient capacity'));

    // Must stay narrow: a broad match would silently retry real errors.
    check('invalid key is NOT transient', !isTransientErrorMessage('Incorrect API key provided'));
    check(
      'unknown model is NOT transient',
      !isTransientErrorMessage('The model `x` does not exist'),
    );
    check(
      'context length is NOT transient',
      !isTransientErrorMessage("This model's maximum context length is 8192 tokens"),
    );
    check('empty message is NOT transient', !isTransientErrorMessage(''));
  }

  console.log('\n[retry-after] the server\'s own advice is understood');
  {
    eq('seconds are parsed', parseRetryAfter('30'), 30_000);
    eq('zero is respected', parseRetryAfter('0'), 0);
    eq('absent header yields nothing', parseRetryAfter(null), undefined);
    eq('nonsense yields nothing', parseRetryAfter('soon'), undefined);

    // HTTP-date form.
    const future = new Date(Date.now() + 60_000).toUTCString();
    const parsed = parseRetryAfter(future) ?? -1;
    check('http-date is parsed', parsed > 50_000 && parsed <= 61_000, `${parsed}`);
    // A date in the past must not produce a negative wait.
    const past = new Date(Date.now() - 60_000).toUTCString();
    eq('past date clamps to zero', parseRetryAfter(past), 0);
  }

  console.log('\n[backoff] grows, stays bounded, and is jittered');
  {
    const opts = { baseDelayMs: 1000, maxDelayMs: 20_000 };
    for (let attempt = 0; attempt < 8; attempt++) {
      const d = backoffDelay(attempt, opts);
      check(`attempt ${attempt} is non-negative`, d >= 0, `${d}`);
      check(`attempt ${attempt} respects the cap`, d <= 20_000, `${d}`);
    }

    // Full jitter: identical inputs must not produce identical delays, or
    // several agents hitting the same limit would retry in lockstep and
    // collide again at exactly the same moment.
    const sample = new Set(Array.from({ length: 40 }, () => backoffDelay(4, opts)));
    check('delays are jittered, not fixed', sample.size > 5, `${sample.size} distinct values`);

    // The ceiling should still grow with the attempt number: the largest of
    // many samples at a high attempt must exceed the largest at attempt 0.
    const low = Math.max(...Array.from({ length: 60 }, () => backoffDelay(0, opts)));
    const high = Math.max(...Array.from({ length: 60 }, () => backoffDelay(5, opts)));
    check('later attempts can wait longer', high > low, `${low} -> ${high}`);
  }

  console.log('');
  if (failures > 0) {
    console.error(`RETRY TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('RETRY TEST PASSED\n');
}

main();
