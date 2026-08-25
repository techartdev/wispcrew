/**
 * telegram-routing-test.mjs — the endpoint is the address.
 *
 * The first version kept a `telegramRoom` setting: the last room somebody
 * chose with `/room`. That works with one conversation and misroutes with
 * several — a reply typed into what the user believes is the release
 * discussion lands wherever the pointer was last moved, silently.
 *
 * An outside review named this exactly, and it was right. Routing is now a
 * lookup on (chat, thread), which every Telegram update already carries.
 *
 * Offline: the Telegram API is stubbed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authorOfTelegramMessage,
  bindEndpoint,
  conversationFor,
  createAgentWithRoom,
  createNodeCrypto,
  endpointsFor,
  handleInbound,
  initStore,
  listBindings,
  recordTelegramAuthor,
  setHost,
  sharingWarning,
  unbindEndpoint,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-tgr-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push({
    method: String(url).split('/').pop().split('?')[0],
    ...(init?.body ? JSON.parse(init.body) : {}),
  });
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 900 + sent.length } }) };
};

const backend = createAgentWithRoom({ name: 'Backend' });
const release = createAgentWithRoom({ name: 'Release' });
const research = createAgentWithRoom({ name: 'Research' });

console.log('\n[bindings] an endpoint maps to exactly one room');
{
  bindEndpoint({ conversationId: backend.id, endpoint: { chatId: '-100777', threadId: 77 }, label: '#backend' });
  bindEndpoint({ conversationId: release.id, endpoint: { chatId: '-100777', threadId: 81 }, label: '#release' });
  bindEndpoint({ conversationId: research.id, endpoint: { chatId: '555', threadId: 13 }, label: 'research' });

  check('a topic resolves', conversationFor({ chatId: '-100777', threadId: 77 }) === backend.id);
  // The whole point: two topics in the SAME group are different rooms.
  check('a sibling topic resolves differently',
    conversationFor({ chatId: '-100777', threadId: 81 }) === release.id);
  check('and a private topic too', conversationFor({ chatId: '555', threadId: 13 }) === research.id);

  // A group with no topic is not "topic zero".
  check('the group itself is unbound', conversationFor({ chatId: '-100777' }) === undefined);
  check('and an unknown topic is unbound',
    conversationFor({ chatId: '-100777', threadId: 99 }) === undefined);
}

console.log('\n[rebinding] moving a topic replaces rather than duplicates');
{
  bindEndpoint({ conversationId: research.id, endpoint: { chatId: '-100777', threadId: 77 } });
  check('the topic now points elsewhere',
    conversationFor({ chatId: '-100777', threadId: 77 }) === research.id);
  check('and there is still one binding for it',
    listBindings().filter((b) => b.endpoint.threadId === 77).length === 1);

  bindEndpoint({ conversationId: backend.id, endpoint: { chatId: '-100777', threadId: 77 }, label: '#backend' });
}

console.log('\n[THE BUG] a message goes to its own room, not the last one used');
{
  /*
   * The failure the old design guaranteed: send to #backend, then send to
   * #release, and watch the second answer arrive in the first room.
   */
  const ran = [];
  const deps = {
    token: 'tok',
    chatId: '-100777',
    run: async (agentId) => {
      ran.push(agentId);
    },
  };

  await handleInbound(
    { messageId: 1, chatId: '-100777', threadId: 77, text: 'check the API', fromId: '5', date: 1 },
    deps,
  );
  await handleInbound(
    { messageId: 2, chatId: '-100777', threadId: 81, text: 'when do we ship?', fromId: '5', date: 1 },
    deps,
  );

  check('the first went to Backend', ran[0] === backend.id, ran[0]);
  check('the second went to Release', ran[1] === release.id, ran[1]);
  check('with no remembered state involved', ran.length === 2);
}

console.log('\n[unbound] an unknown chat is told, not answered');
{
  sent.length = 0;
  const ran = [];
  await handleInbound(
    { messageId: 3, chatId: '-100999', threadId: 5, text: 'hello?', fromId: '5', date: 1 },
    { token: 'tok', chatId: '-100999', run: async (id) => ran.push(id) },
  );

  // Answering into an arbitrary room is worse than answering nowhere.
  check('nothing ran', ran.length === 0);
  check('and the user is told', /not connected/i.test(sent.find((s) => s.method === 'sendMessage')?.text ?? ''),
    sent[0]?.text);
}

console.log('\n[topics] the reply goes back into the topic it came from');
{
  sent.length = 0;
  await handleInbound(
    { messageId: 4, chatId: '-100777', threadId: 81, text: 'status?', fromId: '5', date: 1 },
    { token: 'tok', chatId: '-100777', run: async () => {} },
  );

  const placeholder = sent.find((s) => s.method === 'sendMessage');
  // Without this a group's answers all pile into the main view.
  check('the placeholder carries the topic', placeholder?.message_thread_id === 81,
    String(placeholder?.message_thread_id));
}

console.log('\n[reply addressing] replying to an agent addresses that agent');
{
  recordTelegramAuthor({ messageId: 944, chatId: '-100777', agentId: backend.id });
  check('the author is remembered', authorOfTelegramMessage(944) === backend.id);
  check('an unknown message has none', authorOfTelegramMessage(1) === undefined);
}

console.log('\n[sharing] a second door is called out');
{
  const room = { id: backend.id, title: 'Backend', participants: [], mode: 'open', createdAt: 1, updatedAt: 1 };

  check('the first door needs no warning', sharingWarning(room, []) === undefined);

  /*
   * A room reachable from a private topic AND a company group means a
   * message typed in either is visible in both. Correct per the model, and
   * surprising enough to be a security incident if nobody says so.
   */
  const warning = sharingWarning(room, endpointsFor(backend.id));
  check('a second door warns', typeof warning === 'string', warning);
  check('naming where it is already reachable', /#backend/.test(warning ?? ''), warning);
}

console.log('\n[unbinding] removing a door leaves the room alone');
{
  unbindEndpoint({ chatId: '555', threadId: 13 });
  check('the endpoint is gone', conversationFor({ chatId: '555', threadId: 13 }) === undefined);
  check('but the others remain', conversationFor({ chatId: '-100777', threadId: 77 }) === backend.id);
}

globalThis.fetch = realFetch;
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`TELEGRAM-ROUTING TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('TELEGRAM-ROUTING TEST PASSED\n');
