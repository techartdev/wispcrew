/**
 * check-agent-containment.cjs — reproduce a real agent's shell calls.
 *
 *   node scripts/check-agent-containment.cjs "<agent name>"
 *
 * Runs the shell tool with that agent's ACTUAL workspace, asking the
 * question that produced the wrong answer: which repository is this? Isolates
 * containment from model behaviour — if this reports the wrong repo, the tool
 * is at fault; if it reports the right one, the boundary holds.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shellTool } = require('../packages/tools/dist/index.js');

const dir = path.join(os.homedir(), '.wispcrew');
const wanted = process.argv[2];

const agents = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8'));
const agent =
  agents.find((a) => a.id === wanted) ||
  agents.find((a) => a.name.toLowerCase() === String(wanted).toLowerCase());

if (!agent) {
  console.error(`no agent "${wanted}". Have: ${agents.map((a) => a.name).join(', ')}`);
  process.exit(1);
}

const settings = JSON.parse(fs.readFileSync(path.join(dir, 'wispcrew-settings.json'), 'utf8'));
const root = agent.workspaceRoot || settings.workspaceRoot || path.join(dir, 'workspace');

const ctx = {
  workspaceRoot: root,
  defaultTimeoutMs: 20000,
  requestApproval: async () => true,
};

async function main() {
  console.log(`agent      ${agent.name}`);
  console.log(`workspace  ${root}`);
  console.log(`this process cwd  ${process.cwd()}   <- where an escape would land\n`);

  const remote = await shellTool.run({ command: 'git remote -v' }, ctx);
  console.log('git remote -v (default cwd):');
  console.log(
    String(remote.content)
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => `  ${l}`)
      .join('\n'),
  );

  console.log('\ngit rev-parse --show-toplevel:');
  const top = await shellTool.run({ command: 'git rev-parse --show-toplevel' }, ctx);
  console.log(
    String(top.content)
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => `  ${l}`)
      .join('\n'),
  );

  // And the escape that produced the original wrong answer.
  console.log('\nshell with cwd pointing at this repository:');
  const escaped = await shellTool.run(
    { command: 'git remote -v', cwd: process.cwd() },
    ctx,
  );
  console.log(`  ${escaped.errorCode ?? 'ALLOWED'} — ${String(escaped.content).slice(0, 160)}`);
}

void main();
