/**
 * node-registry-dedupe-test.mjs — pairing twice does not make two machines.
 *
 * A new pairing used to mint a new id, so pairing the same machine again
 * left two entries: both listed, both dialled, and only the newer holding a
 * token the node still honours. The older one then fails forever with
 * "wrong token", which looks like the node being broken.
 *
 * Found immediately when `wispcrew pair` was first run against a VPS that
 * had been paired minutes earlier — the desktop had the same flaw and had
 * simply never been used that way.
 *
 * Offline: the registry only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addNode,
  createNodeCrypto,
  initStore,
  listNodes,
  removeNode,
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-registry-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'n', crypto: createNodeCrypto(dir) });
initStore(dir);

const FINGERPRINT = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

console.log('\n[re-pairing] the same machine replaces its record');
{
  const first = addNode(dir, {
    name: 'vps',
    address: '203.0.113.10',
    token: 'token-one',
    fingerprint: FINGERPRINT,
  });

  const second = addNode(dir, {
    name: 'vps',
    address: '203.0.113.10',
    token: 'token-two',
    fingerprint: FINGERPRINT,
  });

  check('one machine, not two', listNodes(dir).length === 1, String(listNodes(dir).length));
  // The id must be stable, or an agent's `nodeId` stops pointing anywhere.
  check('and it keeps its id', first.id === second.id, `${first.id} vs ${second.id}`);
}

console.log('\n[identity] the fingerprint decides, not the address');
{
  /*
   * A laptop that changes network is the same laptop. Matching on address
   * would create a second record every time it moved.
   */
  addNode(dir, {
    name: 'vps',
    address: '198.51.100.7',
    token: 'token-three',
    fingerprint: FINGERPRINT,
  });

  const nodes = listNodes(dir);
  check('a moved machine is still one machine', nodes.length === 1, String(nodes.length));
  check('and the new address is recorded', nodes[0]?.address === '198.51.100.7', nodes[0]?.address);
}

console.log('\n[distinct] two machines stay two');
{
  // The opposite error would be worse: merging two real machines because
  // they share an address, so only one of them is ever reachable.
  addNode(dir, {
    name: 'other',
    address: '198.51.100.7',
    token: 'token-four',
    fingerprint: '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
  });

  const nodes = listNodes(dir);
  check('a different fingerprint is a different machine', nodes.length === 2, String(nodes.length));
  check('sharing an address does not merge them',
    new Set(nodes.map((n) => n.address)).size === 1, JSON.stringify(nodes.map((n) => n.address)));
}

console.log('\n[forget] removing one leaves the other');
{
  const nodes = listNodes(dir);
  removeNode(dir, nodes[0].id);

  const left = listNodes(dir);
  check('one remains', left.length === 1, String(left.length));
  check('and it is the other one', left[0]?.id === nodes[1].id);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`NODE-REGISTRY-DEDUPE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('NODE-REGISTRY-DEDUPE TEST PASSED\n');
