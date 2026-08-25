/**
 * The whole point, end to end.
 *
 * Spawns a genuinely detached daemon (as the desktop app does), connects to
 * it over the local socket, drives an agent turn, then kills the client and
 * confirms the daemon is still alive with its routine intact.
 *
 * If this passes, closing the window really does leave agents running.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-full-'));
const key = fs.readFileSync(fileURLToPath(new URL('../../../testkey-nvidia.txt', import.meta.url)), 'utf8').trim();

const rt = await import('@ghostbot/runtime');
const { daemonHost } = await import('@ghostbot/daemon/host');

// Seed the profile the way the desktop would.
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
const agent = rt.createAgent({ name: 'Detached agent', persona: 'general' });

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

console.log('\n[spawn] a genuinely detached daemon');
const entry = fileURLToPath(new URL('../../../apps/daemon/dist/cli.js', import.meta.url));

/*
 * Say what is wrong rather than timing out.
 *
 * On a fresh clone the daemon has not been built, and the spawn then fails
 * silently — reporting a timeout that points at scheduling or sockets rather
 * than at the build.
 */
if (!fs.existsSync(cli)) {
  console.error(`  FAIL the daemon is not built — expected ${cli}`);
  console.error('       run: npm run build');
  process.exit(1);
}
const child = spawn(process.execPath, [entry, 'serve', '--data-dir', dir, '--listen'], {
  detached: true,
  stdio: 'ignore',
});
child.unref();
console.log(`  daemon pid ${child.pid}`);

// Wait for it to publish an endpoint.
let endpoint = null;
for (let i = 0; i < 80 && !endpoint; i++) {
  await new Promise((r) => setTimeout(r, 150));
  endpoint = rt.readEndpoint(dir);
}
check('published an endpoint', Boolean(endpoint), 'timed out');
if (!endpoint) { fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); }
check('endpoint names the daemon pid', endpoint.pid === child.pid, `${endpoint.pid} vs ${child.pid}`);

console.log('\n[connect] as the desktop app would');
const events = [];
const client = await rt.connectNode({
  socket: net.connect(endpoint.address),
  token: endpoint.token,
  clientName: 'test-client',
  onEvent: (e) => events.push(e),
});
check('connected', Boolean(client.nodeName), client.nodeName);

console.log('\n[a real turn over the node method table]');
const info = await client.call('nodeInfo');
check('nodeInfo reports the node', Boolean(info.name), JSON.stringify(info).slice(0,80));
const roster = await client.call('listAgents');
check('listAgents over the wire', roster.length === 1, String(roster.length));
const answer = await client.call('sendPrompt', [agent.id, 'Reply with exactly: DETACHED_OK']);
check('agent answered via the daemon', String(answer).includes('DETACHED_OK'), String(answer).slice(0,60));
check('streaming events arrived', events.length > 0, String(events.length));

console.log('\n[disconnect] the client goes away');
client.close();
await new Promise((r) => setTimeout(r, 800));
check('daemon still running after the client left', rt.isProcessAlive(child.pid));
check('endpoint still published', Boolean(rt.readEndpoint(dir)));

console.log('\n[reconnect] as a relaunched app would');
const again = await rt.connectNode({
  socket: net.connect(endpoint.address),
  token: endpoint.token,
  clientName: 'test-client-2',
});
check('reconnected to the same daemon', again.nodeName === client.nodeName);
again.close();

console.log('\n[cleanup]');
process.kill(child.pid);
await new Promise((r) => setTimeout(r, 600));
check('daemon stopped when asked', !rt.isProcessAlive(child.pid));

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (failures) { console.error(`DETACHED TEST FAILED — ${failures}`); process.exit(1); }
console.log('DETACHED TEST PASSED — the engine outlives its client');
