/**
 * show-tool-calls.cjs — what an agent's tools were actually asked to do.
 *
 *   node scripts/show-tool-calls.cjs <agent name or id> [count]
 *
 * Written to answer "did the shell run where it was supposed to?" from
 * evidence rather than reasoning. The transcript records the arguments; the
 * chat only shows the answer.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = path.join(os.homedir(), '.wispcrew');
const [wanted, countRaw] = process.argv.slice(2);
const count = Number(countRaw ?? 20);

const agents = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8'));
const agent =
  agents.find((a) => a.id === wanted) ||
  agents.find((a) => a.name.toLowerCase() === String(wanted).toLowerCase());

if (!agent) {
  console.error(`no agent "${wanted}". Have: ${agents.map((a) => a.name).join(', ')}`);
  process.exit(1);
}

console.log(`agent      ${agent.name} (${agent.id})`);
console.log(`workspace  ${agent.workspaceRoot ?? '(the default)'}`);
console.log('');

const file = path.join(dir, 'transcripts', `${agent.id}.json`);
if (!fs.existsSync(file)) {
  console.error('no transcript');
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
const calls = entries.filter((e) => e.kind === 'tool-call');

for (const c of calls.slice(-count)) {
  const args = c.args ? JSON.stringify(c.args) : '(no args recorded)';
  console.log(`${String(c.toolName).padEnd(12)} ${args.slice(0, 300)}`);
}

console.log(`\n${calls.length} tool call(s) total; showing the last ${Math.min(count, calls.length)}`);
