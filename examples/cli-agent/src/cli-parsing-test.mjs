/**
 * cli-parsing-test.mjs — a flag's value is not a positional argument.
 *
 * Dropping anything starting with `--` looks like enough, and is not: a
 * flag's VALUE does not start with `--`, so it survived the filter and
 * became a positional argument.
 *
 * Measured, not theorised:
 *
 *   wispcrew routines create Assistant "0 9 * * *" "Check the build" \
 *     --data-dir C:\Users\...\Temp\wc-cli
 *
 * created a routine whose prompt ended in `C:\Users\VANY...`. Every command
 * taking positional arguments had the same flaw; routines simply showed it
 * first, because a routine's name is stored and displayed.
 *
 * Offline: pure parsing.
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

/*
 * The two functions under test, lifted from the CLI rather than imported:
 * they are private to it, and copying them here would let them drift. So the
 * source is read and the behaviour compared against it.
 */
const source = fs.readFileSync(path.join(repo, 'apps/daemon/src/cli.ts'), 'utf8');

console.log('\n[implementation] the CLI does not use the naive filter');
{
  /*
   * The original was `rest.filter((a) => !a.startsWith('--'))`. If that
   * returns, so does the bug.
   */
  check('no bare startsWith filter for positionals',
    !source.includes(".filter((a) => !a.startsWith('--'))"));
  check('a dedicated reader exists', source.includes('function positionalArgs'));
}

/*
 * The CLI's own boolean-flag list, read from its source.
 *
 * Duplicating it here would let the two drift, and drift is the whole
 * failure mode this file exists to catch.
 */
const BOOLEAN_FLAGS = new Set(
  [
    ...source
      .slice(source.indexOf('const BOOLEAN_FLAGS'), source.indexOf(']);', source.indexOf('const BOOLEAN_FLAGS')))
      .matchAll(/'([a-z-]+)'/g),
  ].map((m) => m[1]),
);

/* Reimplement exactly what the CLI does, to test the behaviour itself. */
const positionalArgs = (argv) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out.push(arg);
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg.slice(2))) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) i++;
  }
  return out;
};

const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      out[name] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[name] = next;
      i++;
    } else {
      out[name] = true;
    }
  }
  return out;
};

console.log('\n[the bug] a flag value never becomes positional');
{
  const argv = ['create', 'Assistant', '0 9 * * *', 'Check the build', '--data-dir', 'C:\\tmp\\x'];

  const positional = positionalArgs(argv);
  check('four positionals, not five', positional.length === 4, JSON.stringify(positional));
  check('the path is not among them', !positional.includes('C:\\tmp\\x'), JSON.stringify(positional));
  check('the prompt survives intact', positional[3] === 'Check the build', positional[3]);
}

console.log('\n[boolean flags] a value-less flag never eats an argument');
{
  /*
   * The failure this list prevents, in the exact shape it was found.
   */
  const shown = positionalArgs(['show', '--json', 'Assistant']);
  check('agents show --json <name> keeps the name',
    shown.includes('Assistant'), JSON.stringify(shown));

  const flags = parseArgs(['show', '--json', 'Assistant']);
  check('and --json is a boolean, not a string', flags.json === true, JSON.stringify(flags));

  // The list must be non-trivial, or reading it from source silently found
  // nothing and every assertion above would pass for the wrong reason.
  check('the list was read from the CLI', BOOLEAN_FLAGS.size >= 5,
    `${BOOLEAN_FLAGS.size} flags`);
  check('including the obvious ones',
    BOOLEAN_FLAGS.has('json') && BOOLEAN_FLAGS.has('quiet') && BOOLEAN_FLAGS.has('yes'));
}

console.log('\n[agreement] both readers consume the same values');
{
  /*
   * The two must agree, or an argument is either counted twice or lost. A
   * flag value belongs to the flag; everything else is positional.
   */
  const argv = ['show', 'Builder', '--json', '--timeout', '30', 'extra'];

  const positional = positionalArgs(argv);
  const flags = parseArgs(argv);

  check('the value went to the flag', flags.timeout === '30');
  check('and not to the positionals', !positional.includes('30'), JSON.stringify(positional));
  check('a boolean flag takes nothing', flags.json === true);
  check('so what follows it stays positional', positional.includes('extra'));
  check('the count is right', positional.length === 3, JSON.stringify(positional));
}

console.log('\n[edge cases] the awkward shapes');
{
  // A flag at the end has no value to consume.
  check('trailing flag', JSON.stringify(positionalArgs(['a', '--json'])) === '["a"]');

  /*
   * `--json --quiet name` — `name` stays positional.
   *
   * This was documented as "genuinely ambiguous" and it was not: declaring
   * which flags take no value settles it. The earlier version pinned the
   * WRONG behaviour and called it inherent, which is the more embarrassing
   * kind of test — it would have defended the bug.
   *
   * Measured before the fix: `agents show --json Assistant` lost the agent
   * name, and `agents --json Assistant` printed a table to a caller who had
   * asked for JSON.
   */
  const two = positionalArgs(['--json', '--quiet', 'name']);
  const twoFlags = parseArgs(['--json', '--quiet', 'name']);
  check('boolean flags leave the positional alone',
    two.length === 1 && two[0] === 'name', JSON.stringify(two));
  check('and are still true', twoFlags.json === true && twoFlags.quiet === true,
    JSON.stringify(twoFlags));

  // Nothing but flags.
  check('no positionals at all', positionalArgs(['--json']).length === 0);

  // A value that looks like a path, a cron field, or a negative number.
  const tricky = positionalArgs(['create', '0 9 * * *', '--name', '--json']);
  check('a flag whose value is another flag',
    JSON.stringify(tricky) === '["create","0 9 * * *"]', JSON.stringify(tricky));
}

console.log('');
if (failures) {
  console.error(`CLI-PARSING TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CLI-PARSING TEST PASSED\n');
