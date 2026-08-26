/**
 * cli-schema-test.mjs — the description matches the binary.
 *
 * `wispcrew capabilities --json` exists so another coding agent can learn
 * this tool without parsing help prose. That only works if the description
 * is true, and a hand-written schema drifts from the dispatcher the moment
 * somebody adds a command and forgets.
 *
 * So this compares the two lists rather than trusting either. A documented
 * command that does not exist is a caller's wasted round trip; an
 * undocumented one is a capability nobody discovers.
 *
 * Offline: reads the built CLI, runs nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Anchored to the repository, not the working directory.
 *
 * npm runs a workspace script from `examples/cli-agent`, so relative paths
 * resolved two levels too deep — the suite passed when run by hand and failed
 * under `npm test`, which is the worst combination.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const cliSource = fs.readFileSync(path.join(repo, 'apps/daemon/src/cli.ts'), 'utf8');
const commandsSource = fs.readFileSync(
  path.join(repo, 'apps/daemon/src/cli-commands.ts'),
  'utf8',
);

/* What the dispatcher actually routes. */
const dispatchBlock = cliSource.slice(
  cliSource.indexOf('const CONNECTED'),
  cliSource.indexOf('};', cliSource.indexOf('const CONNECTED')),
);

const routed = new Set();

// `name: handler` and `'two words': handler`.
for (const match of dispatchBlock.matchAll(/^\s+'?([a-z]+(?: [a-z]+)?)'?:/gm)) {
  routed.add(match[1]);
}

/*
 * And shorthand entries — `ask,` rather than `ask: ask,`.
 *
 * Missing these reported three real commands as documented-but-unroutable,
 * which is exactly the wrong answer: they route fine, the reader was wrong.
 */
for (const match of dispatchBlock.matchAll(/^\s+([a-z]+),$/gm)) {
  routed.add(match[1]);
}

/*
 * What the schema claims.
 *
 * Matched at the entry's own indentation, because argument descriptors carry
 * a `name` too — a looser pattern collected "agent", "message" and "id" as
 * though they were commands.
 */
const schemaBlock = commandsSource.slice(commandsSource.indexOf('const COMMAND_SCHEMA'));
const documented = new Set();
for (const match of schemaBlock.matchAll(/^ {4}name: '([a-z]+(?: [a-z]+)?)',$/gm)) {
  documented.add(match[1]);
}

console.log('\n[coverage] both lists are non-trivial');
{
  check('the dispatcher routes commands', routed.size >= 10, `${routed.size} found`);
  check('the schema documents commands', documented.size >= 10, `${documented.size} found`);
}

console.log('\n[documented] every described command exists');
{
  const missing = [...documented].filter((name) => !routed.has(name));
  // A documented command that does not exist wastes a caller's round trip
  // and teaches them to distrust the rest of the description.
  check('no command is described but unroutable', missing.length === 0, missing.join(', '));
}

console.log('\n[routed] every command is described');
{
  /*
   * Aliases are deliberately not documented twice. `tasks` and `tasks list`
   * are the same command, and listing both would imply a difference.
   */
  const ALIASES = new Set(['tasks list', 'approvals list']);

  const undocumented = [...routed].filter(
    (name) => !documented.has(name) && !ALIASES.has(name),
  );
  check('no command is hidden from callers', undocumented.length === 0, undocumented.join(', '));
}

console.log('\n[shape] each entry says enough to be usable');
{
  const entries = [
    ...schemaBlock.matchAll(/^ {4}name: '([a-z]+(?: [a-z]+)?)',\n {4}summary: '([^']+)'/gm),
  ];
  check('entries have a summary', entries.length >= 10, String(entries.length));

  // A summary that just repeats the name teaches nothing.
  const lazy = entries.filter(([, name, summary]) => summary.toLowerCase() === name);
  check('summaries are not the name again', lazy.length === 0, lazy.map((e) => e[1]).join(', '));

  check('every entry declares what it returns',
    (schemaBlock.match(/returns:/g) ?? []).length === documented.size,
    `${(schemaBlock.match(/returns:/g) ?? []).length} of ${documented.size}`);
}

console.log('\n[destructive] dangerous commands say so');
{
  /*
   * `agents delete` requires `--yes`, and a caller reading only the schema
   * must learn that from the schema — otherwise their first attempt fails
   * for a reason they cannot see.
   */
  const deleteEntry = schemaBlock.slice(
    schemaBlock.indexOf("name: 'agents delete'"),
    schemaBlock.indexOf("name: 'ask'"),
  );
  check('agents delete documents --yes', deleteEntry.includes('--yes'));
  check('and says it is destructive', /destructive/i.test(deleteEntry));
}

console.log('');
if (failures) {
  console.error(`CLI-SCHEMA TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CLI-SCHEMA TEST PASSED\n');
