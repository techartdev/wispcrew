/**
 * mirror-test.mjs — what a connected Telegram chat sees from the desktop.
 *
 * `/connect` binds a chat to a conversation, which reads as "attach this
 * conversation" — but the binding was one-way. A message typed in Telegram
 * ran a turn and the answer came back there, because a reply goes to
 * wherever its message came from. Everything said on the DESKTOP side of the
 * same room was invisible from the phone: "why in telegram I do not see
 * anything written on desktop?"
 *
 * The choice, made by the person who asked: mirror people and answers, not
 * the machinery; split a long reply rather than truncate it.
 *
 * Offline: pure functions and source checks. Nothing here talks to Telegram.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldMirror, splitForTelegram } from '@wispcrew/runtime';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const message = (patch) => ({
  kind: 'message',
  id: 'e1',
  role: 'assistant',
  content: 'hi',
  createdAt: 1,
  ...patch,
});

console.log('\n[what crosses] people and answers');
{
  check('an agent\u2019s finished reply', shouldMirror(message({})));
  check('and what you typed here', shouldMirror(message({ role: 'user', content: 'go ahead' })));
}

console.log('\n[what does not] the machinery');
{
  /*
   * A busy agent makes dozens of these, and a phone that buzzes for every
   * shell command is a phone with notifications turned off by the evening.
   */
  check('not a tool card', !shouldMirror({ kind: 'tool-call', id: 't', createdAt: 1 }));
  check('not a notice', !shouldMirror({ kind: 'notice', id: 'n', text: 'x', createdAt: 1 }));
  check('not an approval', !shouldMirror({ kind: 'approval', id: 'a', createdAt: 1 }));

  // A half-written answer: the final push settles with isStreaming unset.
  check('not a streaming fragment', !shouldMirror(message({ isStreaming: true })));
  check('not an empty segment', !shouldMirror(message({ content: '   ' })));
}

console.log('\n[no echo] never send something back where it came from');
{
  /*
   * The user's own message is already on their screen — they typed it — and
   * the answer to a Telegram-initiated turn is delivered by
   * `telegram-progress`, which edits a placeholder in place. Mirroring
   * either would show it twice.
   */
  check('not your own message from there',
    !shouldMirror(message({ role: 'user', via: 'telegram' })));
  check('not the answer to a turn that started there',
    !shouldMirror(message({}), 'telegram'));
  // But an answer to a turn started HERE does cross.
  check('while an answer from the desktop does', shouldMirror(message({}), 'app'));
}

console.log('\n[long replies] split, never truncated');
{
  /*
   * Telegram rejects a message over 4096 characters with a 400 — it does
   * not truncate — so a long answer must be split or it never arrives.
   */
  const long = 'word '.repeat(1400);
  const parts = splitForTelegram(long);

  check('it is split', parts.length > 1, `${parts.length} parts`);
  check('every part fits', parts.every((p) => p.length <= 4096),
    String(Math.max(...parts.map((p) => p.length))));
  check('and nothing is lost',
    parts.join(' ').replace(/\s+/g, ' ').trim() === long.replace(/\s+/g, ' ').trim());

  // A short one is left alone rather than wrapped in machinery.
  check('a short reply stays one message', splitForTelegram('hello').length === 1);

  /*
   * An unbroken run longer than the limit — a base64 blob, a minified file —
   * has no good break, so it is cut. Losing it entirely would be worse.
   */
  const blob = 'x'.repeat(9000);
  const cut = splitForTelegram(blob);
  check('an unbreakable run is still delivered', cut.length === 3 &&
    cut.join('').length === 9000, `${cut.length} parts`);
}

console.log('\n[wiring] the origin travels with the entry');
{
  const transcript = read('packages/runtime/src/transcript.ts');
  check('pushTranscript takes an origin', /origin\?: ChannelId/.test(transcript));
  check('and mirrors from the one choke point', /void mirrorEntry\(agentId, entry/.test(transcript));
  // Not awaited: a slow Telegram must not hold up the turn that produced it.
  check('without blocking the turn', /void mirrorEntry/.test(transcript));

  const engine = read('packages/runtime/src/engine.ts');
  check('the engine passes the turn\u2019s channel',
    /pushTranscript\(outputId, entry, channel\)/.test(engine));

  const roomTurn = read('packages/runtime/src/room-turn.ts');
  check('and the room passes the message\u2019s', /\}, input\.channel\);/.test(roomTurn));
}

console.log('\n[the model] an agent can tell where you are');
{
  /*
   * `via` was recorded on every message since channels existed and dropped
   * when history was rebuilt, so the model never saw it — the same
   * declared-but-unused shape as `authorId` before it. An agent learned a
   * request came from Telegram only when a policy notice happened to say
   * so, which is luck rather than design.
   */
  const branching = read('packages/runtime/src/branching.ts');
  check('a message from elsewhere is marked', /\[via \$\{entry\.via\}\]/.test(branching));
  check('but the app is not', /entry\.via !== 'app'/.test(branching));
  check('and only for what a person said', /entry\.role === 'user' && entry\.via/.test(branching));
}

console.log('\n[staleness] a tool result carries its age');
{
  /*
   * Observed, and asked about directly: an agent listed the open pull
   * requests at 15:28, was asked "so is there new PRs or issues?" at 22:18,
   * and answered from the earlier output in FOUR SECONDS without checking
   * again — presenting seven-hour-old data as current.
   *
   * It could not have known. A tool result is a fact about the world at a
   * moment, the transcript records when, and `rebuildHistory` dropped it —
   * so a result from seven hours ago looked exactly like one from four
   * seconds ago. The same class as `via` and `authorId`: the record holds a
   * fact the model never receives.
   */
  const { rebuildHistory } = await import('@wispcrew/runtime');
  const now = Date.now();
  const call = (ago) => ({
    kind: 'tool-call',
    id: `t${ago}`,
    toolName: 'shell',
    args: {},
    status: 'completed',
    content: 'no open pull requests',
    createdAt: now - ago,
  });

  const last = (entries) => rebuildHistory(entries).at(-1).content;

  // A turn making six calls in ten seconds does not need each one labelled.
  check('a fresh result is not labelled', last([call(2_000)]) === 'no open pull requests');

  check('half an hour is', /^\[from 30 minutes ago\]/.test(last([call(30 * 60_000)])));
  check('and the case that caused this', /^\[from 7 hours ago\]/.test(last([call(7 * 3_600_000)])));
  check('and days, not 72 hours', /^\[from 3 days ago\]/.test(last([call(3 * 86_400_000)])));

  // Singular reads as English, because a model quoting it back should not
  // produce "1 hours ago".
  check('one hour is singular', /1 hour ago/.test(last([call(3_600_000)])));

  /*
   * An age needs a now. The prompt states the time from the host's own
   * knowledge, because a model cannot know it and guessing would be worse.
   */
  const prompt = read('packages/core/src/prompt.ts');
  check('and the prompt says what time it is', /The time is \$\{new Date\(\)\.toISOString\(\)\}/.test(prompt));
}

console.log('\n[the panel] the room says where it is reachable from');
{
  const pane = read('apps/desktop/src/renderer/RoomPane.tsx');
  check('the pane asks', /onEndpoints\(room\.id\)/.test(pane));
  check('and shows it', /Also reachable from/.test(pane));

  // Above the members, not among them: a chat is a DOOR into the room
  // rather than somebody standing in it.
  const css = read('apps/desktop/src/renderer/styles.css');
  check('with a style that exists', /\.room-pane-elsewhere \{/.test(css));
}

console.log('');
if (failures) {
  console.error(`MIRROR TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('MIRROR TEST PASSED\n');
