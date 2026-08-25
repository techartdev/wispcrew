/**
 * The claim that has never been tested: a REMOTE node runs a real model turn.
 *
 * Everything so far proved the plumbing offline. This starts a networked
 * daemon with its own provider key, pairs with it over TLS, and asks it to
 * think — with the answer coming back over the wire and the transcript
 * landing in the node's own store.
 *
 * The key is given to the NODE, never sent by the client, which is the
 * per-node secrets rule under real conditions.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rt = await import('@ghostbot/runtime');
const key = fs.readFileSync(fileURLToPath(new URL('../../../testkey-nvidia.txt', import.meta.url)), 'utf8').trim();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-live-'));
const PORT = 18811;

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

console.log('\n[provision] give the NODE its own credentials');
{
  // Written directly into the node's profile, as if configured on that box.
  rt.setHost({
    dataDir: dir,
    defaultWorkspaceRoot: dir,
    nodeName: 'live-remote',
    crypto: rt.createNodeCrypto(dir),
  });
  rt.initStore(dir);
  rt.setProviderKey(dir, 'nvidia', key);
  rt.writeSettings(dir, {
    presetId: 'nvidia',
    model: 'meta/llama-3.3-70b-instruct',
    approvalPolicy: 'auto',
    workspaceRoot: dir,
  });
  rt.createAgent({ name: 'Remote thinker', persona: 'general' });
  check('the node has a key of its own', rt.hasProviderKey(dir, 'nvidia'));
}

console.log('\n[start] ghostbot serve --network --pair');
const daemon = spawn(
  process.execPath,
  [fileURLToPath(new URL('../../../apps/daemon/dist/cli.js', import.meta.url)), 'serve',
   '--data-dir', dir, '--network', `127.0.0.1:${PORT}`, '--pair'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let out = '';
daemon.stdout.on('data', (d) => { out += d; });
daemon.stderr.on('data', (d) => { out += d; });

let code = null, fingerprint = null;
for (let i = 0; i < 80 && !code; i++) {
  await new Promise((r) => setTimeout(r, 250));
  code = (/code\s+([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(out) ?? [])[1] ?? null;
  fingerprint = (/fingerprint\s+((?:[0-9A-F]{2}:){31}[0-9A-F]{2})/.exec(out) ?? [])[1] ?? null;
}
check('the node offered a pairing code', Boolean(code), out.slice(-200));

if (!code) {
  daemon.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

console.log('\n[pair] over TLS');
const paired = await rt.pairWithNode(`127.0.0.1:${PORT}`, code, {
  clientName: 'live-remote-test',
  expectFingerprint: fingerprint,
  timeoutMs: 8000,
});
check('paired', Boolean(paired.token));

console.log('\n[think] a real model turn, executed on the node');
const streamed = [];
const client = await rt.connectRemoteNode(
  { host: '127.0.0.1', port: PORT, fingerprint: paired.fingerprint, token: paired.token },
  { clientName: 'live-remote-test', onEvent: (e) => streamed.push(e), timeoutMs: 8000 },
);

const agents = await client.call('listAgents');
const agent = agents[0];
check('the remote roster is visible', Boolean(agent), JSON.stringify(agents.map((a) => a.name)));

const started = Date.now();
const answer = await client.call('sendPrompt', [
  agent.id,
  'Reply with exactly: REMOTE_INFERENCE_OK',
]);
const elapsed = Date.now() - started;

check('the node produced an answer', String(answer).includes('REMOTE_INFERENCE_OK'),
  String(answer).slice(0, 80));
console.log(`  round trip: ${elapsed}ms`);

check('streaming events reached the client', streamed.length > 0, String(streamed.length));

// The decisive evidence: the transcript is on the NODE's disk.
const transcript = JSON.parse(
  fs.readFileSync(path.join(dir, 'transcripts', `${agent.id}.json`), 'utf8'),
);
check('the transcript persisted on the node', transcript.length > 0, String(transcript.length));
check('and holds the model reply',
  transcript.some((e) => String(e.content ?? '').includes('REMOTE_INFERENCE_OK')));

console.log('\n[secrets] the key never travelled');
{
  const settings = await client.call('getSettings');
  check('the client is told a key exists', settings.hasApiKey === true);
  check('but never receives it', settings.apiKey === undefined);
}

client.close();
daemon.kill();
await new Promise((r) => setTimeout(r, 600));
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) { console.error(`LIVE REMOTE TEST FAILED — ${failures}\n`); process.exit(1); }
console.log('LIVE REMOTE TEST PASSED — a networked node ran real inference\n');
