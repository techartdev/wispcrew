/**
 * pairing-test.mjs — attaching a node over TLS, without any central service.
 *
 * Covers the security properties that would be quietly wrong otherwise:
 * a wrong code refused, a used code not reusable, an expired window closed,
 * a substituted certificate rejected before the token is sent, and a paired
 * client able to reconnect and drive the engine.
 *
 * Offline: real TLS on loopback, no provider, no internet.
 */
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PairingWindow,
  connectRemoteNode,
  createNodeCrypto,
  generateSelfSigned,
  generateToken,
  initStore,
  createAgent,
  listAgents,
  loadOrCreateIdentity,
  pairWithNode,
  parseAddress,
  serveNode,
  setHost,
  codesMatch,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-pair-'));
setHost({
  dataDir: dir,
  defaultWorkspaceRoot: dir,
  nodeName: 'remote-node',
  crypto: createNodeCrypto(dir),
});
initStore(dir);
createAgent({ name: 'Remote worker' });

console.log('\n[address parsing]');
{
  check('bare host gets the default port', parseAddress('pi.local').port === 8787);
  check('host:port is honoured', parseAddress('10.0.0.5:9999').port === 9999);
  check('host:port keeps the host', parseAddress('10.0.0.5:9999').host === '10.0.0.5');
  check('bracketed IPv6 parses', parseAddress('[::1]:9000').host === '::1');
}

console.log('\n[codes]');
{
  const { generatePairingCode } = await import('@wispcrew/runtime');
  const code = generatePairingCode();
  check('code is grouped and readable', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code);
  check('codes differ', generatePairingCode() !== generatePairingCode());
  check('comparison ignores case and dashes', codesMatch(code, code.toLowerCase().replace(/-/g, '')));
  check('a wrong code does not match', !codesMatch(code, 'AAAA-BBBB-CCCC'));
}

// A real TLS node on loopback.
const identity = loadOrCreateIdentity(dir, ['localhost', '127.0.0.1']);
const token = generateToken();
const pairing = new PairingWindow();

const server = tls.createServer({ cert: identity.cert, key: identity.key });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const address = `127.0.0.1:${port}`;

serveNode({
  server,
  token,
  nodeName: 'remote-node',
  pairing,
  onCall: async (method) => {
    if (method === 'listAgents') return listAgents();
    if (method === 'nodeInfo') return { name: 'remote-node' };
    throw new Error(`Unknown method "${method}".`);
  },
});

console.log('\n[refusals] before anything is allowed to succeed');
{
  pairing.open(identity.fingerprint, token);
  try {
    await pairWithNode(address, 'ZZZZ-ZZZZ-ZZZZ', { timeoutMs: 5000 });
    check('a wrong code is refused', false, 'it paired');
  } catch (err) {
    check('a wrong code is refused', /not valid/i.test(err.message), err.message);
  }

  // The window was consumed by that attempt, so a *correct* code now fails.
  check('a failed attempt consumes the window', !pairing.isOpen);
}

console.log('\n[pairing] the happy path');
let paired = null;
{
  const offer = pairing.open(identity.fingerprint, token);
  check('the node offers a fingerprint to compare', Boolean(offer.fingerprint));

  paired = await pairWithNode(address, offer.code, {
    clientName: 'pairing-test',
    timeoutMs: 5000,
    // A cautious user compares the printed fingerprint; so does this test.
    expectFingerprint: identity.fingerprint,
  });
  check('paired successfully', Boolean(paired.token));
  check('the node named itself', paired.nodeName === 'remote-node', paired.nodeName);
  check('the client learned the fingerprint', paired.fingerprint === identity.fingerprint);
  check('the token is not the pairing code', paired.token !== offer.code);
}

console.log('\n[single use] the same code cannot be replayed');
{
  const offer = pairing.open(identity.fingerprint, token);
  await pairWithNode(address, offer.code, { timeoutMs: 5000 });
  try {
    await pairWithNode(address, offer.code, { timeoutMs: 5000 });
    check('a used code is refused', false, 'it paired twice');
  } catch (err) {
    check('a used code is refused', /not valid/i.test(err.message), err.message);
  }
}

console.log('\n[pinning] a substituted certificate never sees the token');
{
  const impostor = generateSelfSigned(['localhost', '127.0.0.1']);
  const fake = tls.createServer({ cert: impostor.cert, key: impostor.key });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));

  try {
    await connectRemoteNode(
      {
        host: '127.0.0.1',
        port: fake.address().port,
        // The fingerprint we pinned for the REAL node.
        fingerprint: identity.fingerprint,
        token: paired.token,
      },
      { timeoutMs: 5000 },
    );
    check('a different certificate is rejected', false, 'it connected');
  } catch (err) {
    check('a different certificate is rejected', /different certificate/i.test(err.message),
      err.message.split('\n')[0]);
  }
  fake.close();
}

console.log('\n[use it] a paired client drives the node over TLS');
{
  const client = await connectRemoteNode(
    { host: '127.0.0.1', port, fingerprint: identity.fingerprint, token: paired.token },
    { clientName: 'pairing-test', timeoutMs: 5000 },
  );
  check('connected with the paired token', Boolean(client.nodeName), client.nodeName);

  const agents = await client.call('listAgents');
  check('the remote roster is readable', agents.length === 1 && agents[0].name === 'Remote worker');
  client.close();
}

console.log('\n[expiry] a stale window does not pair');
{
  const expired = new PairingWindow();
  const offer = expired.open(identity.fingerprint, token);
  // Reach past the public surface deliberately: waiting five minutes in a
  // test is not an option, and the behaviour is worth pinning.
  expired.offer = { ...expired.offer, expiresAt: Date.now() - 1 };
  check('an expired window reports closed', !expired.isOpen);
  check('and refuses a correct code', expired.claim(offer.code) === null);
}

server.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`PAIRING TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('PAIRING TEST PASSED\n');
