/**
 * End-to-end: a daemon listening on a local socket, a client calling real
 * bridge methods over it, and an agent turn driven entirely through the wire.
 *
 * This is the shape the desktop app will use, proven before the UI depends
 * on it.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-stack-'));
const key = fs.readFileSync('testkey-nvidia.txt', 'utf8').trim();

const { daemonHost } = await import('@wispcrew/daemon/host');
const rt = await import('@wispcrew/runtime');

const env = daemonHost({ dataDir: dir });
rt.setHost(env);
rt.initStore(dir);
rt.setProviderKey(dir, 'nvidia', key);
rt.writeSettings(dir, {
  presetId: 'nvidia',
  model: 'meta/llama-3.3-70b-instruct',
  approvalPolicy: 'auto',
  workspaceRoot: process.cwd(),
});
const agent = rt.createAgent({ name: 'Wire agent', persona: 'general' });

// A minimal method table standing in for the desktop's bridge: enough to
// prove dispatch, streaming events and a real turn over the socket.
const methods = {
  listAgents: async () => rt.listAgents(),
  getTranscript: async (id) => rt.loadTranscript(id),
  sendPrompt: async (id, prompt) => rt.runPrompt(id, prompt),
};

const address = rt.localAddress(dir);
const token = rt.generateToken();
const server = net.createServer();
await new Promise((r) => server.listen(address, r));
const node = rt.serveNode({
  server,
  token,
  nodeName: env.nodeName,
  onCall: async (method, args) => {
    const fn = methods[method];
    if (!fn) throw new Error(`Unknown method "${method}"`);
    return fn(...args);
  },
});

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

const streamed = [];
const client = await rt.connectNode({
  socket: net.connect(address),
  token,
  onEvent: (e) => streamed.push(e),
});

console.log('\n[connection]');
check('handshake names the node', client.nodeName === env.nodeName, client.nodeName);

console.log('\n[bridge over the wire]');
const agents = await client.call('listAgents');
check('listAgents returns the roster', agents.length === 1 && agents[0].name === 'Wire agent');

console.log('\n[a real agent turn, driven remotely]');
const answer = await client.call('sendPrompt', [agent.id, 'Reply with exactly: WIRE_OK']);
check('the turn produced an answer', String(answer).includes('WIRE_OK'), String(answer).slice(0, 60));

const transcript = await client.call('getTranscript', [agent.id]);
// Only the assistant entry: the *bridge* records the user message, and this
// harness calls runPrompt directly. Verified rather than assumed.
check('transcript persisted on the node', transcript.some((e) => e.role === 'assistant'),
  JSON.stringify(transcript.map((e) => e.kind + ':' + e.role)));
check('streaming events reached the client', streamed.length > 0, String(streamed.length));

client.close();
await node.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) { console.error(`STACK TEST FAILED — ${failures}`); process.exit(1); }
console.log('STACK TEST PASSED — daemon served real agent work over a socket');
