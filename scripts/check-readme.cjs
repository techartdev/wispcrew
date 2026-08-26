/**
 * Check the README's claims against the repository.
 *
 * A README is the one document everybody reads and nobody tests. Every link
 * that 404s and every command that does not exist is a small betrayal of the
 * reader's trust in the rest of it.
 */
const fs = require('fs');
const path = require('path');

/*
 * Anchored to the repository, not the working directory.
 *
 * Every path in here is relative, which was fine while the file sat at the
 * root and wrong the moment it moved into `scripts/`.
 */
process.chdir(path.resolve(__dirname, '..'));

const readme = fs.readFileSync('README.md', 'utf8');
let bad = 0;
const fail = (msg) => {
  console.log('  FAIL ' + msg);
  bad++;
};

console.log('\n[links] every relative link resolves');
for (const match of readme.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
  const target = match[1];
  if (fs.existsSync(target)) console.log('  ok   ' + target);
  else fail(target + ' does not exist');
}

console.log('\n[commands] every npm script named actually exists');
const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const cli = JSON.parse(fs.readFileSync('examples/cli-agent/package.json', 'utf8'));

/*
 * Every workspace, not just the two I happened to think of.
 *
 * The first version checked the root and the CLI, which meant it reported
 * `dist:win` as missing — correct, as it happens: those commands had been
 * documented as root scripts and live in `apps/desktop`, so they had never
 * worked as written. A checker that only looks where you expect finds only
 * the problems you expected.
 */
const scripts = new Set([...Object.keys(root.scripts ?? {}), ...Object.keys(cli.scripts ?? {})]);
for (const dir of ['apps/desktop', 'apps/daemon']) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) continue;
  for (const name of Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).scripts ?? {})) {
    scripts.add(name);
  }
}

for (const match of readme.matchAll(/npm run ([a-z:]+)/g)) {
  const script = match[1];
  if (scripts.has(script)) console.log('  ok   npm run ' + script);
  else fail('npm run ' + script + ' is not defined in any workspace');
}

console.log('\n[counts] the suite figure matches reality');
{
  const actual = cli.scripts.test.split('&&').filter((s) => s.includes('test:')).length;
  const claimed = /(\d+) offline suites/.exec(readme);
  if (!claimed) fail('no suite count in the README');
  else if (Number(claimed[1]) !== actual) fail(`claims ${claimed[1]}, actual ${actual}`);
  else console.log('  ok   ' + actual + ' offline suites');
}

console.log('\n[structure] the repository map names real directories');
for (const dir of ['packages/runtime', 'packages/shared', 'packages/llm', 'packages/core',
  'packages/tools', 'packages/mcp', 'apps/desktop', 'apps/daemon', 'examples/cli-agent']) {
  if (readme.includes(dir.split('/').pop() + '/') || readme.includes(dir)) {
    if (fs.existsSync(dir)) console.log('  ok   ' + dir);
    else fail(dir + ' is named but does not exist');
  }
}

console.log('\n[telegram] the commands the README documents are implemented');
{
  const host = fs.readFileSync('packages/runtime/src/telegram-host.ts', 'utf8');
  for (const command of ['connect', 'disconnect', 'here']) {
    if (host.includes(command)) console.log('  ok   /' + command);
    else fail('/' + command + ' is documented but not implemented');
  }
}

console.log('');
console.log(bad === 0 ? 'README CHECK PASSED' : `README CHECK FAILED — ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
