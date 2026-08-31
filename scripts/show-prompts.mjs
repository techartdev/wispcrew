/**
 * show-prompts.mjs — print the system prompts as the model receives them.
 *
 * A prompt read only in source is a prompt nobody checks. The persona
 * purposes are static text, but everything around them is assembled at run
 * time from real state — so what a model actually sees exists nowhere in
 * this repository as a single string.
 *
 * This renders them. Run it to read what an agent is really told.
 */
import { PERSONAS, personaById, environmentFacts } from '../packages/core/dist/index.js';

const rule = (title) => {
  console.log('');
  console.log('='.repeat(76));
  console.log('  ' + title);
  console.log('='.repeat(76));
};

/* A realistic set of facts: an agent on a VPS, in a room, with a routine. */
const RICH = {
  agentName: 'Local Infrastructure Eye',
  handle: 'infra',
  modelHint: 'nvidia/nemotron-3-nano-30b-a3b',
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

rule('THE PERSONAS — only the PURPOSE differs; everything else is composed');
for (const persona of PERSONAS) {
  console.log('');
  console.log(`  ${persona.id.padEnd(12)} ${persona.label}`);
  console.log(`  ${''.padEnd(12)} ${persona.description}`);
}

rule('general — a lone agent, nothing configured');
console.log(personaById('general').build({ agentName: 'Assistant' }));

rule('general — an agent on a VPS, in a room, with a routine');
console.log(personaById('general').build(RICH));

rule('coding — the SAME facts, a different purpose');
console.log(personaById('coding').build(RICH));

/*
 * A user's own instructions REPLACE the persona. That once meant an agent
 * with standing instructions knew nothing about routines or persistence and
 * would confidently tell its user it had no scheduler. Their words lead;
 * the facts are appended, because they are true either way.
 */
rule('A CUSTOM DESCRIPTION — the user leads, the facts follow');
console.log('You are my local eye on the home network. Keep answers short.');
console.log('');
console.log(environmentFacts(RICH));
console.log('');
