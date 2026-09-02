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

const sums = createAgentWithRoom({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Sums' });
const colours = createAgentWithRoom({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Colours' });
const outsider = createAgentWithRoom({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Researcher' });

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

console.log('\n[asking for a room-mate] answered as the wrong instrument, not a fault');
{
  /*
   * The refusal an agent actually reads.
   *
   * It used to say "No agent named Colours is available" and list the
   * others — which reads as a fault about a colleague the agent can plainly
   * see. One concluded the tool was broken and rebuilt the whole
   * application over a shell to reach an agent sitting in its own room,
   * because nothing told it that mentioning was the way.
   */
  const tool = makeAskAgentTool(sums.id, rootContext('auto', sums.id, members), async () => 'x');
  const ctx = { workspaceRoot: dir, defaultTimeoutMs: 1000, requestApproval: async () => true };

  const mate = await tool.run({ agent: 'Colours', task: 'what is 2 + 2?' }, ctx);

  check('it refuses', mate.ok === false);
  check('it does not claim the agent is missing',
    !/no agent named/i.test(mate.content), mate.content.slice(0, 90));
  check('it says they are already here', /in this room with you/i.test(mate.content));
  check('and names mentioning as the way', /mention/i.test(mate.content));
  check('and identifies the case', mate.errorCode === 'in_room', mate.errorCode);

  /*
   * A genuinely unknown name still gets the plain answer — and must NOT be
   * told to mention somebody who does not exist, which would send an agent
   * addressing thin air.
   */
  const missing = await tool.run({ agent: 'Nobody', task: 'x' }, ctx);
  check('an unknown agent is still unknown', missing.errorCode === 'unknown_agent');
  check('and is not told to mention it', !/mention/i.test(missing.content));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`ROOM-DELEGATION TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM-DELEGATION TEST PASSED\n');
