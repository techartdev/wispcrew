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

console.log('\n[connecting] a user can bind from inside the chat');
{
  /*
   * I replaced `/room` with a binding table and gave nobody a way to write
   * to it, so a topic could never be connected at all. Binding from inside
   * the chat is also better than a settings form: the endpoint is wherever
   * the message was typed, so there is nothing to identify by hand.
   */
  sent.length = 0;
  const fresh = { chatId: '-100888', threadId: 42 };
  check('the new topic starts unbound', conversationFor(fresh) === undefined);

  await handleInbound(
    { messageId: 10, chatId: '-100888', threadId: 42, text: '/connect Release', fromId: '5', date: 1 },
    { token: 'tok', chatId: '-100888' },
  );

  check('it is now bound', conversationFor(fresh) === release.id, conversationFor(fresh));
  check('and the user is told', /Connected to "Release"/.test(sent.at(-1)?.text ?? ''), sent.at(-1)?.text);
  // A reply must land in the topic it was asked in, not the main view.
  check('answering inside the topic', sent.at(-1)?.message_thread_id === 42);

  // Now real messages route there.
  const ran = [];
  await handleInbound(
    { messageId: 11, chatId: '-100888', threadId: 42, text: 'when do we ship?', fromId: '5', date: 1 },
    { token: 'tok', chatId: '-100888', run: async (id) => ran.push(id) },
  );
  check('and messages reach that room', ran[0] === release.id, ran[0]);
}

console.log('\n[connect] a bad name lists the alternatives');
{
  sent.length = 0;
  await handleInbound(
    { messageId: 12, chatId: '-100888', threadId: 43, text: '/connect nonsense', fromId: '5', date: 1 },
    { token: 'tok', chatId: '-100888' },
  );
  check('it says no match', /No conversation matches/.test(sent.at(-1)?.text ?? ''), sent.at(-1)?.text);
  check('and offers real ones', /Backend|Release/.test(sent.at(-1)?.text ?? ''));
  check('without binding anything', conversationFor({ chatId: '-100888', threadId: 43 }) === undefined);
}

console.log('\n[here] a chat can say what it is connected to');
{
  sent.length = 0;
  await handleInbound(
    { messageId: 13, chatId: '-100888', threadId: 42, text: '/here', fromId: '5', date: 1 },
    { token: 'tok', chatId: '-100888' },
  );
  check('it names the room', /This is "Release"/.test(sent.at(-1)?.text ?? ''), sent.at(-1)?.text);

  sent.length = 0;
  await handleInbound(
    { messageId: 14, chatId: '-100888', threadId: 44, text: '/here', fromId: '5', date: 1 },
    { token: 'tok', chatId: '-100888' },
  );
  check('and says when it is not connected', /Not connected/.test(sent.at(-1)?.text ?? ''));
}

console.log('\n[disconnect] a door can be removed from the chat');
{
  await handleInbound(
    { messageId: 15, chatId: '-100888', threadId: 42, text: '/disconnect', fromId: '5', date: 1 },
    { token: 'tok', chatId: '-100888' },
  );
  check('the binding is gone', conversationFor({ chatId: '-100888', threadId: 42 }) === undefined);
}

console.log('\n[missing topic] a deleted topic falls back to the main chat');
{
  /*
   * Measured against the real API: sending `message_thread_id` for a topic
   * that does not exist returns `Bad Request: message thread not found`.
   *
   * A binding outlives the topic it names — someone deletes it, or the chat
   * leaves topic mode — and without this every message in that room would
   * fail silently. The main view is visible and recoverable.
   */
  const attempts = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    attempts.push(body);

    if (body.message_thread_id !== undefined) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: false, description: 'Bad Request: message thread not found' }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };

  await handleInbound(
    { messageId: 20, chatId: '-100888', threadId: 777, text: '/here', fromId: '5', date: 1 },
    { token: 'tok', chatId: '-100888' },
  );

  check('it tried the topic first', attempts[0]?.message_thread_id === 777);
  // Retrying without the field is what keeps the conversation usable.
  check('then retried without it', attempts.length === 2 && attempts[1]?.message_thread_id === undefined,
    JSON.stringify(attempts.map((a) => a.message_thread_id)));

  /*
   * And only for THAT error. A blanket fallback would silently redirect
   * topic messages into the main chat whenever anything went wrong, which
   * is the documented Bot API 10 trap.
   */
  attempts.length = 0;
  globalThis.fetch = async (url, init) => {
    attempts.push(init?.body ? JSON.parse(init.body) : {});
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
    };
  };

  await handleInbound(
    { messageId: 21, chatId: '-100888', threadId: 777, text: '/here', fromId: '5', date: 1 },
    { token: 'tok', chatId: '-100888' },
  );
  check('a different error does not retry', attempts.length === 1, String(attempts.length));

  globalThis.fetch = saved;
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
