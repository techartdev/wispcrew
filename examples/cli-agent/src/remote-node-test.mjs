/**
 * remote-node-test.mjs — pair with a real `wispcrew serve` and drive it.
 *
 * The pairing suite covers the protocol in-process. This one runs the actual
 * daemon binary with `--network --pair`, scrapes the code it prints, pairs
 * over TLS, and uses the node — which is what a user attaching a VPS or a Pi
 * will do.
 *
 * Offline: loopback TLS, no provider key, no internet.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectRemoteNode, pairWithNode } from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const cli = fileURLToPath(new URL('../../../apps/daemon/dist/cli.js', import.meta.url));

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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-remote-'));
const PORT = 18787;

console.log('\n[start] a node accepting clients over the network');
const daemon = spawn(
  process.execPath,
  [cli, 'serve', '--data-dir', dir, '--network', `127.0.0.1:${PORT}`, '--pair'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let output = '';
daemon.stdout.on('data', (d) => {
  output += d;
});
daemon.stderr.on('data', (d) => {
  output += d;
});

// Wait for it to print a pairing code.
let code = null;
let fingerprint = null;
for (let i = 0; i < 80 && !code; i++) {
  await new Promise((r) => setTimeout(r, 250));
  code = (/code\s+([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(output) ?? [])[1] ?? null;
  fingerprint = (/fingerprint\s+((?:[0-9A-F]{2}:){31}[0-9A-F]{2})/.exec(output) ?? [])[1] ?? null;
}

check('the node printed a pairing code', Boolean(code), output.slice(-200));
check('and its certificate fingerprint', Boolean(fingerprint));

if (!code) {
  daemon.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  console.error('\nREMOTE-NODE TEST FAILED — no pairing code\n');
  process.exit(1);
}

console.log(`  code ${code}`);

console.log('\n[pair] as a client on another machine would');
let paired = null;
try {
  paired = await pairWithNode(`127.0.0.1:${PORT}`, code, {
    clientName: 'remote-node-test',
    timeoutMs: 8000,
    // A cautious user compares the printed fingerprint. So does this.
    expectFingerprint: fingerprint,
  });
  check('paired over TLS', Boolean(paired.token));
  check('the node identified itself', Boolean(paired.nodeName), paired.nodeName);
} catch (err) {
  check('paired over TLS', false, err.message);
}

if (paired) {
  console.log('\n[use] drive the remote engine');
  try {
    const client = await connectRemoteNode(
      { host: '127.0.0.1', port: PORT, fingerprint: paired.fingerprint, token: paired.token },
      { clientName: 'remote-node-test', timeoutMs: 8000 },
    );
    check('connected with the paired token', Boolean(client.nodeName));

    const info = await client.call('nodeInfo');
    check('nodeInfo describes the remote machine', Boolean(info?.name), JSON.stringify(info?.name));
    check('and reports its own data directory', info?.dataDir?.includes('gb-remote-'), info?.dataDir);

    const created = await client.call('createAgent', [
      { name: 'Made remotely', presetId: 'openai', model: 'gpt-5.6-luna' },
    ]);
    check('created an agent on the node', created?.name === 'Made remotely');

    // The proof it ran *there*: the node's own store on disk.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8'));
    check('it exists in the node\'s store', onDisk.some((a) => a.id === created.id));

    const presets = await client.call('getPresets');
    check('providers are reported per node', Array.isArray(presets) && presets.length > 0);

    client.close();
  } catch (err) {
    check('connected with the paired token', false, err.message);
  }

  console.log('\n[single use] the code cannot be used again');
  try {
    await pairWithNode(`127.0.0.1:${PORT}`, code, { timeoutMs: 8000 });
    check('a used code is refused', false, 'it paired twice');
  } catch (err) {
    check('a used code is refused', /not valid/i.test(err.message), err.message);
  }
}

daemon.kill();
await new Promise((r) => setTimeout(r, 600));
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`REMOTE-NODE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('REMOTE-NODE TEST PASSED — a networked node paired and served\n');
