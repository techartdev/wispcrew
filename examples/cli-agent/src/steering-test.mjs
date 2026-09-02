/**
 * steering-test.mjs — you can see what you typed, and speak mid-run.
 *
 * Three things a user reported, all of which were real:
 *
 *  1. A typed message never appeared in the chat. The daemon's `sendPrompt`
 *     called `runPrompt` directly, and only the desktop bridge had been
 *     recording the user's message — so once the desktop forwarded to a
 *     daemon, typed messages vanished.
 *  2. A second message could not be sent while the agent worked, because
 *     `sendPrompt` awaited the whole turn before returning.
 *  3. Switching agents showed a mixed conversation.
 *
 * Offline: exercises the method table and store, not a provider.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgent,
  createNodeCrypto,
  initStore,
  initGrants,
  loadTranscript,
  setHost,
} from '@wispcrew/runtime';
import { nodeMethods } from '@wispcrew/daemon/methods';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-steer-'));
setHost({
  dataDir: dir,
  defaultWorkspaceRoot: dir,
  nodeName: 'test',
  crypto: createNodeCrypto(dir),
});
initStore(dir);
initGrants(dir);

const alice = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Alice' });
const bob = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Bob' });
const methods = nodeMethods();

console.log('\n[1] a typed message is recorded before the turn runs');
{
  // No provider is configured, so the turn will fail — which is the point:
  // the user's message must be persisted regardless of what the model does.
  methods.sendPrompt(alice.id, 'my first message');

  const transcript = loadTranscript(alice.id);
  const mine = transcript.find(
    (e) => e.role === 'user' && String(e.content) === 'my first message',
  );
  check('it is in the transcript', Boolean(mine), JSON.stringify(transcript.map((e) => e.role)));
  check('recorded as a user message', mine?.kind === 'message');
}

console.log('\n[2] sending does not block on the turn');
{
  const started = Date.now();
  methods.sendPrompt(alice.id, 'a second message, sent immediately');
  const took = Date.now() - started;

  // The turn is started but deliberately not awaited, so this returns at once.
  check('the call returns promptly', took < 500, `${took}ms`);

  const transcript = loadTranscript(alice.id);
  const both = transcript.filter((e) => e.role === 'user');
  check('both messages are kept', both.length === 2, `${both.length} user entries`);
  check('in the order they were sent',
    String(both[0].content).includes('first') && String(both[1].content).includes('second'));
}

console.log('\n[3] agents keep separate conversations');
{
  methods.sendPrompt(bob.id, 'BOB_ONLY');

  const aliceT = loadTranscript(alice.id);
  const bobT = loadTranscript(bob.id);

  check("it lands in Bob's transcript", bobT.some((e) => String(e.content) === 'BOB_ONLY'));
  check("and not in Alice's", !aliceT.some((e) => String(e.content) === 'BOB_ONLY'),
    `alice: ${JSON.stringify(aliceT.map((e) => String(e.content).slice(0, 20)))}`);
  check("Alice's messages stayed hers", aliceT.filter((e) => e.role === 'user').length === 2);
}

console.log('\n[4] an empty message is ignored, not recorded');
{
  const before = loadTranscript(bob.id).length;
  methods.sendPrompt(bob.id, '   ');
  check('whitespace does not create an entry', loadTranscript(bob.id).length === before);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`STEERING TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('STEERING TEST PASSED\n');
