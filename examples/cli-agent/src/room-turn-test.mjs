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
import { handleFor } from '@wispcrew/shared';
import { DEFAULT_TURN_BUDGET } from '@wispcrew/runtime';
import {
  addEventSink,
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

const windows = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Windows builder' });
const linux = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Linux builder' });
migrateAgentsToConversations();

const room = listConversations().find((r) => r.id === windows.id);
// The handle the room would derive for this agent, not a hand-picked short
// one: the suite addresses it exactly as a user's completion menu would.
addParticipant(
  room.id,
  { kind: 'agent', id: linux.id, handle: handleFor(linux.name) },
  LOCAL_HUMAN_ID,
  'You',
);

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
  await runRoomTurn({ conversationId: room.id, text: '@windows-builder check the build', speakerId: LOCAL_HUMAN_ID, run });

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
    text: '@windows-builder and @linux-builder compare notes',
    speakerId: LOCAL_HUMAN_ID,
    run,
  });
  check('both ran', ran.length === 2, String(ran.length));
  check('the right two', ran.map((r) => r.agentId).sort().join() === [windows.id, linux.id].sort().join());
}

console.log('\n[continuity] an untagged follow-up continues');
{
  const { run, ran } = spy();
  await runRoomTurn({ conversationId: room.id, text: '@linux-builder run the tests', speakerId: LOCAL_HUMAN_ID, run });
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
  check('naming them together', /@windows-builder.*@linux-builder|@linux-builder.*@windows-builder/.test(events.at(-1)?.text ?? ''),
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
    text: '@windows-builder and @linux-builder go',
    speakerId: LOCAL_HUMAN_ID,
    run: async (agentId) => {
      ran.push(agentId);
      if (agentId === windows.id) throw new Error('provider unreachable');
    },
  });

  check('both were attempted', ran.length === 2, String(ran.length));
  const error = loadTranscript(room.id).filter((e) => e.level === 'error').pop();
  check('the failure is reported', /could not finish/.test(error?.text ?? ''), error?.text);
  check('naming which agent', /@windows-builder/.test(error?.text ?? ''), error?.text);
}

console.log('\n[announced] a room turn is not written silently');
{
  /*
   * All five of this module's transcript writes used
   * `store.upsertTranscriptEntry`, which saves and tells nobody. So a room
   * turn's own record — the user's message, the "nobody was addressed"
   * notice, a failed agent, a floor offer — existed on disk and appeared on
   * screen only after a reload. The same fault as the approval card that
   * was written but never announced, one layer out.
   *
   * It also stranded the composer: the client clears its optimistic
   * "working" state when the engine says something, and in a room the
   * engine said nothing at all, so the Stop button stayed live after every
   * agent had finished.
   */
  const seen = [];
  const off = addEventSink((e) => seen.push(e));

  updateConversation(room.id, { lastAddressed: {} });
  await runRoomTurn({
    conversationId: room.id,
    text: '@windows-builder say something',
    speakerId: LOCAL_HUMAN_ID,
    run: async () => {},
  });

  off();

  const transcripts = seen.filter((e) => e.type === 'transcript');
  check('entries are announced, not just saved', transcripts.length > 0,
    `${seen.length} event(s), none of them transcript`);

  // The user's own message is the one that must always arrive: it is what
  // replaces the optimistic placeholder on screen.
  const userMessage = transcripts.find(
    (e) => e.entry?.kind === 'message' && e.entry?.role === 'user',
  );
  check('including the message that started it', Boolean(userMessage));
  check('addressed to the room, not an agent', userMessage?.agentId === room.id,
    userMessage?.agentId);
}

console.log('\n[a room is a place] an agent can ask another agent');
{
  /*
   * Reported from real use: the user asked two agents to collaborate, the
   * first correctly wrote "@other-agent, please give me three ideas", and
   * the second never ran. `routeAgentMessage` had been written, exported
   * and left uncalled — only a HUMAN message was ever routed — so an agent
   * addressing a colleague was talking to nobody.
   */
  updateConversation(room.id, { lastAddressed: {} });

  const ran = [];
  await runRoomTurn({
    conversationId: room.id,
    text: '@windows-builder ask linux for a second opinion',
    speakerId: LOCAL_HUMAN_ID,
    run: async (agentId) => {
      ran.push(agentId);
      // What the first agent says is what gets routed next.
      return agentId === windows.id ? '@linux-builder what do you think?' : 'I think so too.';
    },
  });

  check('the addressed agent ran', ran.includes(windows.id));
  check('and the one IT addressed ran too', ran.includes(linux.id),
    `only ${ran.length} agent(s) ran`);
  check('each exactly once', ran.length === 2, JSON.stringify(ran));
}

console.log('\n[silence is the default] a reply that names nobody ends there');
{
  /*
   * The rule that keeps two helpful agents from talking forever: an agent
   * acts because it was ADDRESSED, not because somebody spoke.
   */
  updateConversation(room.id, { lastAddressed: {} });

  const ran = [];
  await runRoomTurn({
    conversationId: room.id,
    text: '@windows-builder go',
    speakerId: LOCAL_HUMAN_ID,
    run: async (agentId) => {
      ran.push(agentId);
      return 'Done. Nothing else needed.';
    },
  });

  check('only the addressed agent ran', ran.length === 1 && ran[0] === windows.id,
    JSON.stringify(ran));

  // And no notice: not replying is the normal case, so saying so under
  // every answer would be relentless noise about nothing happening.
  const last = loadTranscript(room.id).at(-1);
  check('and the room stays quiet about it',
    !/do not reply unless addressed/.test(last?.text ?? ''), last?.text);
}

console.log('\n[no self-reply] an agent naming itself is not a loop');
{
  updateConversation(room.id, { lastAddressed: {} });

  const ran = [];
  await runRoomTurn({
    conversationId: room.id,
    text: '@windows-builder go',
    speakerId: LOCAL_HUMAN_ID,
    run: async (agentId) => {
      ran.push(agentId);
      // Quoting its own handle must not wake it again.
      return 'As @windows-builder I have finished.';
    },
  });

  check('it runs once and stops', ran.length === 1, JSON.stringify(ran));
}

console.log('\n[the backstop] a chain stops, and says that it stopped');
{
  /*
   * Two agents each naming the other is an unbounded loop that costs real
   * money. The budget counts consecutive agent turns since a person last
   * spoke, so the failure mode is a pause rather than a bill.
   */
  updateConversation(room.id, { lastAddressed: {} });

  const ran = [];
  await runRoomTurn({
    conversationId: room.id,
    text: '@windows-builder start',
    speakerId: LOCAL_HUMAN_ID,
    run: async (agentId) => {
      ran.push(agentId);
      // Each one hands straight back to the other, forever, if permitted.
      return agentId === windows.id ? '@linux-builder your turn' : '@windows-builder your turn';
    },
  });

  check('the chain is bounded', ran.length <= DEFAULT_TURN_BUDGET + 1,
    `${ran.length} turns ran`);
  check('and it actually ran a chain', ran.length > 2, `${ran.length} turns ran`);

  /*
   * Said out loud. A conversation that halts mid-thought with no
   * explanation is indistinguishable from a broken app, and the difference
   * between "they finished" and "I stopped them" is the whole point of
   * having a budget.
   */
  const notice = loadTranscript(room.id).filter((e) => e.kind === 'notice').pop();
  check('the room says it stopped them', /stopping to check/.test(notice?.text ?? ''),
    notice?.text);
  check('and how to continue', /Say something/.test(notice?.text ?? ''), notice?.text);
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
