/**
 * floor-test.mjs — who speaks, and who merely listens.
 *
 * Everyone in a room sees every message. Acting is separate.
 *
 * Left alone, several helpful agents either all answer at once or wait for
 * each other and none does. Constrained too tightly, the user approves every
 * utterance until they stop reading. The rules between those extremes are
 * fiddly, and a bug here is expensive in tokens rather than merely wrong —
 * so they are tested exhaustively.
 *
 * Offline: pure decisions, no engine.
 */
import {
  DEFAULT_TURN_BUDGET,
  addressesEveryone,
  mentionsIn,
  rememberAddressee,
  routeAgentMessage,
  routeHumanMessage,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const ME = 'human:local';
const COLLEAGUE = 'human:sam';

const room = (patch = {}) => ({
  id: 'r1',
  title: 'Cross-platform test run',
  mode: 'open',
  createdAt: 1,
  updatedAt: 1,
  participants: [
    { kind: 'human', id: ME, name: 'You', channels: ['desktop'] },
    { kind: 'agent', id: 'a_win', handle: 'windows' },
    { kind: 'agent', id: 'a_lin', handle: 'linux' },
    { kind: 'agent', id: 'a_mac', handle: 'macos' },
  ],
  ...patch,
});

const handles = (r) => r.speakers.map((s) => s.handle).sort().join(',');

console.log('\n[mentions] finding who was addressed');
{
  check('a single mention', mentionsIn('@windows check the build').join() === 'windows');
  check('several', mentionsIn('@windows and @linux please').join() === 'windows,linux');
  check('case is ignored', mentionsIn('@Windows').join() === 'windows');
  check('duplicates collapse', mentionsIn('@linux @linux').join() === 'linux');
  // An email address should not read as a mention.
  check('mid-word is not a mention', mentionsIn('mail me at a@windows.com').join() === '');
  check('no mentions is empty', mentionsIn('what is the status').length === 0);

  check('@all addresses the room', addressesEveryone('@all status please'));
  check('so does @everyone', addressesEveryone('@everyone'));
  // Detected by an explicit marker only: guessing from phrasing would need
  // a model call before every turn, and a wrong guess wakes everybody.
  check('a plain question does not', !addressesEveryone('does this build on your platform?'));
}

console.log('\n[one agent] a normal chat is unchanged');
{
  const solo = room({
    participants: [
      { kind: 'human', id: ME, name: 'You', channels: ['desktop'] },
      { kind: 'agent', id: 'a1', handle: 'assistant' },
    ],
  });
  const r = routeHumanMessage({ conversation: solo, text: 'hello', speakerId: ME });
  check('the only agent answers', r.speakers.length === 1, String(r.speakers.length));
  check('with no ceremony', r.mayRequest.length === 0);
}

console.log('\n[tagging] naming an agent addresses it');
{
  const r = routeHumanMessage({ conversation: room(), text: '@windows check the build', speakerId: ME });
  check('only that agent speaks', handles(r) === 'windows', handles(r));
  // Anyone else piling in is exactly the noise being avoided.
  check('nobody else may request', r.mayRequest.length === 0);

  const two = routeHumanMessage({
    conversation: room(),
    text: '@windows and @linux compare notes',
    speakerId: ME,
  });
  check('tagging two wakes both', handles(two) === 'linux,windows', handles(two));
}

console.log('\n[@all] the room can be addressed');
{
  const r = routeHumanMessage({ conversation: room(), text: '@all does this build?', speakerId: ME });
  check('everyone speaks', r.speakers.length === 3, String(r.speakers.length));
}

console.log('\n[typo] a mention that matches nobody says so');
{
  const r = routeHumanMessage({ conversation: room(), text: '@windwos check', speakerId: ME });
  /*
   * Falling through to the last-addressed agent would answer as though the
   * user had not tried to direct it. They misspelled a handle and should
   * find out now, not after an agent did the wrong work.
   */
  check('nobody acts', r.speakers.length === 0);
  check('and the reason names the typo', /@windwos/.test(r.reason), r.reason);
}

console.log('\n[continuity] untagged continues with who you last addressed');
{
  const base = room();
  const patch = rememberAddressee(base, ME, 'a_lin');
  const after = { ...base, ...patch };

  const r = routeHumanMessage({ conversation: after, text: 'and the tests?', speakerId: ME });
  check('the previous agent continues', handles(r) === 'linux', handles(r));
  check('others may ask to add something', r.mayRequest.length === 2, String(r.mayRequest.length));
}

console.log('\n[per person] two humans do not share an addressee');
{
  /*
   * With two people present, "the last-addressed agent" has no single
   * answer. Inheriting a colleague's addressee would route your message to
   * an agent you were never talking to.
   */
  const shared = {
    ...room(),
    participants: [
      ...room().participants,
      { kind: 'human', id: COLLEAGUE, name: 'Sam', channels: ['desktop'] },
    ],
    lastAddressed: { [ME]: 'a_win', [COLLEAGUE]: 'a_mac' },
  };

  check('mine continues with mine',
    handles(routeHumanMessage({ conversation: shared, text: 'and now?', speakerId: ME })) === 'windows');
  check('theirs with theirs',
    handles(routeHumanMessage({ conversation: shared, text: 'and now?', speakerId: COLLEAGUE })) === 'macos');
}

console.log('\n[nobody addressed yet] the room asks rather than guesses');
{
  const r = routeHumanMessage({ conversation: room(), text: 'status?', speakerId: ME });
  // Waking three agents on a guess is the expensive mistake.
  check('nobody speaks', r.speakers.length === 0);
  check('but all may request', r.mayRequest.length === 3, String(r.mayRequest.length));
  check('and the reason is actionable', /tag an agent/.test(r.reason), r.reason);
}

console.log('\n[free mode] initiative is allowed when asked for');
{
  const r = routeHumanMessage({ conversation: room({ mode: 'free' }), text: 'status?', speakerId: ME });
  check('everyone may answer', r.speakers.length === 3, String(r.speakers.length));
  check('so requests are unnecessary', r.mayRequest.length === 0);
}

console.log('\n[directed mode] only tagging works');
{
  const directed = room({ mode: 'directed', lastAddressed: { [ME]: 'a_win' } });
  const r = routeHumanMessage({ conversation: directed, text: 'and the tests?', speakerId: ME });
  check('continuity still applies', handles(r) === 'windows', handles(r));
  // Requests are shown but never auto-granted, which is the whole point of
  // the mode; the list is still produced so the UI can offer them.
  check('others are listed as requesting', r.mayRequest.length === 2);
}

console.log('\n[THE LOOP] agents do not reply to agents by default');
{
  const r = routeAgentMessage({
    conversation: room(),
    text: 'I finished the build and it passed.',
    speakerId: ME,
    authorId: 'a_win',
  });
  // Two helpful agents replying to each other is an unbounded loop that
  // costs real money. This is the assertion that prevents it.
  check('nobody responds', r.speakers.length === 0);
  check('with a clear reason', /unless addressed/.test(r.reason), r.reason);
}

console.log('\n[collaboration] an agent may address another explicitly');
{
  const r = routeAgentMessage({
    conversation: room(),
    text: '@linux the failure looks platform-specific, can you check?',
    speakerId: ME,
    authorId: 'a_win',
  });
  check('the addressed agent acts', handles(r) === 'linux', handles(r));
  // An agent tagging itself must not trigger itself.
  const self = routeAgentMessage({
    conversation: room(),
    text: '@windows noting this for myself',
    speakerId: ME,
    authorId: 'a_win',
  });
  check('but not itself', self.speakers.length === 0);
}

console.log('\n[budget] a chain of mentions eventually stops');
{
  const r = routeAgentMessage({
    conversation: room(),
    text: '@linux keep going',
    speakerId: ME,
    authorId: 'a_win',
    agentTurnsSoFar: DEFAULT_TURN_BUDGET,
  });
  /*
   * The backstop that makes `free` safe to offer. Even with
   * no-reply-by-default, explicit mentions can chain — and the failure
   * should be a pause, not a bill.
   */
  check('the room stops', r.speakers.length === 0);
  check('and says why', r.budgetExhausted === true);
  check('naming the count', new RegExp(String(DEFAULT_TURN_BUDGET)).test(r.reason), r.reason);

  const under = routeAgentMessage({
    conversation: room(),
    text: '@linux keep going',
    speakerId: ME,
    authorId: 'a_win',
    agentTurnsSoFar: DEFAULT_TURN_BUDGET - 1,
  });
  check('but not one turn earlier', under.speakers.length === 1);
}

console.log('\n[empty room] no agents is handled, not crashed');
{
  const empty = room({ participants: [{ kind: 'human', id: ME, name: 'You', channels: [] }] });
  const r = routeHumanMessage({ conversation: empty, text: 'hello', speakerId: ME });
  check('nobody speaks', r.speakers.length === 0);
  check('and it says so', /no agents/.test(r.reason), r.reason);
}

console.log('');
if (failures) {
  console.error(`FLOOR TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('FLOOR TEST PASSED\n');
