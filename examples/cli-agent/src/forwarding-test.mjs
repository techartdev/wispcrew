/**
 * forwarding-test.mjs — a client driving a node for every engine method.
 *
 * The point of this round: when an engine lives elsewhere, engine methods go
 * to it and only client-local ones stay behind. That is what keeps a profile
 * to exactly one writer.
 *
 * Offline: exercises the method table and the wire, not a provider.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClientOnlyMethod } from '@ghostbot/shared';
import {
  connectNode,
  createNodeCrypto,
  generateToken,
  initStore,
  localAddress,
  serveNode,
  setHost,
  initGrants,
} from '@ghostbot/runtime';
import { nodeMethods } from '@ghostbot/daemon/methods';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-fwd-'));
setHost({
  dataDir: dir,
  defaultWorkspaceRoot: dir,
  nodeName: 'fwd-node',
  crypto: createNodeCrypto(dir),
});
initStore(dir);
initGrants(dir);

const methods = nodeMethods();
const address = localAddress(dir);
const token = generateToken();
const server = net.createServer();
await new Promise((r) => server.listen(address, r));
const node = serveNode({
  server,
  token,
  nodeName: 'fwd-node',
  onCall: async (method, args) => {
    const fn = methods[method];
    if (!fn) throw new Error(`Unknown method "${method}".`);
    return fn(...args);
  },
});

const client = await connectNode({ socket: net.connect(address), token });

console.log('\n[scope] client-only methods are identified');
{
  for (const m of ['pickFiles', 'pickDirectory', 'openPath', 'getAppInfo']) {
    check(`${m} is client-only`, isClientOnlyMethod(m));
  }
  for (const m of ['listAgents', 'sendPrompt', 'saveSettings', 'listMcpServers']) {
    check(`${m} is an engine method`, !isClientOnlyMethod(m));
  }
}

console.log('\n[engine state] the node owns it');
{
  const created = await client.call('createAgent', [{ name: 'Remote agent' }]);
  check('createAgent works over the wire', created?.name === 'Remote agent');

  const roster = await client.call('listAgents');
  check('the node reports it in the roster', roster.some((a) => a.id === created.id));

  // The node is the only writer, so its store is the truth.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8'));
  check('and it reached the node\'s own store', onDisk.some((a) => a.id === created.id));

  await client.call('updateAgent', [created.id, { name: 'Renamed' }]);
  const after = await client.call('listAgents');
  check('updateAgent persists', after.find((a) => a.id === created.id)?.name === 'Renamed');

  const dup = await client.call('duplicateAgent', [created.id]);
  check('duplicateAgent works', Boolean(dup?.id) && dup.id !== created.id);

  await client.call('deleteAgent', [dup.id]);
  check('deleteAgent works', !(await client.call('listAgents')).some((a) => a.id === dup.id));
}

console.log('\n[per-node truth] the node answers about itself');
{
  const presets = await client.call('getPresets');
  check('getPresets returns the catalogue', Array.isArray(presets) && presets.length > 0);
  // `configured` must describe THIS node, not the client's machine — that is
  // the point of keeping secrets per node.
  check(
    'nothing is configured on a fresh node',
    presets.every((p) => p.local || p.subscription || !p.configured),
    JSON.stringify(presets.filter((p) => p.configured).map((p) => p.id)),
  );

  const info = await client.call('nodeInfo');
  check('nodeInfo names the node', info?.name === 'fwd-node');

  const settings = await client.call('getSettings');
  check('getSettings hides the key itself', settings.apiKey === undefined);
  check('and reports whether one exists', typeof settings.hasApiKey === 'boolean');
}

console.log('\n[secrets stay put] a key saved to the node stays on the node');
{
  await client.call('saveSettings', [{ presetId: 'nvidia', apiKey: 'nv-test-key-not-real' }]);
  const settings = await client.call('getSettings');
  check('the node now reports a key', settings.hasApiKey === true);

  // It must be in the node's encrypted store, and never in plaintext settings.
  const plain = fs.readFileSync(path.join(dir, 'ghostbot-settings.json'), 'utf8');
  check('the key is not in the settings file', !plain.includes('nv-test-key-not-real'));
  check('an encrypted store exists', fs.existsSync(path.join(dir, 'ghostbot-secrets.enc')));
}

console.log('\n[interactive] a node refuses what it cannot do, and says why');
{
  for (const [method, expect] of [
    ['resolveApproval', /client that is attached/i],
    ['oauthSignIn', /browser/i],
    ['oauthImportFromCli', /this machine|node itself/i],
  ]) {
    try {
      await client.call(method, []);
      check(`${method} is refused`, false, 'it resolved');
    } catch (err) {
      check(`${method} is refused with guidance`, expect.test(err.message), err.message);
    }
  }
}

console.log('\n[unknown] an unimplemented method is named, not swallowed');
{
  try {
    await client.call('noSuchMethod', []);
    check('unknown method rejects', false, 'it resolved');
  } catch (err) {
    check('unknown method names itself', err.message.includes('noSuchMethod'), err.message);
  }
}

client.close();
await node.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`FORWARDING TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('FORWARDING TEST PASSED\n');
