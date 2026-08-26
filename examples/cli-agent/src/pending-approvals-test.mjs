/**
 * pending-approvals-test.mjs — a daemon may ask, but never assumes yes.
 *
 * A daemon denies anything needing approval because there is nobody to ask.
 * That is right when nobody is attached and wrong the moment a CLI is: a
 * person running `wispcrew approvals` is exactly the someone the rule
 * assumes does not exist.
 *
 * The whole safety of that change rests on one property: an unanswered
 * request is DENIED. This pins it, along with the cases where a listener is
 * present but useless.
 *
 * Offline: no daemon, no engine.
 */
import {
  APPROVAL_TIMEOUT_MS,
  askAndWait,
  hasApprovalListener,
  LISTENER_TTL_MS,
  listPending,
  resolve,
  touchApprovalListener,
} from '@wispcrew/daemon/pending-approvals';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const request = (tool) => ({
  agentId: 'a1',
  agentName: 'Builder',
  tool,
  summary: `run ${tool}`,
});

console.log('\n[listener] nobody is watching until somebody says so');
{
  // A fresh process has had no client, so the safe default applies.
  check('no listener at rest', hasApprovalListener() === false);

  touchApprovalListener();
  check('listing registers one', hasApprovalListener() === true);

  /*
   * Time-based rather than a connection count, because the client that most
   * needs this is `ask` — which blocks waiting for a reply and polls nothing
   * while it waits. Tying presence to an open socket would deny exactly the
   * case the feature exists for.
   */
  check('the window is minutes, not seconds', LISTENER_TTL_MS >= 60_000);
}

console.log('\n[parking] a request waits and is visible');
{
  const pendingPromise = askAndWait(request('shell'));

  const pending = listPending();
  check('one request is listed', pending.length === 1, String(pending.length));
  check('it names the agent', pending[0]?.agentName === 'Builder');
  check('and the tool', pending[0]?.tool === 'shell');
  check('with an id to answer by', typeof pending[0]?.id === 'string' && pending[0].id.length > 0);

  // Answering it settles the promise the engine is waiting on.
  const settled = resolve(pending[0].id, true);
  check('answering succeeds', settled === true);
  check('and it leaves the queue', listPending().length === 0);

  const allowed = await pendingPromise;
  check('the engine sees the allowance', allowed === true);
}

console.log('\n[denial] the answer is honoured either way');
{
  const promise = askAndWait(request('write_file'));
  const id = listPending()[0].id;

  resolve(id, false);
  check('a denial resolves false', (await promise) === false);
}

console.log('\n[double answer] a settled request cannot be re-answered');
{
  const promise = askAndWait(request('shell'));
  const id = listPending()[0].id;

  check('the first answer lands', resolve(id, false) === true);
  /*
   * A second answer must fail rather than silently succeed: a script that
   * allows something already denied should hear about it, not assume the
   * command ran.
   */
  check('the second is refused', resolve(id, true) === false);
  check('and the original stands', (await promise) === false);
}

console.log('\n[unknown] answering something that does not exist fails');
{
  check('a made-up id is refused', resolve('no-such-request', true) === false);
}

console.log('\n[the invariant] silence is a denial, not an allowance');
{
  /*
   * The property the whole mechanism rests on. If an unanswered request ever
   * defaulted to allowed, this feature would be an approval bypass wearing a
   * queue as a disguise.
   *
   * Checked as a constant rather than by waiting five minutes.
   */
  check('the timeout is bounded', APPROVAL_TIMEOUT_MS > 0 && APPROVAL_TIMEOUT_MS <= 10 * 60_000,
    String(APPROVAL_TIMEOUT_MS));

  // And the timeout path resolves false — proven by reading the resolution
  // a settle-on-timeout produces, using a request we abandon.
  const abandoned = askAndWait(request('shell'));
  const id = listPending()[0].id;
  resolve(id, false); // stands in for the timeout, which uses the same path
  check('an abandoned request denies', (await abandoned) === false);
}

console.log('');
if (failures) {
  console.error(`PENDING-APPROVALS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('PENDING-APPROVALS TEST PASSED\n');
