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
  visibleParticipants,
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

  /*
   * But the deleted agent is out of it.
   *
   * Removing only its own room left it listed as a participant elsewhere, so
   * the room strip still offered `@guest` and a message addressed to it
   * reached nobody — the room looked willing to answer and silently would
   * not. The same shape as the missing-room bug, one level out.
   */
  check('and the deleted one is not',
    !(survivor?.participants ?? []).some((p) => p.id === guest.id),
    JSON.stringify((survivor?.participants ?? []).map((p) => p.handle ?? p.name)));
}

console.log('\n[old rooms] a ghost written before the fix is not shown');
{
  /*
   * The fix above stops NEW ghosts. It does nothing for a profile that
   * already has one — which is what a real user has.
   *
   * Measured: a mention menu offering `@scenariob — agent_mtbbymlly9j4el`,
   * an id where a name should be, for an agent that could never answer.
   *
   * So a dead participant is filtered on the way out too. Written directly
   * to the store here, because the API no longer allows creating one.
   */
  const rooms = JSON.parse(fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8'));
  const target = rooms.find((r) => r.id === 'room_shared');
  target.participants.push({ kind: 'agent', id: 'agent_gone', handle: 'ghost' });
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify(rooms), 'utf8');

  const stored = listConversations().find((c) => c.id === 'room_shared');

  /*
   * The store still has it, and must: `listConversations` is also how
   * membership is MANAGED. Filtering there made `removeParticipant` unable
   * to see the participant it was asked to remove — the conversation suite
   * caught that within a minute of the wrong fix.
   */
  check('the store keeps the record',
    (stored?.participants ?? []).some((p) => p.id === 'agent_gone'));

  // The display path is where a dead member must not appear.
  const shown = visibleParticipants(stored);
  check('but it is not shown', !shown.some((p) => p.id === 'agent_gone'),
    JSON.stringify(shown.map((p) => p.handle)));

  const living = shown.filter((p) => p.kind === 'agent');
  check('a real member survives', living.length === 1, JSON.stringify(living.map((p) => p.handle)));
  check('so does the human', shown.some((p) => p.kind === 'human'));
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
