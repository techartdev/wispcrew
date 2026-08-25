/**
 * telegram-approval-test.mjs — asking the person who is actually there.
 *
 * A daemon denies approvals because nobody is attached to ask. That is right
 * by default and becomes wrong the moment a phone is a door into the room:
 * someone IS there, and they just sent the message.
 *
 * But approving over Telegram means a message can authorise a shell command
 * on the user's machine, so the window is deliberately narrow — and this
 * suite is mostly about the boundaries of that window rather than the happy
 * path.
 *
 * Offline: the Telegram API is stubbed.
 */
import {
  askViaTelegram,
  clearTelegramApprovals,
  currentApprovalAsker,
  pendingApprovalCount,
  resolveTelegramApproval,
  setApprovalAsker,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop().split('?')[0];
  sent.push({ method, ...(init?.body ? JSON.parse(init.body) : {}) });
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
};

const request = { toolName: 'shell', summary: 'Run npm test', detail: 'npm test --workspaces' };

console.log('\n[the prompt] says what is being authorised');
{
  sent.length = 0;
  const answer = askViaTelegram('tok', '123', 'Assistant', request);
  await new Promise((r) => setTimeout(r, 50));

  const prompt = sent.find((s) => s.method === 'sendMessage');
  check('a prompt is sent', Boolean(prompt));
  check('naming the agent', /Assistant/.test(prompt?.text ?? ''));
  check('and the tool', /shell/.test(prompt?.text ?? ''));
  // A user pressing Allow must be able to see WHAT they are allowing.
  check('and the command itself', /npm test/.test(prompt?.text ?? ''), prompt?.text);

  const buttons = prompt?.reply_markup?.inline_keyboard?.[0] ?? [];
  check('with two buttons', buttons.length === 2, String(buttons.length));
  check('allow and deny', /Allow/.test(buttons[0]?.text ?? '') && /Deny/.test(buttons[1]?.text ?? ''));

  // Resolve it so the promise does not dangle.
  const id = buttons[0].callback_data.split(':')[0];
  resolveTelegramApproval(`${id}:yes`);
  check('pressing Allow approves', (await answer) === true);
}

console.log('\n[deny] pressing Deny refuses');
{
  sent.length = 0;
  const answer = askViaTelegram('tok', '123', 'Assistant', request);
  await new Promise((r) => setTimeout(r, 50));

  const id = sent
    .find((s) => s.method === 'sendMessage')
    .reply_markup.inline_keyboard[0][0].callback_data.split(':')[0];

  resolveTelegramApproval(`${id}:no`);
  check('denied', (await answer) === false);
  check('and nothing is left waiting', pendingApprovalCount() === 0);
}

console.log('\n[stale] a button from an old prompt is refused politely');
{
  // Telegram spins the button until the query is acknowledged, so a stale
  // press must be answered rather than ignored.
  check('an unknown id does not match', resolveTelegramApproval('nope:yes') === false);
  check('and malformed data is safe', resolveTelegramApproval('') === false);
}

console.log('\n[unreachable] a prompt that cannot be sent is a denial');
{
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  // A request that cannot be put to the user is a request nobody approved.
  check('denied when Telegram is unreachable',
    (await askViaTelegram('tok', '123', 'A', request)) === false);

  globalThis.fetch = async (url, init) => {
    sent.push({ method: String(url).split('/').pop(), ...(init?.body ? JSON.parse(init.body) : {}) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
}

console.log('\n[abandoned] clearing denies whatever was waiting');
{
  const a = askViaTelegram('tok', '123', 'A', request);
  const b = askViaTelegram('tok', '123', 'A', request);
  await new Promise((r) => setTimeout(r, 50));
  check('two are waiting', pendingApprovalCount() === 2, String(pendingApprovalCount()));

  clearTelegramApprovals();
  // Silence is not consent, and neither is a listener shutting down.
  check('both are denied', (await a) === false && (await b) === false);
  check('and none remain', pendingApprovalCount() === 0);
}

console.log('\n[scoping] the asker can be installed and restored');
{
  /*
   * The security boundary: an asker installed for one turn must be removed
   * afterwards, so an agent waking on a SCHEDULE cannot prompt the phone
   * hours later. Without a getter there is nothing to restore to.
   */
  const original = currentApprovalAsker();
  check('the current asker is readable', typeof original === 'function');

  setApprovalAsker(async () => true);
  check('it can be replaced', (await currentApprovalAsker()('a', request)) === true);

  setApprovalAsker(original);
  check('and restored', currentApprovalAsker() === original);
}

globalThis.fetch = realFetch;

console.log('');
if (failures) {
  console.error(`TELEGRAM-APPROVAL TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('TELEGRAM-APPROVAL TEST PASSED\n');
