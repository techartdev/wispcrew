/**
 * conversation-test.mjs — rooms, and the migration into them.
 *
 * A transcript was `f(agentId)`; it is now `f(conversationId)`. The
 * migration's whole job is to be invisible: every existing agent gets a room
 * whose id IS the agent's id, so the transcript file never moves and the
 * riskiest part of the change does nothing at all.
 *
 * That is deliberate. A migration that rewrites transcripts is a migration
 * that can corrupt them, and this project has already lost one conversation
 * to a careless write.
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
  getConversation,
  initStore,
  listConversations,
  loadTranscript,
  LOCAL_HUMAN_ID,
  migrateAgentsToConversations,
  removeParticipant,
  setHost,
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-conv-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

console.log('\n[handles] addressing an agent with @');
{
  check('a simple name', handleFor('Windows builder') === 'windows', handleFor('Windows builder'));
  // "Local" is skipped as a weak first word, so this also pins that
  // punctuation does not survive into the handle.
  check('punctuation is dropped', handleFor('Local Infra Eye!') === 'infra',
    handleFor('Local Infra Eye!'));
  check('an empty name still yields something', handleFor('') === 'agent');
  // Two agents called "Build server" would otherwise share a handle, and
  // `@build` would be ambiguous exactly when precision matters.
  check('a collision is numbered', handleFor('Build server', ['build']) === 'build2');
  check('and again', handleFor('Build server', ['build', 'build2']) === 'build3');

  /*
   * A leading word that only says WHERE an agent runs is skipped.
   * "Local Infrastructure Eye" became `@local`, which says nothing and
   * would collide with every other "Local something" — noticed on a real
   * profile, not imagined.
   */
  check('a weak first word is skipped',
    handleFor('Local Infrastructure Eye') === 'infrastructure',
    handleFor('Local Infrastructure Eye'));
  check('and an article', handleFor('The Reviewer') === 'reviewer');
  // Unless it is the whole name, where it is the only thing to go on.
  check('but not when it is the whole name', handleFor('Local') === 'local');
}

console.log('\n[migration] every existing agent gets a room');
{
  const a1 = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Assistant' });
  const a2 = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Local Infrastructure Eye' });

  // Give them conversations, as a real profile would have.
  for (let i = 0; i < 27; i++) {
    upsertTranscriptEntry(a1.id, {
      kind: 'message', id: `m${i}`, role: 'user', content: `entry ${i}`, createdAt: Date.now() + i,
    });
  }
  upsertTranscriptEntry(a2.id, {
    kind: 'message', id: 'x', role: 'user', content: 'hello', createdAt: Date.now(),
  });

  const created = migrateAgentsToConversations();
  check('a room per agent', created === 2, String(created));

  const rooms = listConversations();
  check('both rooms exist', rooms.length === 2);
  check('titled after the agent', rooms.some((r) => r.title === 'Assistant'));

  /*
   * The load-bearing assertion: the room id IS the agent id, which is what
   * lets the existing transcript file stay exactly where it is.
   */
  check('the room id is the agent id', Boolean(getConversation(a1.id)));
  check('so the transcript is untouched', loadTranscript(a1.id).length === 27,
    String(loadTranscript(a1.id).length));
  check('and the second one too', loadTranscript(a2.id).length === 1);
}

console.log('\n[participants] you and the agent');
{
  const room = listConversations().find((r) => r.title === 'Assistant');
  check('two participants', room.participants.length === 2, String(room.participants.length));

  const human = room.participants.find((p) => p.kind === 'human');
  check('a human is present', Boolean(human));
  check('with a stable id', human?.id === LOCAL_HUMAN_ID);
  // A person has doors; an agent does not.
  check('and channels', Array.isArray(human?.channels) && human.channels.includes('desktop'));

  const agent = room.participants.find((p) => p.kind === 'agent');
  check('an agent is present', Boolean(agent));
  check('with a handle', agent?.handle === 'assistant', agent?.handle);
  check('and no channels field', agent?.channels === undefined);

  check('mode defaults to open', room.mode === 'open');
}

console.log('\n[idempotent] running the migration twice changes nothing');
{
  const before = listConversations().length;
  const created = migrateAgentsToConversations();
  check('nothing new was created', created === 0, String(created));
  check('and the count is unchanged', listConversations().length === before);
}

console.log('\n[events] the room records what happened to it');
{
  const room = createConversation({ agentId: 'agent_x', agentName: 'Solo' });

  addParticipant(
    room.id,
    { kind: 'agent', id: 'agent_linux', handle: 'linux' },
    LOCAL_HUMAN_ID,
    'Vanyo',
  );

  const transcript = loadTranscript(room.id);
  const joined = transcript.find((e) => e.event?.kind === 'joined');
  check('a join is recorded', Boolean(joined));
  // Naming the actor matters: with two humans "User added" is ambiguous,
  // and it is plainly wrong when an agent invited a guest.
  check('naming who did it', joined?.text === 'Vanyo added @linux.', joined?.text);
  check('as a notice, so it already renders', joined?.kind === 'notice');
  check('and carries the subject', joined?.event?.subjectId === 'agent_linux');
}

console.log('\n[guests] an agent may bring in a specialist, who then leaves');
{
  const room = listConversations().find((r) => r.title === 'Solo');

  addParticipant(
    room.id,
    { kind: 'agent', id: 'agent_infra', handle: 'infra', invitedBy: 'agent_linux' },
    'agent_linux',
    '@linux',
  );

  const invited = loadTranscript(room.id).filter((e) => e.event?.kind === 'joined').pop();
  // "invited" rather than "added": an agent bringing in a guest is a
  // different act from a user adding a permanent member.
  check('reads as an invitation', invited?.text === '@linux invited @infra.', invited?.text);

  removeParticipant(room.id, 'agent_infra', 'agent_infra', '@infra');
  const left = loadTranscript(room.id).find((e) => e.event?.kind === 'left');
  check('leaving of its own accord', left?.text === '@infra left.', left?.text);

  const after = getConversation(room.id);
  check('and it is gone from the room', !after.participants.some((p) => p.id === 'agent_infra'));
}

console.log('\n[removal] being removed reads differently from leaving');
{
  const room = listConversations().find((r) => r.title === 'Solo');
  removeParticipant(room.id, 'agent_linux', LOCAL_HUMAN_ID, 'Vanyo');

  const removed = loadTranscript(room.id).filter((e) => e.event?.kind === 'left').pop();
  check('names who removed them', removed?.text === 'Vanyo removed @linux.', removed?.text);
}

console.log('\n[no duplicates] adding the same participant twice is a no-op');
{
  const room = listConversations().find((r) => r.title === 'Solo');
  const before = getConversation(room.id).participants.length;
  addParticipant(room.id, { kind: 'agent', id: 'agent_x', handle: 'solo' }, LOCAL_HUMAN_ID, 'Vanyo');
  check('the count is unchanged', getConversation(room.id).participants.length === before);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`CONVERSATION TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CONVERSATION TEST PASSED\n');
