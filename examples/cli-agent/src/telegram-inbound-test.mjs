/**
 * telegram-inbound-test.mjs — a phone is a door, not a second conversation.
 *
 * The point of two-way Telegram is that a reply typed on a train is the
 * user's OWN turn in the same room. A side-channel bot with its own memory
 * would be a different and worse product: the user would repeat context
 * every time they moved between devices.
 *
 * Offline: the Telegram API is stubbed, the engine is a spy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgent,
  createNodeCrypto,
  handleInbound,
  initStore,
  listConversations,
  loadTranscript,
  LOCAL_HUMAN_ID,
  migrateAgentsToConversations,
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-tg-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

/*
 * Stub Telegram entirely.
 *
 * The suite must not touch the network, and the interesting behaviour is
 * what we SEND, which a stub records exactly.
 */
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop().split('?')[0];
  const body = init?.body ? JSON.parse(init.body) : {};
  sent.push({ method, ...body });
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 999 } }),
    text: async () => '',
  };
};

const inbound = (text, extra = {}) => ({
  messageId: 1,
  chatId: '123',
  text,
  fromId: '456',
  date: Math.floor(Date.now() / 1000),
  ...extra,
});

const agent = createAgent({ name: 'Assistant' });
migrateAgentsToConversations();
const room = listConversations()[0];

console.log('\n[a message becomes the user\'s own turn]');
{
  sent.length = 0;
  let ran = null;
  const result = await handleInbound(inbound('check the build'), {
    token: 'tok',
    chatId: '123',
    run: async (agentId, prompt) => {
      ran = { agentId, prompt };
    },
  });

  check('it was handled', result.handled === true);
  check('the agent ran', ran?.agentId === agent.id, JSON.stringify(ran));
  check('with the text as the prompt', ran?.prompt === 'check the build');

  const transcript = loadTranscript(room.id);
  const user = transcript.find((e) => e.kind === 'message' && e.role === 'user');
  check('the message is in the room', Boolean(user));
  // This is what makes the desktop show "You · via Telegram" rather than a
  // message from a bot.
  check('attributed to the person', user?.authorId === LOCAL_HUMAN_ID, user?.authorId);
  check('and to the door it came through', user?.via === 'telegram', user?.via);
}

console.log('\n[progress] work is visible in a medium with no streaming');
{
  // A five-minute turn is otherwise five minutes of silence, and a user
  // reasonably concludes their agent is broken.
  const placeholder = sent.find((s) => s.method === 'sendMessage' && /Working/.test(s.text ?? ''));
  check('a placeholder is sent', Boolean(placeholder), JSON.stringify(sent.map((s) => s.method)));
  check('quietly, so it does not buzz', placeholder?.disable_notification === true);
  check('naming the agent', /Assistant/.test(placeholder?.text ?? ''));

  // And the answer replaces it rather than arriving as a second message.
  const edit = sent.find((s) => s.method === 'editMessageText');
  check('the answer edits the placeholder', Boolean(edit));
}

console.log('\n[rooms] the phone can be pointed at a conversation');
{
  const second = createAgent({ name: 'Local Infrastructure Eye' });
  migrateAgentsToConversations();

  sent.length = 0;
  const listed = await handleInbound(inbound('/rooms'), { token: 'tok', chatId: '123' });
  check('/rooms is answered', listed.handled === true);
  const reply = sent.find((s) => s.method === 'sendMessage');
  check('naming both rooms',
    /Assistant/.test(reply?.text ?? '') && /Infrastructure/.test(reply?.text ?? ''),
    reply?.text);

  sent.length = 0;
  let ran = null;
  await handleInbound(inbound('/room Infrastructure'), {
    token: 'tok',
    chatId: '123',
    run: async (agentId) => { ran = agentId; },
  });
  check('/room switches', sent.some((s) => /Now talking in/.test(s.text ?? '')),
    JSON.stringify(sent.map((s) => s.text).slice(0, 2)));
  // A switch is a command, not something to answer.
  check('and does not run a turn', ran === null, String(ran));

  // The choice persists, so the next message goes to the new room.
  ran = null;
  await handleInbound(inbound('what is up'), {
    token: 'tok',
    chatId: '123',
    run: async (agentId) => { ran = agentId; },
  });
  check('the next message goes there', ran === second.id, `${ran} vs ${second.id}`);
}

console.log('\n[unknown room] a bad name lists the real ones');
{
  sent.length = 0;
  await handleInbound(inbound('/room nonsense'), { token: 'tok', chatId: '123' });
  const reply = sent.find((s) => s.method === 'sendMessage');
  check('it says no match', /No conversation matches/.test(reply?.text ?? ''), reply?.text);
  check('and offers the alternatives', /Assistant/.test(reply?.text ?? ''));
}

console.log('\n[failure] a turn that throws still reports back');
{
  sent.length = 0;
  await handleInbound(inbound('do something'), {
    token: 'tok',
    chatId: '123',
    run: async () => {
      throw new Error('provider unreachable');
    },
  });
  // Silence after a failure is the worst outcome: the user cannot tell
  // whether it worked, is still running, or died.
  const told = sent.some((s) => /Could not finish/.test(s.text ?? ''));
  check('the user is told', told, JSON.stringify(sent.map((s) => s.text).slice(0, 3)));
  check('with the reason', sent.some((s) => /provider unreachable/.test(s.text ?? '')));
}

globalThis.fetch = realFetch;
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`TELEGRAM-INBOUND TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('TELEGRAM-INBOUND TEST PASSED\n');
