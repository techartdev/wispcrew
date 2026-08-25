/**
 * room-delegation-test.mjs — a room-mate is a colleague, not a delegate.
 *
 * Delegation and membership are different relationships. A delegate is asked
 * privately and reports back; a room member is addressed with `@handle` and
 * answers in front of everyone.
 *
 * Offering both meant an agent that had just been asked a question handed it
 * to a room-mate instead of answering. Measured on a live run: the room
 * filled with "Reply from Assistant" while nobody actually answered.
 *
 * Offline: the delegation tool is inspected, never run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addParticipant,
  createAgentWithRoom,
  createNodeCrypto,
  getConversation,
  initStore,
  LOCAL_HUMAN_ID,
  makeAskAgentTool,
  rootContext,
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-rd-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

const sums = createAgentWithRoom({ name: 'Sums' });
const colours = createAgentWithRoom({ name: 'Colours' });
const outsider = createAgentWithRoom({ name: 'Researcher' });

// Put Colours in the Sums room; Researcher stays outside.
addParticipant(
  sums.id,
  { kind: 'agent', id: colours.id, handle: 'colours' },
  LOCAL_HUMAN_ID,
  'You',
);

const members = (getConversation(sums.id)?.participants ?? [])
  .filter((p) => p.kind === 'agent')
  .map((p) => p.id);

/**
 * Everything the model is shown about this tool.
 *
 * The roster lives under `definition`, not on the tool object — serialising
 * the whole thing is what makes this robust to that layout rather than
 * dependent on remembering it.
 */
const describe = (ctx) => {
  const tool = makeAskAgentTool(sums.id, ctx, async () => 'x');
  return tool ? JSON.stringify(tool.definition ?? tool) : null;
};

console.log('\n[the room list is what excludes]');
{
  check('both agents are in the room', members.length === 2, String(members.length));
  check('and the outsider is not', !members.includes(outsider.id));
}

console.log('\n[a room-mate is not offered]');
{
  const text = describe(rootContext('auto', sums.id, members));
  check('the tool still exists', text !== null);
  // Researcher is outside the room and remains a legitimate delegate; that
  // is what keeps ask_agent useful at all.
  check('the outsider is offered', /Researcher/.test(text ?? ''), (text ?? '').slice(0, 120));
  check('the room-mate is NOT offered', !/Colours/.test(text ?? ''), (text ?? '').slice(0, 120));
}

console.log('\n[without the room list, nothing is excluded]');
{
  // Proves the exclusion is doing the work, rather than something else
  // happening to hide the agent.
  const text = describe(rootContext('auto', sums.id));
  check('the room-mate reappears', /Colours/.test(text ?? ''));
}

console.log('\n[an empty room excludes nobody]');
{
  const text = describe(rootContext('auto', sums.id, []));
  check('both are offered', /Colours/.test(text ?? '') && /Researcher/.test(text ?? ''));
}

console.log('\n[a room with no outsiders offers no tool]');
{
  /*
   * Nothing to delegate to: do not advertise a tool that can only fail.
   * With Researcher excluded as well, only room-mates remain.
   */
  const everyone = [...members, outsider.id];
  const tool = makeAskAgentTool(sums.id, rootContext('auto', sums.id, everyone), async () => 'x');
  check('the tool is withheld', tool === null, tool ? 'still offered' : '');
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`ROOM-DELEGATION TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM-DELEGATION TEST PASSED\n');
