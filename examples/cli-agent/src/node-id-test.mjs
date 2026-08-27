/**
 * node-id-test.mjs — `nodeId` is one machine's private name for another.
 *
 * It lives in THIS machine's registry. The node it points at has never seen
 * it and must never store it, because on that machine the agent is local.
 *
 * Both directions had to be corrected, and only one was:
 *
 *   inbound  — a record returned by a node has no `nodeId`, so the client
 *              stamps its own back on. Fixed earlier.
 *   outbound — a patch sent TO a node carried `nodeId` and the node stored
 *              it. The VPS's copy of an agent came to say
 *              `nodeId: node_mtafffpj` — the DESKTOP's name for the VPS —
 *              so the VPS decided its own agent lived on a foreign machine
 *              and refused every message with "@remote runs on another
 *              machine, which is not connected."
 *
 * The user typed "hey", pressed Enter, and watched the text vanish.
 *
 * Offline: the stripping rule and the invariant it protects.
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

const bridge = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/bridge-host.ts'), 'utf8');

/* The rule, mirrored from the source it verifies. */
const stripClientNodeId = (args) =>
  args.map((arg) => {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return arg;
    if (!('nodeId' in arg)) return arg;
    const { nodeId: _dropped, ...rest } = arg;
    return rest;
  });

console.log('\n[outbound] a node never receives a client-side node id');
{
  const [id, patch] = stripClientNodeId([
    'agent_1',
    { name: 'Remote', model: 'gpt-5.6-luna', nodeId: 'node_mtafffpj' },
  ]);

  check('the agent id is untouched', id === 'agent_1');
  check('nodeId is gone', !('nodeId' in patch), JSON.stringify(patch));
  check('and everything else survives',
    patch.name === 'Remote' && patch.model === 'gpt-5.6-luna', JSON.stringify(patch));
}

console.log('\n[shapes] stripping does not damage other arguments');
{
  check('a string is left alone', stripClientNodeId(['hello'])[0] === 'hello');
  check('null is left alone', stripClientNodeId([null])[0] === null);
  check('undefined is left alone', stripClientNodeId([undefined])[0] === undefined);

  // An array is not a patch, and its entries must not be rewritten.
  const arr = stripClientNodeId([['a', 'b']])[0];
  check('an array is left alone', Array.isArray(arr) && arr.length === 2);

  // An object with no nodeId is returned as-is, not cloned into a new shape.
  const same = { a: 1 };
  check('an unrelated object passes through', stripClientNodeId([same])[0] === same);
}

console.log('\n[implementation] both directions are handled');
{
  check('the stripper exists', bridge.includes('const stripClientNodeId'));
  check('and is applied to forwarded calls',
    bridge.includes('agentNode.call(name, stripClientNodeId(args))'));

  /*
   * The inbound half, which was already right: a node cannot name itself,
   * so the client stamps its own id back onto a returned record.
   */
  check('the return path still stamps it back',
    bridge.includes('A node does not know its own id here'));
}

console.log('\n[the symptom] no blanket refusal by nodeId alone');
{
  /*
   * An earlier fix refused `sendToRoom` whenever the agent had a `nodeId`,
   * without checking whether the machine was reachable — so a message to a
   * CONNECTED machine was answered "not connected". The wrong answer, stated
   * confidently, is worse than the silence it replaced.
   */
  const handler = bridge.slice(
    bridge.indexOf("handle('sendToRoom'"),
    bridge.indexOf("handle('", bridge.indexOf("handle('sendToRoom'") + 10),
  );

  check('sendToRoom does not refuse on nodeId', !/owner\?\.nodeId/.test(handler));
  check('and says why not', bridge.includes('an earlier version refused whenever'));
}

console.log('');
if (failures) {
  console.error(`NODE-ID TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('NODE-ID TEST PASSED\n');
