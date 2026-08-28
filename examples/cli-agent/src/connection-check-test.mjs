/**
 * connection-check-test.mjs — a check that says yes when the answer was no.
 *
 * `testConnection` reported "The provider answered" for a model that
 * returns 404 to every real request. The configuration passed its own
 * check and then failed every turn, which is worse than having no check:
 * it sends someone looking for the problem everywhere except where it is.
 *
 * The cause was the loop, not the request. `done` set ok and CLEARED the
 * error — and closing a stream with `done` after an error is the normal way
 * to end one, so the failure was erased a moment after being reported.
 *
 * Offline: the decision, replayed over chunk sequences.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** The rule under test, mirrored from `test-connection.ts`. */
const decide = (chunks) => {
  let sawDone = false;
  let failure = '';
  for (const c of chunks) {
    if (c.kind === 'done') sawDone = true;
    else if (c.kind === 'error') failure = c.message;
  }
  const ok = sawDone && failure === '';
  return { ok, error: failure || (sawDone ? '' : 'No response from the endpoint.') };
};

console.log('\n[the bug] an error followed by done is still a failure');
{
  /*
   * The exact sequence a 404 produces: the adapter reports the error, then
   * closes the stream. The old loop read the close as success.
   */
  const r = decide([
    { kind: 'error', message: 'NVIDIA NIM does not recognise the model "x".' },
    { kind: 'done' },
  ]);
  check('it does not report ok', r.ok === false);
  check('and keeps the reason', r.error.includes('does not recognise'), r.error);
}

console.log('\n[the good path] a clean stream still passes');
{
  const r = decide([{ kind: 'text', text: 'pong' }, { kind: 'done' }]);
  check('ok', r.ok === true);
  check('with no error text', r.error === '', r.error);
}

console.log('\n[other shapes]');
{
  // An error with no close at all.
  const errOnly = decide([{ kind: 'error', message: 'connect ECONNREFUSED' }]);
  check('an error alone fails', errOnly.ok === false);
  check('and reports itself', errOnly.error === 'connect ECONNREFUSED');

  // Nothing at all — a silent endpoint is not a working one.
  const nothing = decide([]);
  check('silence fails', nothing.ok === false);
  check('and says so', nothing.error === 'No response from the endpoint.');

  // Text but no close: the stream died mid-answer.
  const truncated = decide([{ kind: 'text', text: 'po' }]);
  check('a truncated stream fails', truncated.ok === false);

  // Two errors: the last one is the one to report.
  const twice = decide([
    { kind: 'error', message: 'first' },
    { kind: 'error', message: 'second' },
    { kind: 'done' },
  ]);
  check('the latest error is reported', twice.error === 'second', twice.error);
}

console.log('\n[implementation] the source still works this way');
{
  const source = fs.readFileSync(
    path.join(repo, 'packages/runtime/src/test-connection.ts'), 'utf8',
  );

  check('done no longer clears the error', !/kind === 'done'[\s\S]{0,60}error = ''/.test(source));
  check('ok requires both conditions', source.includes("const ok = sawDone && failure === ''"));
}

console.log('\n[presets] no model is offered that cannot answer');
{
  /*
   * `nvidia/nemotron-3.5-lightning-30b-a3b` is IN `/v1/models` and returns
   * 404 to a chat call. It was the default here, so every local turn failed
   * while the same key worked elsewhere. Being listed is not being servable.
   */
  const presets = fs.readFileSync(path.join(repo, 'packages/llm/src/presets.ts'), 'utf8');

  for (const dead of [
    'nvidia/nemotron-3.5-lightning-30b-a3b',
    'meta/llama-3.3-70b-instruct',
    'meta/llama-3.1-70b-instruct',
  ]) {
    check(`${dead} is not offered`, !presets.includes(`'${dead}'`));
  }

  check('the default is one that answered',
    presets.includes("defaultModel: 'nvidia/nemotron-3-super-120b-a12b'"));
}

console.log('');
if (failures) {
  console.error(`CONNECTION-CHECK TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CONNECTION-CHECK TEST PASSED\n');
