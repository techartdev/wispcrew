/**
 * handle-test.mjs — an agent's handle follows its name, and says so.
 *
 * Two complaints, one cause.
 *
 * "@openclaw and @openclaw2, because first word of their name? I prefer slug
 * names with full name." Handles kept only the first meaningful word, which
 * reads well for one agent and fails for a team: "OpenClaw AddOn Dev" and
 * "OpenClaw Dev Version" — two agents on the same project, which is exactly
 * when you have several — collapsed onto the same word. The numbering is the
 * tell: the shortening manufactured a collision and then papered over it.
 *
 * "The one which was originally in chat thinks his name is @assistant, so
 * he's not aware of his name at all." The handle and the direct chat's title
 * were fixed at creation, so renaming the agent left both behind. Dumping
 * the prompt showed it correctly said `@openclaw`; what the model was
 * reading was its own carried history, in which it had been `@assistant`
 * for hundreds of turns. History is longer than a prompt.
 *
 * Offline: store and conversations.
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
  getConversation,
  initStore,
  listConversations,
  loadTranscript,
  LOCAL_HUMAN_ID,
  migrateHandles,
  setHost,
  updateAgent,
  upsertTranscriptEntry,
} from '@wispcrew/runtime';
import { handleFor } from '@wispcrew/shared';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-handle-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

const make = (name) => createAgent({ name, presetId: 'openai', model: 'gpt-5.6-luna' });
const handleOf = (roomId, agentId) =>
  (getConversation(roomId)?.participants ?? []).find((p) => p.id === agentId)?.handle;

console.log('\n[the reported pair] two agents on one project stay apart');
{
  const main = make('OpenClaw AddOn Dev');
  const dev = make('OpenClaw Dev Version');

  const room = createRoom({
    title: 'OpenClaw',
    members: [
      { id: main.id, name: main.name },
      { id: dev.id, name: dev.name },
    ],
  });

  check('the first is its whole name', handleOf(room.id, main.id) === 'openclaw-addon-dev',
    handleOf(room.id, main.id));
  check('and so is the second', handleOf(room.id, dev.id) === 'openclaw-dev-version',
    handleOf(room.id, dev.id));
  // The old rule produced @openclaw and @openclaw2 here.
  check('neither is numbered', !/\d$/.test(handleOf(room.id, dev.id) ?? ''));
}

console.log('\n[rename] the handle and the chat title follow');
{
  const agent = make('Assistant');
  const chat = createConversation({ agentId: agent.id, agentName: agent.name });

  check('it starts as its name', handleOf(chat.id, agent.id) === 'assistant');
  check('and the chat is titled after it', getConversation(chat.id)?.title === 'Assistant');

  updateAgent(agent.id, { name: 'OpenClaw AddOn Dev' });

  /*
   * This reverses an earlier decision that froze handles so a rename "must
   * not silently break every @mention already in the transcript". The trade
   * was the wrong way round: old mentions are prose in a finished
   * conversation, while a frozen handle is live and wrong.
   */
  check('the handle follows the rename',
    handleOf(chat.id, agent.id) === 'openclaw-addon-dev', handleOf(chat.id, agent.id));
  check('and so does the chat title',
    getConversation(chat.id)?.title === 'OpenClaw AddOn Dev', getConversation(chat.id)?.title);

  /*
   * And it is said out loud. Everyone addresses everyone by handle, and a
   * transcript full of the old one is what an agent reads back — without a
   * line marking the change, the history wins.
   */
  const notice = loadTranscript(chat.id).filter((e) => e.kind === 'notice').pop();
  check('the room is told', /now addressed as @openclaw-addon-dev/.test(notice?.text ?? ''),
    notice?.text);
  check('naming what it was', /was @assistant/.test(notice?.text ?? ''), notice?.text);
}

console.log('\n[a named group keeps its name]');
{
  const a = make('Alpha');
  const b = make('Beta');
  const room = createRoom({
    title: 'Deploy review',
    members: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }],
  });

  updateAgent(a.id, { name: 'Alpha Renamed' });

  check('the member handle follows', handleOf(room.id, a.id) === 'alpha-renamed',
    handleOf(room.id, a.id));
  /*
   * The title is the user's own words. Naming a room is the whole point of
   * being able to, and a rename must not overwrite it.
   */
  check('but the room keeps its name', getConversation(room.id)?.title === 'Deploy review',
    getConversation(room.id)?.title);
}

