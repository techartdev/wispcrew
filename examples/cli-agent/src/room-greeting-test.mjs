/**
 * room-greeting-test.mjs — the one piece of content a room owns.
 *
 * A room carries its tone, its purpose and why these particular agents are
 * here. The design decision worth pinning is not that it exists but that it
 * is **visible to everyone who has joined** — the agents and the user alike.
 *
 * That is not decoration. A hidden system instruction means the user reads a
 * reply shaped by a rule they cannot find, and an agent asked "what were you
 * told?" has to deflect. A rule nobody can see is a rule nobody can correct.
 * So the greeting is stored in the room, shown in the room pane, and placed
 * in the prompt with an explicit line saying the user can read it too.
 *
 * Offline: store and prompt construction, plus a source read for the
 * announcement wiring.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSystemPrompt, personaById } from '@wispcrew/core';
import {
  createAgent,
  createConversation,
  createNodeCrypto,
  createRoom,
  getConversation,
  initStore,
  removeParticipant,
  setHost,
  setRoomGreeting,
  LOCAL_HUMAN_ID,
} from '@wispcrew/runtime';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-greeting-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

console.log('\n[stored] the room owns it, not an agent');
{
  const a = createAgent({ name: 'Builder' });
  const b = createAgent({ name: 'Reviewer' });

  const room = createRoom({
    title: 'Deploy review',
    members: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }],
    greeting: 'Blunt and short. We are reviewing a deploy, not designing one.',
  });

  check('saved with the room', /Blunt and short/.test(room.greeting ?? ''), room.greeting);
  check('and survives a reload', /Blunt and short/.test(getConversation(room.id)?.greeting ?? ''));

  /*
   * On the ROOM. If it lived on an agent it would follow that agent into
   * every other conversation, which is precisely the coupling this
   * restructure removes.
   */
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8'));
  check('and nowhere on the agents', !JSON.stringify(stored).includes('Blunt and short'));
}

console.log('\n[editing] set, replace, clear');
{
  const room = createRoom({
    title: 'Ops',
    members: [{ id: 'a1', name: 'One' }, { id: 'a2', name: 'Two' }],
  });

  check('a new room may have none', room.greeting === undefined, String(room.greeting));

  setRoomGreeting(room.id, '  Keep it factual.  ');
  check('whitespace is trimmed', getConversation(room.id)?.greeting === 'Keep it factual.',
    JSON.stringify(getConversation(room.id)?.greeting));

  setRoomGreeting(room.id, 'Actually, be thorough.');
  check('replacing works', getConversation(room.id)?.greeting === 'Actually, be thorough.');

  /*
   * Empty means CLEARED, not "a greeting made of nothing". A blank greeting
   * would still print an empty instructions block into every member's
   * prompt — a heading promising rules, followed by none.
   */
  setRoomGreeting(room.id, '   ');
  check('an empty string clears it', getConversation(room.id)?.greeting === undefined,
    JSON.stringify(getConversation(room.id)?.greeting));
}

