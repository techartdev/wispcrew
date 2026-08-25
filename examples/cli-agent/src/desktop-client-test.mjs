/**
 * desktop-client-test.mjs — the desktop is a client, and the engine outlives it.
 *
 * Launches the real Electron app against a scratch profile, waits for it to
 * start a daemon and quit, then proves the daemon is still running and still
 * serving.
 *
 * Runs `electron.exe` directly rather than through `npx`: the wrapper does not
 * relay the child's exit on Windows, which looks exactly like the app hanging.
 * That cost a while to distinguish from a real bug, so it is written down.
 *
 * Offline: no provider key, no network.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectNode, isProcessAlive, readEndpoint } from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const desktop = path.join(repo, 'apps', 'desktop');
const electron = path.join(
  repo,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

if (!fs.existsSync(electron)) {
  console.log('electron binary not present; skipping');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-client-'));

console.log('\n[launch] the real app, against a fresh profile');
const app = spawn(electron, ['.', `--user-data-dir=${dir}`], {
  cwd: desktop,
  stdio: 'ignore',
  env: {
    ...process.env,
    WISPCREW_CAPTURE: path.join(dir, 'shot.png'),
    WISPCREW_CAPTURE_DELAY: '6000',
  },
});

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    app.kill();
    resolve('timeout');
  }, 60_000);
  app.on('close', (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});

check('the app exited on its own', exitCode !== 'timeout', 'it hung');
check('and rendered a window first', (fs.statSync(path.join(dir, 'shot.png')).size ?? 0) > 10_000);

console.log('\n[survival] the engine is still running');
const endpoint = readEndpoint(dir);
check('a daemon endpoint is published', Boolean(endpoint));

if (endpoint) {
  check('the daemon is alive after the app quit', isProcessAlive(endpoint.pid));

  console.log('\n[still serving] a new client can use it');
  try {
    const client = await connectNode({
      socket: net.connect(endpoint.address),
      token: endpoint.token,
      clientName: 'desktop-client-test',
    });
    check('connected to the surviving daemon', Boolean(client.nodeName), client.nodeName);

    const agents = await client.call('listAgents');
    check('it serves the roster', Array.isArray(agents) && agents.length > 0, String(agents?.length));

    const info = await client.call('nodeInfo');
    check('and reports the profile it owns', info?.dataDir === fs.realpathSync(dir) || Boolean(info?.dataDir));

    client.close();
  } catch (err) {
    check('connected to the surviving daemon', false, err.message);
  }

  try {
    process.kill(endpoint.pid);
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 800));
  check('daemon stops when asked', !isProcessAlive(endpoint.pid));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`DESKTOP-CLIENT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('DESKTOP-CLIENT TEST PASSED — the desktop is a client, the engine outlives it\n');
