/**
 * Do the documents describe the software that exists?
 *
 * A public repository is read by people who cannot check the claims, so a
 * stale sentence is worse than a missing one: it sends someone down a path
 * that does not exist and teaches them to distrust the rest.
 *
 * This is a REPORT, not a gate — it lists what looks wrong and lets a human
 * judge. `check-readme.cjs` is the gate, and covers links and commands.
 */
const fs = require('fs');
const path = require('path');

process.chdir(path.resolve(__dirname, '..'));

const problems = [];

/* A quickstart is the first thing a stranger runs, so it has its own gate. */
const note = (file, what) => problems.push({ file, what });

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/* ---------------------------------------------------------------- */
/* the CLI exists                                                     */
/* ---------------------------------------------------------------- */

const cliCommands = [
  ...read('apps/daemon/src/cli-commands.ts').matchAll(/^ {4}name: '([a-z]+(?: [a-z]+)?)',$/gm),
].length;

for (const doc of [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/DEVELOPMENT.md',
  'docs/STATUS.md',
  'docs/HANDOVER.md',
  'AGENTS.md',
]) {
  const text = read(doc);
  if (!text) continue;

  // A document describing the project's shape should know about a binary
  // with this many commands.
  const knowsCli = /wispcrew (ask|agents|pair|configure|tasks)\b/.test(text);
  if (!knowsCli) note(doc, `does not mention the CLI (${cliCommands} commands exist)`);

  if (/planned,? (?:and )?not built/i.test(text)) {
    note(doc, 'still calls something "planned, not built"');
  }
}

/* ---------------------------------------------------------------- */
/* the repository map matches the tree                                */
/* ---------------------------------------------------------------- */

{
  /*
   * The map covers several directories, so a named file is checked against
   * all of them rather than against `packages/runtime/src` alone — the first
   * version reported six real files as missing because they live in
   * `apps/desktop/src/main`, which is exactly the kind of false alarm that
   * teaches people to ignore a checker.
   */
  const sourceDirs = [
    'packages/runtime/src',
    'packages/shared/src',
    'packages/core/src',
    'packages/llm/src',
    'packages/tools/src',
    'packages/mcp/src',
    'apps/desktop/src/main',
    'apps/desktop/src/preload',
    'apps/desktop/src/renderer',
    'apps/daemon/src',
  ];

  const known = new Set();
  for (const dir of sourceDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) known.add(f);
  }

  for (const doc of ['AGENTS.md', 'README.md', 'docs/ARCHITECTURE.md']) {
    const text = read(doc);
    if (!text) continue;

    // A file the map names that no longer exists sends a reader hunting.
    for (const named of text.matchAll(/^\s{4}([a-z-]+\.tsx?)\s{2,}/gm)) {
      if (!known.has(named[1])) note(doc, `names ${named[1]}, which no longer exists`);
    }
  }
}

/* ---------------------------------------------------------------- */
/* the suite count is one number everywhere                           */
/* ---------------------------------------------------------------- */

{
  const pkg = JSON.parse(read('examples/cli-agent/package.json'));
  const actual = pkg.scripts.test.split('&&').filter((s) => s.includes('test:')).length;

  for (const doc of ['AGENTS.md', 'README.md', 'docs/DEVELOPMENT.md', 'docs/HANDOVER.md']) {
    const text = read(doc);
    for (const claim of text.matchAll(/(\d+) offline suites?/g)) {
      if (Number(claim[1]) !== actual) {
        note(doc, `claims ${claim[1]} offline suites; there are ${actual}`);
      }
    }
  }
}

/* ---------------------------------------------------------------- */
/* every relative link resolves, in every document                    */
/* ---------------------------------------------------------------- */

{
  const docs = [
    ...fs.readdirSync('.').filter((f) => f.endsWith('.md')),
    ...fs.readdirSync('docs').map((f) => `docs/${f}`).filter((f) => f.endsWith('.md')),
  ];

  for (const doc of docs) {
    const text = read(doc);
    const base = path.dirname(doc);

    for (const link of text.matchAll(/\]\((?!https?:|#)([^)#]+)\)/g)) {
      const target = path.join(base, link[1]);
      if (!fs.existsSync(target) && !fs.existsSync(link[1])) {
        note(doc, `link to ${link[1]} does not resolve`);
      }
    }
  }
}

/* ---------------------------------------------------------------- */

console.log(`documents checked, ${problems.length} thing(s) to look at:`);
console.log('');

if (problems.length === 0) {
  console.log('  everything documented matches what exists');
  process.exit(0);
}

let current = '';
for (const p of problems.sort((a, b) => a.file.localeCompare(b.file))) {
  if (p.file !== current) {
    current = p.file;
    console.log(`  ${current}`);
  }
  console.log(`    - ${p.what}`);
}
