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
import { fileURLToPath } from 'node:url';
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

console.log('\n[find my chat] a reason, not a shrug');
{
  /*
   * Reported: a bot created, /start and two messages sent, "Find my chat"
   * pressed, and the answer was "No message found. Send your bot something
   * first, then try again" — the one piece of advice that could not help.
   *
   * The real cause was that NO TOKEN had ever been stored. The Settings
   * panel wrote `configured: true` whenever Save was pressed, with or
   * without a token attached, and the field then read "saved; enter a new
   * one to replace it". Measured on the reporter's profile: the settings
   * file said configured, the encrypted store held no token, and its file
   * had not been written for a week.
   */
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

  /*
   * Both hosts derive it, through one function.
   *
   * The desktop and the daemon each build their own settings view, and only
   * the desktop's was fixed first — so the app told the truth while any
   * client connecting to the same node still saw the lie. Checking both is
   * the whole point: this bug IS two records of one fact.
   */
  const notify = read('packages/runtime/src/notify-host.ts');
  check('the runtime owns the derivation',
    /export function hasTelegramToken/.test(notify) &&
      /export function withTelegramTruth/.test(notify));

  for (const [label, file] of [
    ['the desktop view', 'apps/desktop/src/main/bridge-host.ts'],
    ['the daemon view', 'apps/daemon/src/methods.ts'],
  ]) {
    check(`${label} derives configured`, /withTelegramTruth\(/.test(read(file)),
      'this view can still claim a token that is not there');
  }

  const bridge = read('apps/desktop/src/main/bridge-host.ts');
  check('and a missing token is named as such', /No bot token is saved yet/.test(bridge));

  /*
   * Four different situations used to arrive as the same empty answer: no
   * token, a rejected token, something else already reading the bot, and
   * genuinely no messages. Only the last matched what the UI said.
   */
  const channel = read('packages/runtime/src/channel-telegram.ts');
  check('a rejected token says so', /Telegram rejected this bot token/.test(channel));
  check('a competing reader says so', /already receiving this bot/.test(channel));
  check('an unreachable API says so', /Could not reach Telegram:/.test(channel));
  check('and "no messages" keeps its own advice',
    /no recent messages for this bot/.test(channel));

  // Telegram answers 200 with ok:false for some failures, so both are read.
  check('both failure shapes are checked',
    /!response\.ok \|\| payload\.ok === false/.test(channel));

  const panels = read('apps/desktop/src/renderer/Panels.tsx');
  check('the panel shows the reason it was given', /text: found\.error \?\?/.test(panels),
    'the panel still invents its own explanation');

  /*
   * And saving the settings must START the listener.
   *
   * `startTelegram()` ran once at daemon boot and nothing called it again,
   * so connecting Telegram looked complete — token stored, chat id found,
   * channel ticked — with no listener anywhere. A `/connect` typed in the
   * chat reached nothing until the daemon happened to restart, which
   * nobody would think to do.
   *
   * The same shape as the routine that needed a reload: something changed
   * and the part that must act on it was never told.
   */
  const nodeMethodsSrc = read('apps/daemon/src/methods.ts');
  check('saving telegram settings starts the listener',
    /startTelegram\(\);/.test(nodeMethodsSrc),
    'the settings are stored and nothing listens');

  /*
   * And ONLY the node does it. Telegram allows one reader per bot and
   * answers a second with 409, so a desktop that also started one would
   * fight the daemon for every message.
   */
  const bridge2 = read('apps/desktop/src/main/bridge-host.ts');
  check('and the desktop does not start a second one',
    !/startTelegram\(/.test(bridge2),
    'two pollers on one bot means 409 and stolen updates');

  /*
   * The commands themselves, which are how a chat is attached to a room.
   * Verified live against the real handler: /here reports nothing, /connect
   * binds, /here then names the room.
   */
  const tgHost = read('packages/runtime/src/telegram-host.ts');
  check('connect, disconnect and here all exist',
    /\/\^\\\/\(connect\|disconnect\|here\)/.test(tgHost) ||
      /connect\|disconnect\|here/.test(tgHost));
  check('and connect with no name lists the choices',
    /Which conversation\?/.test(tgHost));
}

console.log('');
if (failures) {
  console.error(`TELEGRAM-INBOUND TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('TELEGRAM-INBOUND TEST PASSED\n');
