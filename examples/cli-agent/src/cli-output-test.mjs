/**
 * cli-output-test.mjs — the contract a program depends on.
 *
 * A CLI serving both people and programs has one failure mode that matters:
 * decorating machine output. `✨ Thinking...` on stdout, a spinner, or a
 * heading above JSON turns a parseable result into a scraping problem, and
 * the caller only discovers it in production.
 *
 * So this pins the contract rather than the prose: in `--json` mode, stdout
 * is exactly one object and nothing else.
 *
 * Offline: pure formatting, no daemon.
 */
import { emit, emitEvent, fail, outputOptions, table } from '@wispcrew/daemon/cli-output';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Capture stdout for one call. */
const capture = (fn) => {
  const written = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  const log = console.log;
  console.log = (...args) => written.push(`${args.join(' ')}\n`);
  try {
    fn();
  } finally {
    process.stdout.write = original;
    console.log = log;
  }
  return written.join('');
};

console.log('\n[flags] the modes a caller can ask for');
{
  check('text by default', outputOptions({}).mode === 'text');
  check('--json', outputOptions({ json: true }).mode === 'json');
  // Both spellings must mean the same thing: `--json` is what people type.
  check('--output json is the same', outputOptions({ output: 'json' }).mode === 'json');
  check('--output ndjson', outputOptions({ output: 'ndjson' }).mode === 'ndjson');
  check('--quiet', outputOptions({ quiet: true }).quiet === true);

  /*
   * A prompt in a script is a hang: nothing is watching, so the caller waits
   * for a timeout instead of receiving an error it could handle.
   */
  check('json is never interactive', outputOptions({ json: true }).interactive === false);
  check('--no-interactive is honoured', outputOptions({ 'no-interactive': true }).interactive === false);
}

console.log('\n[json] stdout is exactly one object');
{
  const out = capture(() =>
    emit(
      { value: { ok: true, agents: 3 }, lines: ['Agents: 3', 'Everything is fine!'] },
      outputOptions({ json: true }),
    ),
  );

  check('one line', out.trim().split('\n').length === 1, JSON.stringify(out));
  check('it parses', (() => { try { JSON.parse(out); return true; } catch { return false; } })());
  // The human lines must not leak into machine output — that is the bug this
  // whole module exists to prevent.
  check('no prose', !out.includes('Everything is fine'), out);
  check('the value survives', JSON.parse(out).agents === 3);
}

console.log('\n[ndjson] a list becomes one object per line');
{
  const out = capture(() =>
    emit({ value: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, outputOptions({ output: 'ndjson' })),
  );

  const lines = out.trim().split('\n');
  check('three lines', lines.length === 3, String(lines.length));
  check('each parses', lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  check('in order', JSON.parse(lines[0]).id === 'a' && JSON.parse(lines[2]).id === 'c');

  // A single value is still one line, not a one-element array.
  const single = capture(() => emit({ value: { id: 'z' } }, outputOptions({ output: 'ndjson' })));
  check('a scalar result is one line', single.trim().split('\n').length === 1);
}

console.log('\n[text] a person gets the readable version');
{
  const out = capture(() =>
    emit({ value: { agents: 3 }, lines: ['Agents: 3'] }, outputOptions({})),
  );
  check('the lines are printed', out.includes('Agents: 3'));
  check('and not the JSON', !out.includes('{"agents"'), out);
}

console.log('\n[quiet] suppresses the readable version only');
{
  const text = capture(() => emit({ value: { a: 1 }, lines: ['noise'] }, outputOptions({ quiet: true })));
  check('nothing in text mode', text.trim() === '', JSON.stringify(text));

  /*
   * But --quiet --json still prints the object: quiet suppresses commentary,
   * not the result. A caller combining them expects the answer.
   */
  const json = capture(() =>
    emit({ value: { a: 1 }, lines: ['noise'] }, outputOptions({ quiet: true, json: true })),
  );
  check('the result survives in json mode', JSON.parse(json).a === 1);
}

console.log('\n[events] streaming only happens in ndjson');
{
  const streamed = capture(() =>
    emitEvent({ type: 'turn.started', turnId: 't1' }, outputOptions({ output: 'ndjson' })),
  );
  check('an event is written', JSON.parse(streamed).type === 'turn.started');

  // In text mode an event would interleave with prose and corrupt both.
  const quiet = capture(() => emitEvent({ type: 'turn.started' }, outputOptions({})));
  check('and stays out of text mode', quiet.trim() === '', JSON.stringify(quiet));
}

console.log('\n[tables] columns come from the content');
{
  const rows = table(
    [['windows', 'idle'], ['a-much-longer-name', 'working']],
    ['NAME', 'STATE'],
  );
  check('a header row', rows[0].startsWith('NAME'));
  check('aligned', rows[1].indexOf('idle') === rows[2].indexOf('working'),
    `${rows[1].indexOf('idle')} vs ${rows[2].indexOf('working')}`);
  // Trailing spaces would show up in a diff and annoy anyone grepping.
  check('no trailing whitespace', rows.every((r) => r === r.trimEnd()));
}

console.log('');
if (failures) {
  console.error(`CLI-OUTPUT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CLI-OUTPUT TEST PASSED\n');
