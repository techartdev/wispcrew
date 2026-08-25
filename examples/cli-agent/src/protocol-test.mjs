/**
 * Prove the transport before anything depends on it: real sockets, real
 * frames, and the security properties that matter.
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { serveNode, connectNode, generateToken, localAddress } from '@wispcrew/runtime';
import { addEventSink, emitEngineEvent } from '@wispcrew/runtime';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-proto-'));
const address = localAddress(dir);
const token = generateToken();

const server = net.createServer();
await new Promise((r) => server.listen(address, r));

const node = serveNode({
  server,
  token,
  nodeName: 'test-node',
  onCall: async (method, args) => {
    if (method === 'echo') return { echoed: args };
    if (method === 'boom') throw new Error('deliberate failure');
    if (method === 'big') return 'x'.repeat(200_000); // force chunked delivery
    throw new Error(`unknown method ${method}`);
  },
});

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

console.log('\n[handshake]');
const events = [];
const client = await connectNode({
  socket: net.connect(address),
  token,
  onEvent: (e) => events.push(e),
});
check('node name reported', client.nodeName === 'test-node', client.nodeName);

console.log('\n[calls]');
const echoed = await client.call('echo', [1, 'two', { three: true }]);
check('round-trips arguments', JSON.stringify(echoed.echoed) === JSON.stringify([1, 'two', { three: true }]));

try {
  await client.call('boom');
  check('errors reject', false, 'resolved instead');
} catch (e) {
  check('errors reject with the message', e.message === 'deliberate failure', e.message);
}

// A 200KB payload cannot arrive in one TCP segment; this proves reassembly.
const big = await client.call('big');
check('large payload reassembled', big.length === 200_000, String(big.length));

// Concurrency: responses must match their own request, not arrive in order.
const [a, b, c] = await Promise.all([
  client.call('echo', ['a']), client.call('echo', ['b']), client.call('echo', ['c']),
]);
check('concurrent calls are correlated',
  a.echoed[0] === 'a' && b.echoed[0] === 'b' && c.echoed[0] === 'c');

console.log('\n[events]');
emitEngineEvent({ type: 'notice', level: 'info', text: 'pushed to the client' });
await new Promise((r) => setTimeout(r, 120));
check('events reach the client', events.some((e) => e?.text === 'pushed to the client'));

console.log('\n[auth] the part that must not be wrong');
const rejected = await new Promise((resolve) => {
  connectNode({ socket: net.connect(address), token: 'wrong-token' })
    .then(() => resolve('ACCEPTED'))
    .catch(() => resolve('refused'));
});
check('a wrong token is refused', rejected === 'refused', rejected);

// A client that skips `hello` entirely must never reach the method table.
const skipped = await new Promise((resolve) => {
  const s = net.connect(address, () => {
    s.write(JSON.stringify({ t: 'req', id: 1, method: 'echo', args: [] }) + '\n');
  });
  let got = '';
  s.on('data', (d) => { got += d; });
  s.on('close', () => resolve(got ? 'ANSWERED' : 'dropped'));
  setTimeout(() => s.destroy(), 500);
});
check('a call without hello is dropped', skipped === 'dropped', skipped);

client.close();
await node.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) { console.error(`PROTOCOL TEST FAILED — ${failures}`); process.exit(1); }
console.log('PROTOCOL TEST PASSED');
