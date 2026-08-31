/**
 * prompt-test.mjs — what every agent is told, and what it is never told.
 *
 * The governing rule: **every line is stated from real state.** Nothing
 * asserts a capability in prose that could drift from the truth, and a fact
 * that is not known produces no line at all rather than a guess.
 *
 * That rule was learned expensively. Asked whether it had cron, an agent
 * answered "No — I don't have an internal persistent scheduler", and
 * proposed GitHub Actions instead. WispCrew has had one throughout; the
 * model had no way to know, so it misinformed the user about their own
 * application while reasoning perfectly.
 *
 * Offline: pure composition.
 */
import { PERSONAS, personaById, environmentFacts } from '@wispcrew/core';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const RICH = {
  agentName: 'Local Infrastructure Eye',
  handle: 'infra',
  modelHint: 'nemotron-3-nano',
  providerHint: 'NVIDIA NIM',
  machineName: 'evtinsait-host1',
  platform: 'Linux',
  workspace: '/root/.config/WispCrew/workspace',
  persistent: true,
  routines: ['"Nightly scan" (0 2 * * *)'],
  channels: ['Telegram'],
  room: {
    mode: 'open',
    participants: [
      { kind: 'human', name: 'You', via: 'a person, at the app and reachable on Telegram' },
      { kind: 'agent', name: 'Local Infrastructure Eye', handle: 'infra' },
      { kind: 'agent', name: 'Windows', handle: 'windows', via: 'an agent on another machine' },
    ],
  },
};

console.log('\n[parity] every persona is told the same facts');
{
  /*
   * The bug this prevents: only `general` composed the environment, so a
   * Coding agent did not know it had a scheduler, could not see it was in a
   * room, and did not know it could reach its user on Telegram. The sections
   * existed and were wired to one persona out of four.
   */
  check('there are personas to check', PERSONAS.length >= 4);

  for (const persona of PERSONAS) {
    const text = persona.build(RICH);

    check(`${persona.id}: knows its name`, text.includes('Local Infrastructure Eye'));
    check(`${persona.id}: knows its handle`, text.includes('@infra'));
    check(`${persona.id}: knows the machine`, text.includes('evtinsait-host1'));
    check(`${persona.id}: knows about WispCrew`, text.includes('## What WispCrew is'));
    check(`${persona.id}: knows its routines`, text.includes('Nightly scan'));
    check(`${persona.id}: knows the room`, text.includes('@windows'));
    check(`${persona.id}: has its own purpose`, text.includes('## Your purpose'));
  }
}

console.log('\n[routes] who is present, and how');
{
  const text = personaById('general').build(RICH);

  // The route matters as much as the name: a person on Telegram is not
  // looking at the transcript, and an agent elsewhere cannot see these files.
  check('a person is described as a person', text.includes('a person, at the app'));
  check('their other door is named', text.includes('reachable on Telegram'));
  check('a remote agent is marked remote', text.includes('an agent on another machine'));
  check('the agent recognises itself', /\(@infra\) — you/.test(text));
  check('the room mode is explained', text.includes('Addressed agents speak'));
}

console.log('\n[no drift] nothing is claimed that was not supplied');
{
  /*
   * The other half of the rule. A prompt built with nothing must not invent
   * a machine, a model, a workspace or a room.
   */
  const bare = personaById('general').build({ agentName: 'Assistant' });

  check('no machine is invented', !bare.includes('evtinsait'));
  check('no model is invented', !/Your model is/.test(bare));
  check('no workspace is invented', !/confined to/.test(bare));
  check('no room is invented', !bare.includes('Who is in this conversation'));
  check('no routines are invented', !bare.includes('Already scheduled'));
  check('no channels are invented', !bare.includes('you can still reach them'));

  // But the things that are always true are still said.
  check('it still says what WispCrew is', bare.includes('## What WispCrew is'));
  check('and that the conversation persists', bare.includes('saved and reloaded'));
}

console.log('\n[a lone agent] is not told it is in a room with itself');
{
  const alone = personaById('general').build({
    ...RICH,
    room: { participants: [{ kind: 'agent', name: 'Solo', handle: 'solo' }] },
  });
  check('one participant means no room section',
    !alone.includes('Who is in this conversation'));
}

console.log('\n[custom description] the user leads, the facts follow');
{
  /*
   * A user's own instructions REPLACE the persona. That once meant an agent
   * with standing instructions knew nothing about routines or persistence.
   */
  const facts = environmentFacts(RICH);

  check('the facts stand alone', facts.includes('## Where you are running'));
  check('and carry the room', facts.includes('@windows'));
  check('and the product', facts.includes('## What WispCrew is'));

  // But NOT the persona's working style — that is what was replaced.
  check('without a purpose section', !facts.includes('## Your purpose'));
}

console.log('\n[the lesson] capabilities are answered from the list');
{
  const text = personaById('general').build(RICH);
  check('it is told not to suggest an external scheduler',
    text.includes('Do not suggest an'));
  check('and that notifying is for interrupting',
    text.includes('interrupting, not answering'));
}

console.log('');
if (failures) {
  console.error(`PROMPT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('PROMPT TEST PASSED\n');
