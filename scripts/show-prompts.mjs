/**
 * show-prompts.mjs — print the system prompts as the model receives them.
 *
 * A prompt read only in source is a prompt nobody checks. The four personas
 * are static text, but everything around them is assembled at run time from
 * real state — so what a model actually sees exists nowhere in this
 * repository as a single string.
 *
 * This renders them. Run it to read what an agent is really told.
 */
import { PERSONAS, personaById } from '../packages/core/dist/index.js';

const rule = (title) => {
  console.log('');
  console.log('='.repeat(74));
  console.log('  ' + title);
  console.log('='.repeat(74));
};

rule('THE FOUR PERSONAS — the only static text');
for (const persona of PERSONAS) {
  console.log('');
  console.log(`  ${persona.id.padEnd(12)} ${persona.label}`);
  console.log(`  ${''.padEnd(12)} ${persona.description}`);
}

rule('general — a lone agent, nothing configured');
console.log(personaById('general').build({ modelHint: 'nvidia/nemotron-3-nano-30b-a3b' }));

/*
 * Everything below the first line is assembled from REAL state: whether a
 * daemon is running, which routines exist, which channels are enabled, who
 * else is in the room. None of it is asserted in prose, so the description
 * cannot drift from what is true.
 */
rule('general — the same agent with routines and channels');
console.log(
  personaById('general').build({
    modelHint: 'nvidia/nemotron-3-nano-30b-a3b',
    persistent: true,
    routines: ['"Morning report" (0 9 * * 1-5)'],
    channels: ['Telegram', 'desktop notification'],
  }),
);

rule('general — in a room with other agents');
console.log(
  personaById('general').build({
    modelHint: 'nvidia/nemotron-3-nano-30b-a3b',
    persistent: true,
    room: { handle: 'builder', others: ['linux', 'windows'] },
  }),
);

rule('concise / coding / researcher');
for (const id of ['concise', 'coding', 'researcher']) {
  console.log('');
  console.log(`--- ${id} ${'-'.repeat(66 - id.length)}`);
  console.log(personaById(id).build({ modelHint: 'nvidia/nemotron-3-nano-30b-a3b' }));
}

/*
 * The composition rule worth knowing: a user's own instructions REPLACE the
 * persona entirely. That once meant an agent with standing instructions knew
 * nothing about routines or persistence, and would confidently tell its user
 * it had no scheduler. The environment block is now appended either way.
 */
rule('A CUSTOM DESCRIPTION replaces the persona, and keeps the facts');
const described = 'You are my local eye on the home network. Keep answers short.';
const generic = personaById('general').build({
  persistent: true,
  routines: ['"Nightly scan" (0 2 * * *)'],
});
const facts = generic
  .slice(generic.indexOf('## Your environment'), generic.indexOf('## How to work'))
  .trim();

console.log(`${described}\n\n${facts}`);
console.log('');
