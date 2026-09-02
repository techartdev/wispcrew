/**
 * room-shape-test.mjs — step 1 of the room restructure: the shape.
 *
 * `docs/ROOMS.md` says a room should stop being its first agent. That is one
 * data-model change with two halves, and this suite pins both:
 *
 *   1. A room created as a GROUP gets an id of its own (`room_…`), so no
 *      agent is its root and deleting any member leaves it standing.
 *   2. Every room that already exists keeps its agent-derived id. Nothing
 *      moves on disk, no transcript is rewritten, and a one-to-one chat
 *      behaves exactly as it did before.
 *
 * The second half is the one worth a suite. A migration that rewrites
 * transcripts is a migration that can corrupt them, and this project has
 * already lost one conversation to a careless write.
 *
 * Offline: store only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addParticipant,
  createAgent,
  createConversation,
  createNodeCrypto,
  createRoom,
  deleteAgent,
  getConversation,
  initStore,
  listConversations,
  loadTranscript,
  LOCAL_HUMAN_ID,
  migrateAgentsToConversations,
  readJson,
  setHost,
  upsertTranscriptEntry,
  conversationsPath,
} from '@wispcrew/runtime';
import { agentsIn, isGroup, memberIds } from '@wispcrew/shared';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-room-shape-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

console.log('\n[direct] one agent, one chat — unchanged');
{
  const agent = createAgent({ name: 'Assistant' });
  const room = createConversation({ agentId: agent.id, agentName: agent.name });

  check('the room id is still the agent id', room.id === agent.id, room.id);
  check('and it is labelled direct', room.kind === 'direct', room.kind);
  check('isGroup says no', isGroup(room) === false);
  check('one member', memberIds(room).length === 1, String(memberIds(room).length));
  check('and that member is the agent', memberIds(room)[0] === agent.id);
}

console.log('\n[group] a room nobody owns');
{
  const a = createAgent({ name: 'Builder' });
  const b = createAgent({ name: 'Reviewer' });
  const room = createRoom({ title: 'Deploy review', members: [
    { id: a.id, name: a.name },
    { id: b.id, name: b.name },
  ] });

  /*
   * The load-bearing assertion of the whole restructure. While a room's id
   * was an agent's id, the header showed that agent's model, Configure
   * opened that agent, and the room had nowhere to keep anything of its own.
   */
  check('the id belongs to the room', room.id.startsWith('room_'), room.id);
  check('and to no agent', room.id !== a.id && room.id !== b.id);
  check('labelled group', room.kind === 'group');
  check('isGroup says yes', isGroup(room) === true);
  check('both members are in it', memberIds(room).length === 2);
  check('handles are assigned', agentsIn(room).map((p) => p.handle).join(',') === 'builder,reviewer',
    agentsIn(room).map((p) => p.handle).join(','));
  check('and you are in it too', room.participants.some((p) => p.id === LOCAL_HUMAN_ID));
}

console.log('\n[no model] a room configures nothing');
{
  const room = listConversations().find((r) => r.title === 'Deploy review');
  /*
   * Not a style preference. A room that could set a model would make the
   * same agent answer differently depending on where it was spoken to,
   * which is the confusion rooms exist to end. There is no parameter for
   * one and no field to put it in — checked as data, so a future field
   * cannot be added without this failing.
   */
  const keys = Object.keys(room).sort().join(',');
  check('no model or provider anywhere on the record',
    !/model|provider|apiKey|baseUrl/i.test(keys), keys);
}

console.log('\n[minimum] a group of one is a chat, and is refused');
{
  const a = createAgent({ name: 'Lonely' });
  let threw = '';
  try {
    createRoom({ title: 'Just me', members: [{ id: a.id, name: a.name }] });
  } catch (err) {
    threw = String(err.message ?? err);
  }
  check('refused', threw !== '', 'it was allowed');
  check('and says why', /at least two/i.test(threw), threw);
}

