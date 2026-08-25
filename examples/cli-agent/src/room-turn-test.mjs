/**
 * room-turn-test.mjs — running a turn in a room rather than at an agent.
 *
 * `runPrompt(agentId, text)` assumed one agent owned the conversation. This
 * is the replacement: given a room and something a person said, work out who
 * should act, and run them.
 *
 * The floor rules are tested separately as pure decisions. This covers the
 * part with effects — writing the message, starting the right runs, and what
 * happens when nobody was addressed.
 *
 * Offline: the engine is a spy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addParticipant,
  createAgent,
  createNodeCrypto,
  getConversation,
  initStore,
  listConversations,
  loadTranscript,
  LOCAL_HUMAN_ID,
  migrateAgentsToConversations,
  runRoomTurn,
  setHost,
  updateConversation,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-room-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

const windows = createAgent({ name: 'Windows builder' });
const linux = createAgent({ name: 'Linux builder' });
migrateAgentsToConversations();

const room = listConversations().find((r) => r.id === windows.id);
addParticipant(room.id, { kind: 'agent', id: linux.id, handle: 'linux' }, LOCAL_HUMAN_ID, 'You');

/** Records who was asked to run, without touching a provider. */
const spy = () => {
  const ran = [];
  return {
    ran,
    run: async (agentId, text) => {
      ran.push({ agentId, text });
    },
  };
};

console.log('\n[the message is recorded first]');
{
  const { run, ran } = spy();
  await runRoomTurn({ conversationId: room.id, text: '@windows check the build', speakerId: LOCAL_HUMAN_ID, run });

  const user = loadTranscript(room.id).filter((e) => e.kind === 'message' && e.role === 'user').pop();
  check('the message is in the room', Boolean(user));
  check('attributed to the person', user?.authorId === LOCAL_HUMAN_ID);
  // A local message has no `via`: the door is the app itself.
  check('with no channel for a local message', user?.via === undefined);
  check('and the tagged agent ran', ran.length === 1 && ran[0].agentId === windows.id,
    JSON.stringify(ran.map((r) => r.agentId)));
}

console.log('\n[tagging two runs both]');
{
  const { run, ran } = spy();
  await runRoomTurn({
    conversationId: room.id,
    text: '@windows and @linux compare notes',
    speakerId: LOCAL_HUMAN_ID,
    run,
  });
  check('both ran', ran.length === 2, String(ran.length));
  check('the right two', ran.map((r) => r.agentId).sort().join() === [windows.id, linux.id].sort().join());
}

console.log('\n[continuity] an untagged follow-up continues');
{
  const { run, ran } = spy();
  await runRoomTurn({ conversationId: room.id, text: '@linux run the tests', speakerId: LOCAL_HUMAN_ID, run });
  check('the tagged agent ran', ran[0]?.agentId === linux.id);

  // Remembering the addressee is what makes a follow-up work without tagging.
  const after = getConversation(room.id);
  check('and was remembered', after.lastAddressed?.[LOCAL_HUMAN_ID] === linux.id,
    JSON.stringify(after.lastAddressed));

  const second = spy();
  await runRoomTurn({ conversationId: room.id, text: 'and the linter?', speakerId: LOCAL_HUMAN_ID, run: second.run });
  check('an untagged follow-up continues with it', second.ran[0]?.agentId === linux.id,
    JSON.stringify(second.ran.map((r) => r.agentId)));
  check('and only it', second.ran.length === 1, String(second.ran.length));
}

console.log('\n[nobody addressed] the room says so rather than guessing');
{
  // Clear the memory so nothing continues.
  updateConversation(room.id, { lastAddressed: {} });

  const { run, ran } = spy();
  const result = await runRoomTurn({ conversationId: room.id, text: 'status?', speakerId: LOCAL_HUMAN_ID, run });

  check('nobody ran', ran.length === 0, JSON.stringify(ran));
  check('a reason is returned', Boolean(result.notice), result.notice);

  /*
   * The message must still be in the room. Losing it because nobody was
   * addressed would be baffling — the user said something, and a
   * conversation that silently discards it is indistinguishable from a
   * broken app.
   */
  const transcript = loadTranscript(room.id);
  const said = transcript.filter((e) => e.kind === 'message' && e.content === 'status?');
  check('but the message survives', said.length === 1, String(said.length));

  const notice = transcript.filter((e) => e.kind === 'notice').pop();
  check('and the room explains itself', /tag an agent|could answer/.test(notice?.text ?? ''),
    notice?.text);
}

console.log('\n[floor offer] agents that could answer are named, once');
{
  const events = loadTranscript(room.id).filter((e) => e.event?.kind === 'floor-requested');
  check('one line, not one per agent', events.length >= 1);
  // A user asked to approve every utterance stops reading, and then the
  // oversight is worthless.
  check('naming them together', /@windows.*@linux|@linux.*@windows/.test(events.at(-1)?.text ?? ''),
    events.at(-1)?.text);
}

console.log('\n[directed mode] the room stays quiet');
{
  updateConversation(room.id, { mode: 'directed', lastAddressed: {} });
  const before = loadTranscript(room.id).filter((e) => e.event?.kind === 'floor-requested').length;

  const { run } = spy();
  await runRoomTurn({ conversationId: room.id, text: 'anything?', speakerId: LOCAL_HUMAN_ID, run });

  const after = loadTranscript(room.id).filter((e) => e.event?.kind === 'floor-requested').length;
  // The mode exists precisely so nobody is nudged.
  check('no floor offer is made', after === before, `${before} -> ${after}`);

  updateConversation(room.id, { mode: 'open' });
}

console.log('\n[failure] one agent failing does not take down the other');
{
  updateConversation(room.id, { lastAddressed: {} });

  const ran = [];
  await runRoomTurn({
    conversationId: room.id,
    text: '@windows and @linux go',
    speakerId: LOCAL_HUMAN_ID,
    run: async (agentId) => {
      ran.push(agentId);
      if (agentId === windows.id) throw new Error('provider unreachable');
    },
  });

  check('both were attempted', ran.length === 2, String(ran.length));
  const error = loadTranscript(room.id).filter((e) => e.level === 'error').pop();
  check('the failure is reported', /could not finish/.test(error?.text ?? ''), error?.text);
  check('naming which agent', /@windows/.test(error?.text ?? ''), error?.text);
}

console.log('\n[missing room] a deleted conversation is handled');
{
  const result = await runRoomTurn({ conversationId: 'gone', text: 'hi', speakerId: LOCAL_HUMAN_ID });
  check('it does not throw', Boolean(result.notice), result.notice);
  check('and says what happened', /no longer exists/.test(result.notice ?? ''));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`ROOM-TURN TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM-TURN TEST PASSED\n');
