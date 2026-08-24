/**
 * errors-test.ts — guards the user-facing provider error messages.
 *
 * GhostBot's premise is "bring your own provider", which makes
 * misconfiguration the *expected* first-run state rather than an edge case.
 * These messages are therefore part of the product, and they have two jobs:
 * say what went wrong, and say what to change. A raw `fetch failed` does
 * neither.
 *
 * Run: npm run test:errors --workspace @ghostbot/examples-cli
 */
import { describeHttpFailure, describeProviderError } from '@ghostbot/llm';

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

const ctx = { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna' };
const localCtx = { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' };

/** A message is only useful if it names the fix, not just the symptom. */
function isActionable(msg: string): boolean {
  return /settings|check|start|try|wait|pick|remove|billing/i.test(msg);
}

function main(): void {
  console.log('\n[http] status codes map to the right advice');
  {
    const key = describeHttpFailure(401, '{"error":{"message":"Incorrect API key"}}', 'OpenAI', 'm');
    check('401 mentions the API key', /api key/i.test(key));
    check('401 points at Settings', /settings/i.test(key));
    check('401 keeps the provider detail', key.includes('Incorrect API key'));

    const model = describeHttpFailure(404, '{"error":{"message":"no model"}}', 'OpenAI', 'ghost-9');
    check('404 names the model', model.includes('ghost-9'));
    check('404 suggests changing it', /pick a different model/i.test(model));

    const rate = describeHttpFailure(429, '', 'Groq', 'm');
    check('429 explains rate limiting', /rate-limit|quota/i.test(rate));
    check('429 names the provider', rate.includes('Groq'));

    const server = describeHttpFailure(503, '', 'Anthropic', 'm');
    check('503 blames the provider, not the user', /their side/i.test(server));

    const big = describeHttpFailure(413, '', 'OpenAI', 'm');
    check('413 suggests removing attachments', /attachment/i.test(big));

    // Unknown statuses must still produce something, not "undefined".
    const odd = describeHttpFailure(418, 'teapot', 'Custom', 'm');
    check('unknown status still explains', odd.includes('418'));
    check('unknown status keeps the body', odd.includes('teapot'));
  }

  console.log('\n[http] every mapped status is actionable');
  {
    for (const status of [401, 403, 404, 429, 400, 413, 500, 502, 503, 504]) {
      const msg = describeHttpFailure(status, '', 'OpenAI', 'm');
      check(`${status} is actionable`, isActionable(msg), msg);
      check(`${status} has no raw JSON`, !msg.includes('{"'), msg);
    }
  }

  console.log('\n[network] connection failures explain themselves');
  {
    const refused = describeProviderError(new Error('fetch failed'), localCtx) ?? '';
    check('local refusal names the URL', refused.includes('localhost:11434'));
    check('local refusal suggests starting the server', /ollama serve|local server/i.test(refused));
    check('no bare "fetch failed"', refused !== 'fetch failed');

    const remote = describeProviderError(new Error('fetch failed'), ctx) ?? '';
    check('remote refusal mentions Base URL', /base url/i.test(remote));
    check('remote refusal does not suggest ollama serve', !/ollama serve/i.test(remote));

    const dns = describeProviderError(new Error('getaddrinfo ENOTFOUND nope.invalid'), ctx) ?? '';
    check('DNS failure suggests a typo', /typo|resolved/i.test(dns));

    const tls = describeProviderError(new Error('self-signed certificate in chain'), ctx) ?? '';
    check('TLS failure mentions certificates', /certificate/i.test(tls));

    const timeout = describeProviderError(new Error('ETIMEDOUT'), ctx) ?? '';
    check('timeout says so', /did not respond|time/i.test(timeout));
  }

  console.log('\n[abort] a user pressing Stop is not an error');
  {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    eq('AbortError yields null', describeProviderError(abort, ctx), null);
  }

  console.log('\n[embedded] HTTP details are recovered from a thrown message');
  {
    // Adapters throw with the status and body embedded; the friendly form has
    // to be recoverable from that string alone.
    const thrown = new Error(
      'OpenAI Responses API returned HTTP 401: {"error":{"message":"Incorrect API key provided"}}',
    );
    const msg = describeProviderError(thrown, ctx) ?? '';
    check('recovers the 401 advice', /api key/i.test(msg));
    check('does not echo the raw prefix', !msg.includes('Responses API returned'));
  }

  console.log('\n[fallback] unrecognised errors survive intact');
  {
    const msg = describeProviderError(new Error('something unusual happened'), ctx);
    eq('passes the message through', msg, 'something unusual happened');
    eq('non-Error input is stringified', describeProviderError('oops', ctx), 'oops');
  }

  console.log('');
  if (failures > 0) {
    console.error(`ERRORS TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('ERRORS TEST PASSED\n');
}

main();
