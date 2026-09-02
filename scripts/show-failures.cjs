/**
 * show-failures.cjs — why an agent's tool calls failed, in its own words.
 *
 *   node scripts/show-failures.cjs "<agent>" [count]
 *
 * A turn that burns its step budget is usually not exploring — it is
 * retrying. This prints each failed call with the arguments it was given and
 * the message it got back, which is the difference between "the model is
 * wandering" and "the tool is refusing something reasonable".
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = path.join(os.homedir(), '.wispcrew');
const [wanted, countRaw] = process.argv.slice(2);
const count = Number(countRaw ?? 12);

const agents = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8'));
const agent =
  agents.find((a) => a.id === wanted) ||
  agents.find((a) => a.name.toLowerCase() === String(wanted).toLowerCase());

if (!agent) {
  console.error(`no agent "${wanted}"`);
  process.exit(1);
}

const entries = JSON.parse(
  fs.readFileSync(path.join(dir, 'transcripts', `${agent.id}.json`), 'utf8'),
);

const failed = entries.filter((e) => e.kind === 'tool-call' && e.status === 'failed');

console.log(`${failed.length} failed call(s); showing the last ${Math.min(count, failed.length)}\n`);

for (const c of failed.slice(-count)) {
  console.log('='.repeat(78));
  console.log(`${c.toolName}`);
  console.log(`  args: ${JSON.stringify(c.args).slice(0, 400)}`);
  console.log('  --- said back ---');
  for (const line of String(c.content ?? '(nothing)').split('\n').slice(0, 14)) {
    console.log(`  ${line}`);
  }
  console.log('');
}
