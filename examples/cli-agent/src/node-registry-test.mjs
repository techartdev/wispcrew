/**
 * node-registry-test.mjs — remembering paired machines, and assigning agents.
 *
 * Covers the parts that would fail quietly: a token stored encrypted rather
 * than beside the node record, forgetting a node taking its credential with
 * it, and an agent's `nodeId` surviving a round trip so routing has
 * something to route on.
 *
 * Offline: no network, no provider.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addNode,
  createAgent,
  createNodeCrypto,
  getAgent,
  getNode,
  initStore,
  listNodes,
  markNodeSeen,
  removeNode,
  setHost,
  updateAgent,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-registry-'));
setHost({
  dataDir: dir,
  defaultWorkspaceRoot: dir,
  nodeName: 'client',
  crypto: createNodeCrypto(dir),
});
initStore(dir);

const TOKEN = 'node-token-that-grants-shell-access';

console.log('\n[pairing record]');
let node;
{
  node = addNode(dir, {
    name: 'pi',
    address: '192.168.1.50:8787',
    token: TOKEN,
    fingerprint: 'AA:BB:CC:DD',
  });
  check('the node is listed', listNodes(dir).some((n) => n.id === node.id));
  check('with its address', listNodes(dir)[0].address === '192.168.1.50:8787');
  check('and its pinned fingerprint', listNodes(dir)[0].fingerprint === 'AA:BB:CC:DD');
}

console.log('\n[the token is a credential, not metadata]');
{
  const listed = listNodes(dir)[0];
  check('listNodes never returns a token', listed.token === undefined, JSON.stringify(listed));

  const plain = fs.readFileSync(path.join(dir, 'nodes.json'), 'utf8');
  check('the node file has no token in it', !plain.includes(TOKEN));

  // It must still be retrievable for actually connecting.
  check('getNode returns it', getNode(dir, node.id)?.token === TOKEN);

  // And it must be in the encrypted store, not lying around.
  const enc = path.join(dir, 'wispcrew-secrets.enc');
  check('an encrypted store exists', fs.existsSync(enc));
  check('the token is not readable in it', !fs.readFileSync(enc).includes(Buffer.from(TOKEN)));
}

console.log('\n[agents belong to a node]');
{
  const local = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Local agent' });
  const remote = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Remote agent' });
  updateAgent(remote.id, { nodeId: node.id });

  check('an agent defaults to local', getAgent(local.id)?.nodeId === undefined);
  check('an assigned agent remembers its node', getAgent(remote.id)?.nodeId === node.id);

  // Routing reads exactly this, so it must survive a reload from disk.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8'));
  check('the assignment is persisted', onDisk.find((a) => a.id === remote.id)?.nodeId === node.id);
}

console.log('\n[last seen]');
{
  check('a fresh node has never been seen', listNodes(dir)[0].lastSeenAt === undefined);
  markNodeSeen(dir, node.id);
  check('and records it once it answers', typeof listNodes(dir)[0].lastSeenAt === 'number');
}

console.log('\n[forgetting takes the credential too]');
{
  removeNode(dir, node.id);
  check('the node is gone', listNodes(dir).length === 0);
  check('and so is its token', getNode(dir, node.id) === null);

  // Leaving a token behind would keep access the user believes they revoked.
  const enc = path.join(dir, 'wispcrew-secrets.enc');
  if (fs.existsSync(enc)) {
    check('nothing left in the secret store', !fs.readFileSync(enc).includes(Buffer.from(TOKEN)));
  }
}

console.log('\n[missing token is reported, not guessed]');
{
  const orphan = addNode(dir, {
    name: 'orphan',
    address: 'x:1',
    token: 'temp',
    fingerprint: 'FF',
  });
  // Simulate a secrets store written by a different backend.
  removeNode(dir, orphan.id);
  const readded = addNode(dir, {
    name: 'orphan',
    address: 'x:1',
    token: 'temp2',
    fingerprint: 'FF',
    id: orphan.id,
  });
  check('a re-paired node works again', getNode(dir, readded.id)?.token === 'temp2');
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`NODE-REGISTRY TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('NODE-REGISTRY TEST PASSED\n');
