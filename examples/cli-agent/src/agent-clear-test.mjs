/**
 * agent-clear-test.mjs — removing a field has to be said, not implied.
 *
 * An explicit `undefined` is dropped by `JSON.stringify`, so it cannot cross
 * IPC and a spread merge silently keeps the old value. Harmless for a name;
 * wrong for a permission — a user who cleared "run without asking from
 * Telegram" would still have granted it while the interface showed
 * otherwise.
 *
 * Measured against the real store during a live check, not theorised, which
 * is why this suite exists.
 *
 * Offline: store only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgent,
  createNodeCrypto,
  initStore,
  listAgents,
  setHost,
  updateAgent,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-clear-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

const reload = (id) => listAgents().find((a) => a.id === id);

console.log('\n[the trap] an explicit undefined does not delete');
{
  const agent = createAgent({ name: 'Probe', channelPolicies: { telegram: 'auto' } });

  /*
   * This is what a form would naturally send, and what silently failed.
   * Simulating the IPC boundary is the point: JSON.parse(JSON.stringify())
   * is exactly what happens between the renderer and the engine.
   */
  const overWire = JSON.parse(JSON.stringify({ channelPolicies: undefined, name: 'Probe' }));
  updateAgent(agent.id, overWire);

  check('the old value survives', reload(agent.id).channelPolicies?.telegram === 'auto',
    JSON.stringify(reload(agent.id).channelPolicies));
  console.log('       (that is the bug this exists to prevent)');
}

console.log('\n[clear] naming the field removes it');
{
  const agent = createAgent({ name: 'Probe2', channelPolicies: { telegram: 'auto' } });

  const overWire = JSON.parse(JSON.stringify({ clear: ['channelPolicies'] }));
  updateAgent(agent.id, overWire);

  check('the field is gone', reload(agent.id).channelPolicies === undefined,
    JSON.stringify(reload(agent.id).channelPolicies));
  // The instruction must not become part of the record.
  check('and `clear` is not stored', !('clear' in reload(agent.id)));
}

console.log('\n[partial updates] absence still means "leave it alone"');
{
  /*
   * The reason absence cannot mean deletion: a form that edits only the
   * name would otherwise wipe every permission on the agent.
   */
  const agent = createAgent({
    name: 'Probe3',
    channelPolicies: { telegram: 'ask' },
    approvalPolicy: 'readonly',
  });

  updateAgent(agent.id, { name: 'Renamed' });
  const after = reload(agent.id);

  check('the name changed', after.name === 'Renamed');
  check('the policy survived', after.channelPolicies?.telegram === 'ask');
  check('and so did the approval policy', after.approvalPolicy === 'readonly');
}

console.log('\n[both at once] a patch may set some fields and clear others');
{
  const agent = createAgent({
    name: 'Probe4',
    channelPolicies: { telegram: 'auto' },
    workspaceRoot: '/tmp/x',
  });

  updateAgent(agent.id, { name: 'Probe4b', clear: ['channelPolicies'] });
  const after = reload(agent.id);

  check('the set field applied', after.name === 'Probe4b');
  check('the cleared field is gone', after.channelPolicies === undefined);
  check('and an untouched field survived', after.workspaceRoot === '/tmp/x');
}

console.log('\n[identity] clear cannot remove what identifies the agent');
{
  const agent = createAgent({ name: 'Probe5' });
  updateAgent(agent.id, { clear: ['id', 'createdAt'] });
  const after = reload(agent.id);

  // Deleting these would orphan the transcript and the room that share the id.
  check('the id survives', after?.id === agent.id);
  check('and createdAt', typeof after?.createdAt === 'number');
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`AGENT-CLEAR TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('AGENT-CLEAR TEST PASSED\n');