console.log('\n[migration] rooms written before `kind` existed');
{
  /*
   * Hand-written records in the pre-restructure shape: no `kind` at all,
   * ids derived from their agents. This is what a real profile on disk
   * looks like right now.
   */
  const solo = createAgent({ name: 'Old Solo' });
  const mate = createAgent({ name: 'Old Mate' });
  const now = Date.now();

  const legacy = [
    {
      id: solo.id,
      title: 'Old Solo',
      participants: [
        { kind: 'human', id: LOCAL_HUMAN_ID, name: 'You', channels: ['app', 'desktop'] },
        { kind: 'agent', id: solo.id, handle: 'solo' },
      ],
      mode: 'open',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: mate.id,
      title: 'Old Pair',
      participants: [
        { kind: 'human', id: LOCAL_HUMAN_ID, name: 'You', channels: ['app', 'desktop'] },
        { kind: 'agent', id: mate.id, handle: 'mate' },
        { kind: 'agent', id: solo.id, handle: 'solo' },
      ],
      mode: 'open',
      createdAt: now,
      updatedAt: now,
    },
  ];

  const existing = readJson(conversationsPath(), []);
  fs.writeFileSync(conversationsPath(), JSON.stringify([...existing, ...legacy], null, 2));

  for (let i = 0; i < 12; i++) {
    upsertTranscriptEntry(solo.id, {
      kind: 'message', id: `old${i}`, role: 'user', content: `entry ${i}`, createdAt: now + i,
    });
  }

  migrateAgentsToConversations();

  const migratedSolo = getConversation(solo.id);
  const migratedPair = getConversation(mate.id);

  check('the one-to-one keeps its id', Boolean(migratedSolo));
  check('and its transcript is untouched', loadTranscript(solo.id).length === 12,
    String(loadTranscript(solo.id).length));
  check('labelled direct, because one agent is in it', migratedSolo?.kind === 'direct',
    migratedSolo?.kind);

  check('the two-agent room keeps its agent-derived id', Boolean(migratedPair));
  check('and is now labelled a group, which is how it already behaved',
    migratedPair?.kind === 'group', migratedPair?.kind);
  // Deliberately NOT renamed to `room_…`. Nothing moves on disk; there is no
  // flag day; both id shapes work indefinitely.
  check('its id is still the founding agent\'s', migratedPair?.id === mate.id);

  // Persisted, not merely computed on the way out — so the file stops
  // needing to be interpreted.
  const onDisk = JSON.parse(fs.readFileSync(conversationsPath(), 'utf8'));
  check('written to disk', onDisk.find((r) => r.id === mate.id)?.kind === 'group');
}

console.log('\n[idempotent] a second migration changes nothing');
{
  const before = fs.readFileSync(conversationsPath(), 'utf8');
  migrateAgentsToConversations();
  const after = fs.readFileSync(conversationsPath(), 'utf8');
  check('the file is byte-identical', before === after);
}

console.log('\n[founder] deleting the agent a group started from');
{
  const mate = listConversations().find((r) => r.title === 'Old Pair');
  const founderId = mate.id;

  /*
   * Before `kind`, this deleted the whole group: the hook removed any room
   * whose id matched the departing agent, and a group made by adding a
   * second agent to a chat carries the founding agent's id. Deleting any
   * OTHER member was harmless. Silent data loss that depended on which
   * member you removed.
   */
  deleteAgent(founderId);

  const after = getConversation(founderId);
  check('the group survives its founder', Boolean(after), 'the room was deleted with the agent');
  check('its transcript is still reachable', Array.isArray(loadTranscript(founderId)));
  check('and the departed agent is no longer a member',
    !(after?.participants ?? []).some((p) => p.id === founderId));
}

console.log('\n[direct is still disposable] a private chat goes with its agent');
{
  const solo = createAgent({ name: 'Temp' });
  createConversation({ agentId: solo.id, agentName: solo.name });
  check('the chat exists', Boolean(getConversation(solo.id)));

  deleteAgent(solo.id);
  // Unchanged behaviour: a one-to-one has no reason to outlive its only
  // agent — it would render in the sidebar and answer nothing.
  check('and is gone with the agent', !getConversation(solo.id));
}

console.log('\n[promotion] a second agent joining a chat makes it a group');
{
  const host = createAgent({ name: 'Host' });
  const guest = createAgent({ name: 'Guest' });
  const room = createConversation({ agentId: host.id, agentName: host.name });
  check('starts direct', room.kind === 'direct');

  addParticipant(room.id, { kind: 'agent', id: guest.id, handle: 'guest' }, LOCAL_HUMAN_ID, 'You');
  check('and becomes a group', getConversation(room.id)?.kind === 'group',
    getConversation(room.id)?.kind);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`ROOM SHAPE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM SHAPE TEST PASSED\n');
