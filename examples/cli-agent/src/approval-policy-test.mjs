/**
 * approval-policy-test.mjs — who may authorise what, from where.
 *
 * A keyboard you are sitting at and a chat reachable by anyone who
 * compromises your Telegram account are not the same risk. Sharing one
 * policy between them forces a choice nobody should have to make: approve
 * everything twice, or grant a remote door the authority of physical
 * presence.
 *
 * The rule that matters: a remote channel does not INHERIT `auto`. An agent
 * trusted to run unattended while you watch it is not thereby trusted to run
 * shell commands for whoever holds your phone.
 *
 * Offline: pure resolution, no engine.
 */
import { isRemoteChannel, resolvePolicy } from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const agent = (patch = {}) => ({ id: 'a1', name: 'Assistant', createdAt: 1, updatedAt: 1, ...patch });

console.log('\n[remote] which doors count as remote');
{
  check('telegram is remote', isRemoteChannel('telegram'));
  // Both mean "someone is at the computer", which is a stronger claim than
  // "someone holds a credential that reaches it".
  check('desktop is not', !isRemoteChannel('desktop'));
  check('the app is not', !isRemoteChannel('app'));
  check('and no channel means local', !isRemoteChannel(undefined));
}

console.log('\n[default] nothing configured means ask');
{
  const r = resolvePolicy(undefined, {}, undefined);
  check('ask', r.policy === 'ask', r.policy);
  check('not downgraded', r.downgraded === false);
  check('and says where it came from', /global default/.test(r.reason), r.reason);
}

console.log('\n[inheritance] agent overrides global');
{
  const r = resolvePolicy(agent({ approvalPolicy: 'auto' }), { approvalPolicy: 'ask' }, undefined);
  check('the agent wins locally', r.policy === 'auto', r.policy);
  check('attributed to the agent', /this agent/.test(r.reason), r.reason);
}

console.log('\n[THE RULE] a remote door does not inherit auto');
{
  const r = resolvePolicy(agent({ approvalPolicy: 'auto' }), {}, 'telegram');

  // The single most important assertion in this suite.
  check('auto becomes ask over telegram', r.policy === 'ask', r.policy);
  check('and it is flagged as a downgrade', r.downgraded === true);
  // "It asked me again" is indistinguishable from a bug without a reason.
  check('with a reason naming the channel', /telegram/.test(r.reason), r.reason);

  const local = resolvePolicy(agent({ approvalPolicy: 'auto' }), {}, 'desktop');
  check('but not at the desktop', local.policy === 'auto', local.policy);
  check('which is not a downgrade', local.downgraded === false);
}

console.log('\n[global auto] the same rule applies to an inherited global');
{
  // A user who set auto globally has said even less about remote access
  // than one who set it on a specific agent.
  const r = resolvePolicy(agent(), { approvalPolicy: 'auto' }, 'telegram');
  check('downgraded too', r.policy === 'ask' && r.downgraded, `${r.policy}/${r.downgraded}`);
}

console.log('\n[readonly] a stricter policy passes through untouched');
{
  // Reducing readonly further would be meaningless; only `auto` grants
  // authority without a human present.
  const r = resolvePolicy(agent({ approvalPolicy: 'readonly' }), {}, 'telegram');
  check('stays readonly', r.policy === 'readonly', r.policy);
  check('and is not called a downgrade', r.downgraded === false);
}

console.log('\n[YOLO] an explicit per-channel setting is the last word');
{
  /*
   * This is the deliberate grant. A user who sets `auto` for telegram
   * specifically has said the thing the downgrade protects against, so it
   * stands — that is the difference between choosing and drifting into it.
   */
  const r = resolvePolicy(
    agent({ approvalPolicy: 'ask', channelPolicies: { telegram: 'auto' } }),
    {},
    'telegram',
  );
  check('auto over telegram is honoured', r.policy === 'auto', r.policy);
  check('not downgraded', r.downgraded === false);
  check('and says it was set for that channel', /telegram/.test(r.reason), r.reason);
}

console.log('\n[specificity] per-channel beats the agent, which beats global');
{
  const a = agent({ approvalPolicy: 'auto', channelPolicies: { telegram: 'readonly' } });

  // A user can be MORE restrictive remotely as well as less.
  check('per-channel readonly wins', resolvePolicy(a, {}, 'telegram').policy === 'readonly');
  check('the agent still applies elsewhere', resolvePolicy(a, {}, 'desktop').policy === 'auto');
  check('and locally', resolvePolicy(a, {}, undefined).policy === 'auto');
}

console.log('\n[a channel with no entry] falls through, not to undefined');
{
  const a = agent({ approvalPolicy: 'ask', channelPolicies: { desktop: 'auto' } });
  const r = resolvePolicy(a, {}, 'telegram');
  check('telegram uses the agent policy', r.policy === 'ask', r.policy);
  check('desktop uses its own', resolvePolicy(a, {}, 'desktop').policy === 'auto');
}

console.log('');
if (failures) {
  console.error(`APPROVAL-POLICY TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('APPROVAL-POLICY TEST PASSED\n');
