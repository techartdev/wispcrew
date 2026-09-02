/**
 * room-instructions-test.mjs — an agent can write down what the room is for.
 *
 * Asked to record the workflow it had just proposed, an agent answered "I
 * can't directly edit this room's instructions from the tools available to
 * me" and pasted the text for the user to copy by hand. Honest, and the
 * wrong division of labour: agreeing what a room is for is exactly what the
 * agents in it should be able to write down.
 *
 * Three constraints this tool lives inside, all pinned below:
 *
 *  - It needs APPROVAL, and the card shows the new text. Standing
 *    instructions shape every future turn of every member, so approving one
 *    blind would be approving a blank cheque.
 *  - It exists only in a GROUP. A one-to-one has no greeting — the agent's
 *    own description holds its standing instructions — and a tool that is
 *    offered gets used.
 *  - The change is ANNOUNCED. The bridge and the node wrap their own room
 *    mutations; neither is involved when an agent does it.
 *
 * Offline: the tool and the store.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRoomInstructionsTool } from '@wispcrew/tools';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** A room in a box, so the tool can be exercised without an engine. */
function room(initial = '') {
  const state = { text: initial, writes: 0 };
  const tool = makeRoomInstructionsTool({
    title: () => 'Deploy review',
    current: () => state.text,
    write: (t) => {
      state.text = t;
      state.writes++;
    },
  });
  return { state, tool };
}

const asked = [];
const ctx = (approve = true) => ({
  workspaceRoot: '',
  defaultTimeoutMs: 5000,
  requestApproval: async (req) => {
    asked.push(req);
    return approve;
  },
});

console.log('\n[writing] the agent records the workflow');
{
  asked.length = 0;
  const { state, tool } = room('Blunt and short.');

  const r = await tool.run({ instructions: 'Blunt and short.\n@one owns main; @two owns dev.' }, ctx());

  check('it succeeds', r.ok === true, r.content);
  check('and the room now says so', /@one owns main/.test(state.text), state.text);
  check('written once', state.writes === 1, String(state.writes));

  // The result quotes the new text, so the agent can repeat it to the user
  // without another read.
  check('the result shows what it now reads', /@one owns main/.test(r.content));
  // And keeps the old text, so a mistake is recoverable from the record.
  check('and keeps the previous text', r.data?.previous === 'Blunt and short.', r.data?.previous);
}

console.log('\n[approval] the card shows what it will become');
{
  asked.length = 0;
  const { tool } = room('old');
  await tool.run({ instructions: 'a completely new policy' }, ctx());

  check('approval was requested', asked.length === 1, String(asked.length));
  check('naming the room', /Deploy review/.test(asked[0]?.summary ?? ''), asked[0]?.summary);
  /*
   * The full text, not "the instructions will change". This rewrites the
   * standing instructions for every member; a card that said only that
   * something would change would be asking for a blank cheque.
   */
  check('and showing the new text', /a completely new policy/.test(asked[0]?.detail ?? ''),
    asked[0]?.detail);
}

console.log('\n[refused] a denial changes nothing');
{
  asked.length = 0;
  const { state, tool } = room('unchanged');

  const r = await tool.run({ instructions: 'something else' }, ctx(false));

  check('reported as denied', r.ok === false && r.errorCode === 'denied', r.errorCode);
  check('nothing was written', state.writes === 0 && state.text === 'unchanged', state.text);
  check('and the agent is told why', /did not approve/.test(r.content), r.content);
}

console.log('\n[no-op] setting the same text is not a change');
{
  asked.length = 0;
  const { state, tool } = room('exactly this');

  const r = await tool.run({ instructions: 'exactly this' }, ctx());

  // Not an error, and not a change. Saying so stops a model "confirming"
  // the edit by making it a second time.
  check('it succeeds', r.ok === true, r.content);
  check('without asking for approval', asked.length === 0, String(asked.length));
  check('and without writing', state.writes === 0, String(state.writes));
  check('saying nothing changed', /already say/.test(r.content), r.content);
}

console.log('\n[clearing] an empty string removes them, and says so');
{
  asked.length = 0;
  const { state, tool } = room('some rules');

  const r = await tool.run({ instructions: '   ' }, ctx());

  check('the card warns it is a removal', /REMOVE/.test(asked[0]?.detail ?? ''), asked[0]?.detail);
  check('and they are gone', state.text === '', JSON.stringify(state.text));
  check('reported as removed', /were removed/.test(r.content), r.content);
}

console.log('\n[groups only] and never in a one-to-one');
{
  /*
   * A one-to-one has no greeting: the agent's own description is where its
   * standing instructions live. Offering a tool that cannot work there
   * would get it used — hard rule 11 — so it is not registered at all.
   */
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');

  check('registered only for a group',
    /roomForInstructions\?\.kind === 'group'/.test(engine), 'it is offered everywhere');
  /*
   * Built per run rather than installed globally: a room turn runs its
   * members concurrently, so a shared "current conversation" would be
   * whichever run set it last.
   */
  check('built per run, not shared', /makeRoomInstructionsTool\(\{/.test(engine));
  check('bound to this conversation', /getConversation\(outputId\)\?\.greeting/.test(engine));
}

console.log('\n[announced] the change reaches an open window');
{
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');
  const conversations = fs.readFileSync(
    path.join(repo, 'packages/runtime/src/conversations.ts'),
    'utf8',
  );

  /*
   * The desktop bridge and the node's method table each wrap their own room
   * mutations in an announcement. Neither is involved when an AGENT makes
   * the change, so the engine has to say it.
   */
  check('the engine announces the room', /announceRooms\(/.test(engine));

  /*
   * And the room EVENT is pushed rather than merely written. It used
   * `store.upsertTranscriptEntry`, which saves and tells nobody — so the
   * very events that exist to explain how a room reached its state
   * appeared only after a reload, joins and departures included.
   */
  check('room events are pushed', /pushTranscript\(conversationId, entry\)/.test(conversations));
  check('and no longer merely written',
    !/store\.upsertTranscriptEntry\(conversationId, entry\)/.test(conversations));

  // It could only be written before because `pushTranscript` lived in the
  // engine, which imports conversations and so could not be imported back.
  const transcript = fs.readFileSync(path.join(repo, 'packages/runtime/src/transcript.ts'), 'utf8');
  check('the shared helper exists', /export function pushTranscript/.test(transcript));
  check('depending only on the store and the sink',
    !/from '\.\/engine\.js'/.test(transcript));
}

console.log('');
if (failures) {
  console.error(`ROOM-INSTRUCTIONS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM-INSTRUCTIONS TEST PASSED\n');
