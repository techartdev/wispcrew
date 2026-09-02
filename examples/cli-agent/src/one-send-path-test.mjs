/**
 * one-send-path-test.mjs — every way of sending shares one path.
 *
 * Three entry points could start a turn: the desktop composer, the daemon's
 * `sendPrompt`, and a Telegram message. Each wrote the user's entry and ran
 * the agent in its own way, and only the room path claimed a turn — so the
 * duplicate-suppression added last round was real for a message sent to a
 * room and absent for the identical message from the composer.
 *
 * A protection that covers some ways of doing the same thing is worse than
 * none, because it looks complete. This pins that they converge.
 *
 * Offline: source inspection plus a behavioural check.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentWithRoom,
  createNodeCrypto,
  initStore,
  listTurns,
  loadTranscript,
  LOCAL_HUMAN_ID,
  runRoomTurn,
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

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

console.log('\n[convergence] no host starts a turn on its own');
{
  /*
   * `runPrompt` is still the engine's entry point and is called legitimately
   * by delegation and by routines. What must not happen is a HOST calling it
   * for a user message, because that skips the claim.
   */
  const hosts = {
    'apps/desktop/src/main/bridge-host.ts': read('apps/desktop/src/main/bridge-host.ts'),
    'apps/daemon/src/methods.ts': read('apps/daemon/src/methods.ts'),
    'packages/runtime/src/telegram-host.ts': read('packages/runtime/src/telegram-host.ts'),
  };

  for (const [file, source] of Object.entries(hosts)) {
    const name = file.split('/').pop();
    check(`${name} routes through the room`, /runRoomTurn\(/.test(source));
    check(`${name} does not call runPrompt for a user message`,
      !/void runPrompt\(|await runPrompt\(/.test(source));
  }

  // The debug hook is deliberate: it drives a turn headlessly, bypassing the
  // UI on purpose, and is documented as such.
  const main = read('apps/desktop/src/main/main.ts');
  check('the AUTOSEND debug hook is the only exception',
    /WISPCREW_AUTOSEND/.test(main) && /runPrompt\(/.test(main));
}

console.log('\n[no double write] the room writes the entry, not the caller');
{
  /*
   * Both jobs belong to `runRoomTurn`. A host that also wrote the entry
   * would produce it twice — once with its own id, once with the room's.
   */
  const telegram = read('packages/runtime/src/telegram-host.ts');
  check('telegram no longer writes its own user entry',
    !/upsertTranscriptEntry\(room\.id, \{\s*kind: 'message',\s*id: store\.newId\('usr'\)/.test(telegram));

  const daemon = read('apps/daemon/src/methods.ts');
  check('the daemon no longer writes its own',
    !/pushTranscript\(agentId, \{\s*kind: 'message',\s*id: newId\('usr'\)/.test(daemon));
}

console.log('\n[attachments] the record survives the reroute');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-send-'));
  setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
  initStore(dir);

  const agent = createAgentWithRoom({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Reader' });

  await runRoomTurn({
    conversationId: agent.id,
    text: 'what is in this image?',
    speakerId: LOCAL_HUMAN_ID,
    attachments: [
      { name: 'shot.png', mimeType: 'image/png', size: 1234, kind: 'image', data: 'AAAA' },
    ],
    run: async () => {},
  });

  const entry = loadTranscript(agent.id).find((e) => e.kind === 'message' && e.role === 'user');

  /*
   * `sendPrompt` recorded this and `runRoomTurn` did not, so routing one
   * through the other would have silently dropped it: the image still
   * reaches the model, and the conversation stops showing it was sent.
   */
  check('the attachment is recorded', entry?.attachments?.length === 1,
    JSON.stringify(entry?.attachments));
  check('with its name', entry?.attachments?.[0]?.name === 'shot.png');
  // Base64 payloads would add megabytes per message to the transcript file.
  check('but not its data', entry?.attachments?.[0]?.data === undefined);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[claim] every path now produces a turn record');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-send2-'));
  setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
  initStore(dir);

  const agent = createAgentWithRoom({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Worker' });
  await runRoomTurn({
    conversationId: agent.id,
    text: 'go',
    speakerId: LOCAL_HUMAN_ID,
    run: async () => {},
  });

  const turns = listTurns(agent.id);
  check('a turn was recorded', turns.length === 1, String(turns.length));
  check('and completed', turns[0]?.state === 'completed', turns[0]?.state);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`ONE-SEND-PATH TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ONE-SEND-PATH TEST PASSED\n');