console.log('\n[no self-collision] renaming twice does not number it');
{
  const agent = make('Solo');
  const chat = createConversation({ agentId: agent.id, agentName: agent.name });

  updateAgent(agent.id, { name: 'Renamed Once' });
  updateAgent(agent.id, { name: 'Renamed Once' });
  updateAgent(agent.id, { name: 'Renamed Once' });

  /*
   * Without excluding an agent's own current handle from the taken list, it
   * collides with itself and gains a `2` on every pass.
   */
  check('the handle is stable', handleOf(chat.id, agent.id) === 'renamed-once',
    handleOf(chat.id, agent.id));
}

console.log('\n[migration] rooms written under the old rule');
{
  const one = make('Build server');
  const two = make('Build server');
  const room = createRoom({
    title: 'Builders',
    members: [{ id: one.id, name: one.name }, { id: two.id, name: two.name }],
  });

  // Force the old shape back onto the record, as a real profile has it.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8'));
  for (const r of raw) {
    if (r.id !== room.id) continue;
    for (const p of r.participants) {
      if (p.kind !== 'agent') continue;
      p.handle = p.id === one.id ? 'build' : 'build2';
    }
  }
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify(raw, null, 2));

  const changed = migrateHandles();
  check('it rewrote them', changed >= 2, String(changed));
  check('to the whole name', handleOf(room.id, one.id) === 'build-server',
    handleOf(room.id, one.id));
  /*
   * A GENUINE collision — two agents really do share a name — is still
   * numbered. The old rule's fault was inventing collisions, not numbering
   * real ones.
   */
  check('and a real collision is still numbered', handleOf(room.id, two.id) === 'build-server2',
    handleOf(room.id, two.id));

  const again = migrateHandles();
  check('a second run changes nothing', again === 0, String(again));
}

console.log('\n[carried history] the seam names who is now who');
{
  /*
   * The actual cause of the reported confusion. The group carried the whole
   * "Assistant" conversation, in which the agent had been addressed — and
   * addressed itself — by its old handle. The prompt said `@openclaw` and
   * lost, because history is longer than a prompt.
   */
  const main = make('Main Repo Agent');
  const dev = make('Dev Repo Agent');
  const chat = createConversation({ agentId: main.id, agentName: main.name });

  upsertTranscriptEntry(chat.id, {
    kind: 'message', id: 'old1', role: 'assistant',
    content: 'I am @assistant and I manage the main repo.', createdAt: 1,
  });

  const room = createRoom({
    title: 'Repos',
    members: [{ id: main.id, name: main.name }, { id: dev.id, name: dev.name }],
    fromConversationId: chat.id,
  });

  const seam = loadTranscript(room.id).at(-1);
  check('the seam is there', seam?.kind === 'notice', seam?.kind);
  check('and lists who is now who',
    /Main Repo Agent is @main-repo-agent/.test(seam?.text ?? ''), seam?.text);
  check('including the other member',
    /Dev Repo Agent is @dev-repo-agent/.test(seam?.text ?? ''), seam?.text);
  /*
   * Stated as overriding, not merely as information: what the model is
   * reading above says something different, and it needs to be told which
   * wins.
   */
  check('and says these apply from here on',
    /apply from here on, whatever was used above/.test(seam?.text ?? ''), seam?.text);
}

console.log('\n[still unique] two agents added separately do not clash');
{
  const a = make('Same Name');
  const b = make('Same Name');
  const chat = createConversation({ agentId: a.id, agentName: a.name });
  addParticipant(
    chat.id,
    { kind: 'agent', id: b.id, handle: handleFor(b.name, ['same-name']) },
    LOCAL_HUMAN_ID,
    'You',
  );

  check('the second is numbered', handleOf(chat.id, b.id) === 'same-name2',
    handleOf(chat.id, b.id));
  check('and the first is untouched', handleOf(chat.id, a.id) === 'same-name');
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`HANDLE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('HANDLE TEST PASSED\n');
