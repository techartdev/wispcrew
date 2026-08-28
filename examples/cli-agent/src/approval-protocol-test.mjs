/**
 * approval-protocol-test.mjs — an unanswered request is denied.
 *
 * This machine runs shell commands, so the approval layer is the thing
 * standing between a model's suggestion and a stranger's server. Approvals
 * now cross the network, which adds several new ways to get "yes" by
 * accident: a client that never answers, one that disconnects mid-request,
 * one speaking a dialect this node does not know.
 *
 * Every one of them must land on DENY. That is what this pins.
 *
 * Offline: the decision rules and the shape of the frames.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const protocol = fs.readFileSync(path.join(repo, 'packages/runtime/src/protocol.ts'), 'utf8');
const server = fs.readFileSync(path.join(repo, 'packages/runtime/src/node-server.ts'), 'utf8');
const client = fs.readFileSync(path.join(repo, 'packages/runtime/src/node-client.ts'), 'utf8');
const clients = fs.readFileSync(path.join(repo, 'packages/runtime/src/approval-clients.ts'), 'utf8');
const serve = fs.readFileSync(path.join(repo, 'apps/daemon/src/serve.ts'), 'utf8');

/** The node's rule for reading a decision, mirrored from its source. */
const readDecision = (resolution) =>
  resolution === 'allow-once' || resolution === 'allow-always' ? resolution : 'deny';

console.log('\n[the rule] only an explicit allow is an allow');
{
  check('allow-once passes', readDecision('allow-once') === 'allow-once');
  check('allow-always passes', readDecision('allow-always') === 'allow-always');
  check('deny denies', readDecision('deny') === 'deny');

  /*
   * The cases that matter. A newer client, a typo, a truncated frame, a
   * hostile one — none of them may be read as permission.
   */
  for (const bad of ['allow', 'ALLOW-ONCE', 'yes', 'true', '', undefined, null, 1, {}]) {
    check(`"${String(bad)}" denies`, readDecision(bad) === 'deny');
  }
}

console.log('\n[the wire] the frames exist and carry what a card needs');
{
  check('an ask frame', protocol.includes("t: 'ask'"));
  check('a decision frame', protocol.includes("t: 'decision'"));

  // The card is written by the node, so its id must travel or the client
  // resolves a request nobody is looking at.
  check('the ask carries the entry id', /requestId: string;/.test(protocol));

  check('a client may send a decision', /ClientFrame =[^;]*DecisionFrame/.test(protocol));
  check('a node may send an ask', /NodeFrame =[\s\S]*?AskFrame/.test(protocol));

  /*
   * The version stays 1 on purpose: an older client never sends a decision,
   * an older node never asks, and the timeout still denies. A mismatch
   * degrades to the old behaviour rather than breaking a live connection.
   */
  check('protocol version unchanged', /PROTOCOL_VERSION = 1/.test(protocol));
}

console.log('\n[the node] nothing is left hanging');
{
  check('the node reads a decision strictly',
    server.includes("frame.resolution === 'allow-once' || frame.resolution === 'allow-always'"));

  /*
   * The one that would be silent: a resolver never settled leaves the agent
   * waiting forever. A disconnect must answer every outstanding request.
   */
  check('a disconnect denies everything outstanding',
    /for \(const \[, resolve\] of pendingAsks\) resolve\('deny'\)/.test(server));
  check('and clears them', server.includes('pendingAsks.clear()'));

  /*
   * Registered only after the token is checked: a connection that has not
   * proved itself must not get a say over whether this machine runs a shell
   * command.
   *
   * Compared against the CALL, not the import — the first version matched
   * `import { registerApprovalClient }` at the top of the file and reported
   * a correct order as wrong.
   */
  const helloAt = server.indexOf("t: 'welcome'");
  const registerAt = server.indexOf('detachAsker = registerApprovalClient');
  check('only an authenticated client may be asked',
    helloAt !== -1 && registerAt !== -1 && helloAt < registerAt,
    `welcome at ${helloAt}, register at ${registerAt}`);
}

console.log('\n[the client] no accidental yes');
{
  check('no handler means deny at once',
    /if \(!onAsk\)[\s\S]{0,120}resolution: 'deny'/.test(client));
  check('a throwing handler denies', /\.catch\(\(\) =>[\s\S]{0,80}'deny'/.test(client));
  check('a missing answer denies', client.includes("resolution ?? 'deny'"));
}

console.log('\n[the daemon] asking a client never replaces the default');
{
  /*
   * `askApprovalClients` returns null when nobody answered, which must fall
   * through to the denial rather than being read as a no from a person —
   * the outcome is the same, the notice explaining it is not.
   */
  check('null falls through', clients.includes('return null'));
  check('the daemon only returns a real decision', /if \(decision\) return decision ===/.test(serve));
  check('the unattended denial survives', serve.includes('denied unattended approval'));

  // The card is written where the conversation lives.
  check('the node writes the card itself', serve.includes("kind: 'approval'"));
  check('and records the outcome', /status:\s*[\s\S]{0,80}'approved' : 'denied'/.test(serve));

  /*
   * And ANNOUNCES it. `pushTranscript` writes AND emits; the bare store
   * call only writes.
   *
   * Using the store call left the card invisible until something forced a
   * reload: the agent sat at "waiting for you" with a tool call stuck on
   * Running and no way to answer it. A polling probe reported success,
   * because a fresh fetch sees what a live window never received — which is
   * precisely how this passed a test and failed a person.
   */
  check('the card is announced, not only written',
    /pushTranscript\(agentId, \{\s*kind: 'approval'/.test(serve));
  // Matched as a CALL, not as prose — the comment explaining why the store
  // call is wrong contains its name, and the first version failed on that.
  check('no silent store write on this path', !/upsertTranscriptEntry\(/.test(serve));
}

console.log('');
if (failures) {
  console.error(`APPROVAL-PROTOCOL TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('APPROVAL-PROTOCOL TEST PASSED\n');
