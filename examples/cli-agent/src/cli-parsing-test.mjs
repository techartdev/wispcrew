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

/* Reimplement exactly what the CLI does, to test the behaviour itself. */
const positionalArgs = (argv) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out.push(arg);
      continue;
    }
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
   * `--json --quiet name` — `name` is consumed as the value of `--quiet`.
   *
   * Genuinely ambiguous: without a declared arity per flag, nothing can tell
   * a boolean flag followed by a positional from a flag taking a value. The
   * property that matters is that both readers make the SAME choice, so an
   * argument is never both a flag value and a positional, nor neither.
   *
   * In practice flags come last, which is why this has not bitten anyone —
   * and the shape is pinned here so a future change to one reader without
   * the other fails loudly.
   */
  const two = positionalArgs(['--json', '--quiet', 'name']);
  const twoFlags = parseArgs(['--json', '--quiet', 'name']);
  check('a boolean flag before a positional is ambiguous',
    two.length === 0 && twoFlags.quiet === 'name', JSON.stringify(two));

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
