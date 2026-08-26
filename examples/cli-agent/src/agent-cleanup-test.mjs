/**
 * agent-cleanup-test.mjs — deleting an agent takes its room with it.
 *
 * Every agent gets a room whose id IS the agent id. Deleting the agent
 * without the room left a conversation nobody could answer: it rendered in
 * the sidebar, accepted messages, and did nothing with them.
 *
 * Found on a real VPS as a "Linux" room with no agent in it, after using the
 * CLI's own delete command.
 *
 * Offline: store only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addParticipant,
  createAgentWithRoom,
  createConversation,
  createNodeCrypto,
  deleteAgent,
  initStore,
  listAgents,
  listConversations,
  LOCAL_HUMAN_ID,
  setHost,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cleanup-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'n', crypto: createNodeCrypto(dir) });
initStore(dir);

console.log('\n[own room] goes with the agent');
{
  const agent = createAgentWithRoom({ name: 'Doomed' });
  check('the room exists', listConversations().some((c) => c.id === agent.id));

  deleteAgent(agent.id);

  check('the agent is gone', !listAgents().some((a) => a.id === agent.id));
  check('and so is its room', !listConversations().some((c) => c.id === agent.id),
    JSON.stringify(listConversations().map((c) => c.title)));
}

console.log('\n[shared room] survives, because it is not the agent\u2019s own');
{
  const host = createAgentWithRoom({ name: 'Host' });
  const guest = createAgentWithRoom({ name: 'Guest' });

  /*
   * A room that is NOT either agent's own.
   *
   * `createConversation` always seeds a room with one agent, so a distinct
   * id is what makes this a shared room rather than an agent's private one —
   * and that distinction is exactly what the cleanup must respect.
   */
  const shared = createConversation({
    id: 'room_shared',
    title: 'Planning',
    agentId: host.id,
    agentName: 'Host',
  });
  addParticipant(shared.id, { kind: 'agent', id: guest.id, handle: 'guest' }, LOCAL_HUMAN_ID, 'You');

  deleteAgent(guest.id);

  check('the guest is gone', !listAgents().some((a) => a.id === guest.id));
  check('its own room went', !listConversations().some((c) => c.id === guest.id));

  /*
   * The shared room belongs to whoever created it, and may hold other agents
   * and a transcript the user still wants. Removing it because one
   * participant left would destroy work nobody asked to delete.
   */
  const survivor = listConversations().find((c) => c.id === shared.id);
  check('the shared room survives', Boolean(survivor));
  check('and still holds the other agent',
    (survivor?.participants ?? []).some((p) => p.id === host.id));
}

console.log('\n[transcript] removed too, so a recreated id starts clean');
{
  const agent = createAgentWithRoom({ name: 'Temporary' });
  const file = path.join(dir, 'transcripts', `${agent.id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[]', 'utf8');

  deleteAgent(agent.id);
  check('the transcript file is gone', !fs.existsSync(file));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`AGENT-CLEANUP TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('AGENT-CLEANUP TEST PASSED\n');
