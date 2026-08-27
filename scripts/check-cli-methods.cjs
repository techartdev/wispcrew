/**
 * Every method a CLI command calls must exist on the node.
 *
 * A command that calls a method the node does not serve fails at runtime
 * with "Unknown method", which is a bad way to find out: it typechecks,
 * builds, appears in `capabilities`, and only fails when somebody runs it on
 * a real machine.
 *
 * Found exactly that way — `test provider` shipped calling `testConnection`,
 * which the desktop bridge has and the node's method table does not.
 */
const fs = require('fs');
const path = require('path');

process.chdir(path.resolve(__dirname, '..'));

const commands = fs.readFileSync('apps/daemon/src/cli-commands.ts', 'utf8');
const methods = fs.readFileSync('apps/daemon/src/methods.ts', 'utf8');

/* What the CLI calls over the protocol. */
const called = new Set();
for (const m of commands.matchAll(/\bcall(?:<[\s\S]*?>)?\(\s*'(\w+)'/g)) called.add(m[1]);

/* What the node serves. */
const served = new Set();
for (const m of methods.matchAll(/^\s{4}(\w+):/gm)) served.add(m[1]);

const missing = [...called].filter((name) => !served.has(name)).sort();

console.log('CLI calls  :', called.size);
console.log('node serves:', served.size);
console.log('');

if (missing.length === 0) {
  console.log('every method the CLI calls exists on the node');
  process.exit(0);
}

console.log(`MISSING FROM THE NODE (${missing.length}):`);
for (const name of missing) console.log('  ' + name);

// A gate, not a report: this failure is invisible until someone runs the
// command on a real machine, which is too late.
process.exit(1);
