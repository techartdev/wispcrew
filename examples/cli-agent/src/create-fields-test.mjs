/**
 * create-fields-test.mjs — `createAgent` must not silently drop a field.
 *
 * It builds its record field by field, which means anything unlisted vanishes
 * without an error: the caller asked for one thing and got another, with
 * nothing to say so.
 *
 * This has now cost three fields, each found by a human noticing wrong
 * behaviour rather than by any test:
 *
 *   - `runAt`, which turned a one-off follow-up into a recurring routine
 *   - `channelPolicies`, so a per-channel permission never took effect
 *   - `nodeId`, so an agent created for a remote machine ran locally
 *
 * A comment saying "list every field" did not prevent the third. This does.
 *
 * Offline: store only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent, createNodeCrypto, initStore, listAgents, setHost } from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fields-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

console.log('\n[round trip] every field a caller can set survives creation');
{
  /*
   * One value per field a user or the UI can actually supply. Deliberately
   * distinctive values, so a field that comes back wrong is obvious rather
   * than coincidentally equal.
   */
  const patch = {
    name: 'Probe',
    description: 'a description',
    persona: 'coder',
    avatarShape: 'square',
    avatarColor: '#ff00ff',
    presetId: 'openai',
    model: 'gpt-4o-mini',
    nodeId: 'node_remote',
    workspaceRoot: '/tmp/somewhere',
    approvalPolicy: 'readonly',
    channelPolicies: { telegram: 'ask' },
    disabledTools: ['shell'],
    pinned: true,
  };

  const created = createAgent(patch);
  const stored = listAgents().find((a) => a.id === created.id);

  for (const [field, expected] of Object.entries(patch)) {
    const actual = stored?.[field];
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    check(field, same, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('\n[the specific regressions] the three that were actually lost');
{
  // Named individually as well, so a failure says which incident returned.
  const remote = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Remote', nodeId: 'node_vps' });
  check('nodeId — an agent for another machine', remote.nodeId === 'node_vps', remote.nodeId);

  const gated = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Gated', channelPolicies: { telegram: 'auto' } });
  check('channelPolicies — a per-door permission',
    gated.channelPolicies?.telegram === 'auto', JSON.stringify(gated.channelPolicies));
}

console.log('\n[required] a provider and a model, or no agent');
{
  /*
   * An empty patch used to produce a usable agent, because the provider and
   * the model were inherited from global settings at turn time. They were
   * inherited INDEPENDENTLY, which is what made it dangerous: the model was
   * usually set on the agent and the provider usually was not, so the two
   * came from different places and nothing compared them — an OpenAI model
   * aimed at NVIDIA, which answers `404 page not found` and always will.
   *
   * Refused at creation rather than reported at the first message. An agent
   * that cannot work should not exist: it looks fine in the roster, and the
   * failure lands in whatever room somebody added it to.
   */
  let threw = '';
  try {
    createAgent({});
  } catch (err) {
    threw = String(err.message ?? err);
  }
  check('an empty patch is refused', threw !== '', 'it was created');
  check('and says both are needed', /provider and a model/.test(threw), threw);
  check('naming what was missing', /provider=\(none\)/.test(threw) && /model=\(none\)/.test(threw),
    threw);

  // Half of the pair is still not enough — they are one decision.
  let halfway = '';
  try {
    createAgent({ name: 'Half', presetId: 'openai' });
  } catch (err) {
    halfway = String(err.message ?? err);
  }
  check('a provider with no model is refused', halfway !== '', 'it was created');
}

console.log('\n[defaults] everything else may still be left out');
{
  const bare = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna' });
  check('it has an id', typeof bare.id === 'string' && bare.id.length > 0);
  check('and a name', typeof bare.name === 'string' && bare.name.length > 0, bare.name);
  check('and timestamps', typeof bare.createdAt === 'number' && typeof bare.updatedAt === 'number');
  /*
   * Absent rather than a guessed default. These still inherit, and should:
   * a workspace, a policy and a node all fall back to something sensible,
   * and none of them can silently point a request at the wrong company —
   * which is the property the provider and model lacked.
   */
  check('with no invented node', bare.nodeId === undefined);
  check('and no invented policy', bare.approvalPolicy === undefined);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`CREATE-FIELDS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CREATE-FIELDS TEST PASSED\n');