console.log('\n[prompt] every member reads it, and is told the user can too');
{
  const prompt = defaultSystemPrompt({
    persistent: true,
    agentName: 'Builder',
    handle: 'builder',
    room: {
      title: 'Deploy review',
      greeting: 'Blunt and short. We are reviewing a deploy, not designing one.',
      participants: [
        { kind: 'human', name: 'You', via: 'a person, at the app' },
        { kind: 'agent', name: 'Builder', handle: 'builder' },
        { kind: 'agent', name: 'Reviewer', handle: 'reviewer', via: 'an agent on this machine' },
      ],
    },
  });

  check('the room is named', /## This room: Deploy review/.test(prompt));
  check('the instructions are quoted verbatim', prompt.includes('Blunt and short'));

  /*
   * The load-bearing sentence. Without it a model treats standing
   * instructions as confidential by default and deflects when the user asks
   * what it was told — which is exactly the opacity this design rejects.
   */
  check('and are stated as visible', /Everyone who has joined can see/i.test(prompt));
  check('the user is named as a reader', /the user included/i.test(prompt));
  check('and they are not confidential', /not confidential/i.test(prompt));
  check('the agent may say what they are', /say what\s+they are if you are asked/i.test(prompt));
  // An instruction an agent cannot dispute is an instruction nobody can fix.
  check('and may push back on them', /speak up if one of them is wrong/i.test(prompt));

  // Both halves are present, and the frame comes before the cast.
  check('who is here is still listed', /Who is in this conversation/.test(prompt));
  check('but the purpose comes first',
    prompt.indexOf('## This room') < prompt.indexOf('## Who is in this conversation'));
}

console.log('\n[alone] a direct chat is untouched');
{
  const prompt = defaultSystemPrompt({
    persistent: true,
    agentName: 'Assistant',
    handle: 'assistant',
    room: {
      participants: [
        { kind: 'human', name: 'You', via: 'a person, at the app' },
        { kind: 'agent', name: 'Assistant', handle: 'assistant' },
      ],
    },
  });

  check('no room section at all', !/## This room|Who is in this conversation/.test(prompt));
  check('but the environment is still described', /## Where you are running/.test(prompt));
}

console.log('\n[survivor] a group down to one member keeps its instructions');
{
  /*
   * A head count would drop the greeting here, changing how the remaining
   * agent behaves for a reason nobody could see on screen. The prompt
   * renders the instructions and the cast independently.
   */
  const prompt = defaultSystemPrompt({
    persistent: true,
    agentName: 'Builder',
    handle: 'builder',
    room: {
      title: 'Deploy review',
      greeting: 'Blunt and short.',
      participants: [
        { kind: 'human', name: 'You', via: 'a person, at the app' },
        { kind: 'agent', name: 'Builder', handle: 'builder' },
      ],
    },
  });

  check('the instructions survive', /Blunt and short/.test(prompt));
  // One agent is not company, so listing "who is here" would still be noise.
  check('without listing a room of one', !/Who is in this conversation/.test(prompt));
}

console.log('\n[every persona] not just the default one');
{
  for (const id of ['general', 'concise', 'coding', 'researcher']) {
    const prompt = personaById(id).build({
      agentName: 'X',
      handle: 'x',
      room: {
        title: 'R',
        greeting: 'House rule: cite the file.',
        participants: [
          { kind: 'agent', name: 'X', handle: 'x' },
          { kind: 'agent', name: 'Y', handle: 'y' },
        ],
      },
    });
    check(`${id} reads the room's rules`, prompt.includes('House rule: cite the file.'));
  }
}

console.log('\n[the engine supplies it] not just the prompt accepting it');
{
  /*
   * The prompt can render a greeting it is given; the question is whether
   * anything gives it one. Checked in source because the alternative is a
   * live model call — and this is exactly the seam where a feature passes
   * every test and does nothing on screen.
   */
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');
  check('the engine passes the greeting into the prompt', /greeting,/.test(engine));
  check('and a greeting alone is reason enough to build a room section',
    /agentCount > 1 \|\| greeting/.test(engine));
}

console.log('\n[announced] editing it reaches an open window');
{
  /*
   * The bug class that has cost this session the most: a change made where
   * a call is ANSWERED must be announced from there. The daemon answers
   * these calls, and until now only `renameConversation` announced anything
   * — by borrowing `agents-changed`, which happens to make the client
   * re-read rooms. Every other room edit announced nothing.
   */
  const methods = fs.readFileSync(path.join(repo, 'apps/daemon/src/methods.ts'), 'utf8');

  check('the node has a rooms announcement', /announceRooms/.test(methods));
  for (const method of [
    'addRoomAgent',
    'removeRoomParticipant',
    'setRoomMode',
    'setRoomGreeting',
    'renameConversation',
    'createRoom',
  ]) {
    const at = methods.indexOf(`${method}:`);
    const body = methods.slice(at, at + 900);
    check(`${method} announces`, at !== -1 && body.includes('announceRooms'));
  }

  const bridge = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/bridge-host.ts'), 'utf8');
  check('and so does the desktop bridge', /announceRooms/.test(bridge));

  const hook = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/useWispcrew.ts'), 'utf8');
  check('which the client listens for', /case 'rooms-changed'/.test(hook));
}

console.log('\n[no model] a room still configures nothing');
{
  /*
   * Re-checked here because the greeting is the first content a room owns,
   * and "somewhere to put room-level settings" is exactly where a model
   * default would be added next.
   */
  const bridge = fs.readFileSync(path.join(repo, 'packages/shared/src/bridge.ts'), 'utf8');
  const at = bridge.indexOf('createRoom(patch: {');
  const signature = bridge.slice(at, bridge.indexOf('}', at));
  check('createRoom takes no model', !/model|provider/i.test(signature), signature);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`ROOM GREETING TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM GREETING TEST PASSED\n');
