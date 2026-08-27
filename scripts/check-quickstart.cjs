/**
 * Does the quickstart describe commands that exist?
 *
 * A quickstart is read by someone with no way to check it, so a wrong
 * command is worse here than anywhere else: it is the first thing they try,
 * and its failure is their first impression of the project.
 */
const fs = require('fs');
const path = require('path');

// Anchored to the repository, not the working directory: npm runs workspace
// scripts from elsewhere, and this file has already moved once.
process.chdir(path.resolve(__dirname, '..'));

const text = fs.readFileSync('QUICKSTART.md', 'utf8');
const commands = fs.readFileSync('apps/daemon/src/cli-commands.ts', 'utf8');
const cli = fs.readFileSync('apps/daemon/src/cli.ts', 'utf8');

let bad = 0;
const fail = (msg) => {
  console.log('  FAIL ' + msg);
  bad++;
};

/* Every command it tells someone to run. */
console.log('\n[commands] each one exists');
const seen = new Set();
for (const m of text.matchAll(/^\s*wispcrew ([a-z]+(?: [a-z]+)?)/gm)) {
  const name = m[1];
  if (seen.has(name)) continue;
  seen.add(name);

  // Routed either as `'name':` or as shorthand `name,`.
  const routed =
    new RegExp(`^\\s+'?${name}'?:`, 'm').test(cli) ||
    new RegExp(`^\\s+${name},$`, 'm').test(cli) ||
    ['serve', 'status'].includes(name);

  if (routed) console.log('  ok   wispcrew ' + name);
  else fail(`wispcrew ${name} is not a command`);
}

/* Every npm command. */
console.log('\n[npm] each script exists');
{
  const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const desktop = JSON.parse(fs.readFileSync('apps/desktop/package.json', 'utf8'));
  const scripts = new Set([
    ...Object.keys(root.scripts ?? {}),
    ...Object.keys(desktop.scripts ?? {}),
  ]);

  for (const m of text.matchAll(/npm run ([a-z:]+)/g)) {
    if (scripts.has(m[1])) console.log('  ok   npm run ' + m[1]);
    else fail(`npm run ${m[1]} is not defined`);
  }
}

/*
 * Every flag it shows.
 *
 * A flag is "read" if it appears quoted (`text(ctx.args, 'model')`) or as a
 * property (`args.network`). The first version checked only the quoted form
 * and reported `--network` as fake — it is read as `args.network` — which is
 * the kind of false alarm that makes a checker worth ignoring.
 *
 * `--version` and a `---` rule are not WispCrew flags at all.
 */
const NOT_OURS = new Set(['-', '--', '---', 'version']);

console.log('\n[flags] each one is real');
for (const m of text.matchAll(/--([a-z-]+)/g)) {
  const flag = m[1];
  if (seen.has('flag:' + flag) || NOT_OURS.has(flag)) continue;
  seen.add('flag:' + flag);

  const asProperty = new RegExp(`args\\.?\\[?'?${flag.replace('-', '')}`, 'i');
  const known =
    commands.includes(`'${flag}'`) ||
    cli.includes(`'${flag}'`) ||
    asProperty.test(cli) ||
    asProperty.test(commands);

  if (known) console.log('  ok   --' + flag);
  else fail(`--${flag} is not read by any command`);
}

/* Links. */
console.log('\n[links] each resolves');
for (const m of text.matchAll(/\]\((?!https?:|#)([^)#]+)\)/g)) {
  if (fs.existsSync(m[1])) console.log('  ok   ' + m[1]);
  else fail(`${m[1]} does not exist`);
}

console.log('');
console.log(bad === 0 ? 'QUICKSTART CHECK PASSED' : `QUICKSTART CHECK FAILED — ${bad}`);
process.exit(bad === 0 ? 0 : 1);
