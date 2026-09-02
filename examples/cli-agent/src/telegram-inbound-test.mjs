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
  bindEndpoint,
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

/*
 * Each message gets a distinct id, as Telegram gives them.
 *
 * This fixture used to hardcode `messageId: 1`. That was harmless until
 * turns became durable: the entry id is derived from the chat and message
 * id, so every message in the suite claimed the same turn and everything
 * after the first was correctly refused as a replay. The behaviour was
 * right and the fixture was lying — a real Telegram message id increments.
 */
let nextMessageId = 1;

const inbound = (text, extra = {}) => ({
  messageId: nextMessageId++,
  chatId: '123',
  text,
  fromId: '456',
  date: Math.floor(Date.now() / 1000),
  ...extra,
});

const agent = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Assistant' });
migrateAgentsToConversations();
const room = listConversations()[0];

// The chat is a door onto this room. Without a binding an unbound chat is
// correctly told it is not connected, rather than answered into whichever
// room happened to be last.
bindEndpoint({ conversationId: room.id, endpoint: { chatId: '123' }, label: 'test chat' });

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

/*
 * `/rooms` and `/room` are gone.
 *
 * Routing is a lookup on (chat, thread) — see telegram-routing-test.mjs,
 * which also pins the misrouting the old selection mechanism guaranteed:
 * two topics in one group are two rooms, with nothing remembered between
 * messages.
 */

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

console.log('\n[replay] the same Telegram message is not acted on twice');
{
  /*
   * The inbox redelivers anything it has not acknowledged, so the same
   * message genuinely arrives again after a reconnect. Stable entry ids keep
   * the transcript clean; the turn claim is what stops the WORK repeating —
   * and on this path that could be a deploy.
   */
  const message = inbound('run the deploy');

  let runs = 0;
  const deps = {
    token: 'tok',
    chatId: '123',
    run: async () => {
      runs++;
    },
  };

  await handleInbound(message, deps);
  await handleInbound(message, deps);

  check('the agent ran once', runs === 1, String(runs));

  // A different message with the same text is a new instruction, not a
  // replay, and must run.
  await handleInbound(inbound('run the deploy'), deps);
  check('but a genuinely new message still runs', runs === 2, String(runs));
}

globalThis.fetch = realFetch;
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`TELEGRAM-INBOUND TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('TELEGRAM-INBOUND TEST PASSED\n');
