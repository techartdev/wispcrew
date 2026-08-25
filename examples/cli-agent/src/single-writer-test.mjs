/**
 * single-writer-test.mjs — one engine per profile, enforced.
 *
 * Two engines on one JSON store lose data. This proves both halves: that the
 * unsafe pattern really does erase an update, and that a second daemon is
 * refused rather than allowed to cause it.
 *
 * Offline: no provider, no network.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgent,
  createNodeCrypto,
  initStore,
  loadTranscript,
  readEndpoint,
  saveTranscript,
  setHost,
  upsertTranscriptEntry,
  isProcessAlive,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-writer-'));
setHost({
  dataDir: dir,
  defaultWorkspaceRoot: dir,
  nodeName: 'test',
  crypto: createNodeCrypto(dir),
});
initStore(dir);
const agent = createAgent({ name: 'Contested' });

console.log('\n[lost update] a held snapshot really does erase the other writer');
{
  // Both writers start from the same view, as two processes would.
  const snapshot = loadTranscript(agent.id);
  saveTranscript(agent.id, [
    ...snapshot,
    { kind: 'message', id: 'writer-a', role: 'user', content: 'a', createdAt: Date.now() },
  ]);
  saveTranscript(agent.id, [
    ...snapshot,
    { kind: 'message', id: 'writer-b', role: 'assistant', content: 'b', createdAt: Date.now() },
  ]);

  const ids = loadTranscript(agent.id).map((e) => e.id);
  // This is the hazard being guarded against, so the test asserts it exists.
  check('a stale snapshot overwrites the other writer', ids.length === 1, JSON.stringify(ids));
}

console.log('\n[safe path] read-modify-write helpers interleave correctly');
{
  saveTranscript(agent.id, []);
  upsertTranscriptEntry(agent.id, {
    kind: 'message', id: 'from-window', role: 'user', content: 'typed', createdAt: Date.now(),
  });
  upsertTranscriptEntry(agent.id, {
    kind: 'message', id: 'from-daemon', role: 'assistant', content: 'routine', createdAt: Date.now(),
  });

  const ids = loadTranscript(agent.id).map((e) => e.id);
  check('both entries survive', ids.length === 2, JSON.stringify(ids));
  check('window entry kept', ids.includes('from-window'));
  check('daemon entry kept', ids.includes('from-daemon'));
}

console.log('\n[guard] a second daemon on the same profile is refused');
{
  const cli = fileURLToPath(new URL('../../../apps/daemon/dist/cli.js', import.meta.url));

  /*
   * Say what is wrong rather than timing out.
   *
   * On a fresh clone the daemon had not been built, so the spawn failed
   * silently and this reported "first daemon started — timed out" — which
   * sent me looking at scheduling and sockets instead of the build order.
   */
  if (!fs.existsSync(cli)) {
    console.error(`  FAIL the daemon is not built — expected ${cli}`);
    console.error('       run: npm run build');
    process.exit(1);
  }

  const first = spawn(process.execPath, [cli, 'serve', '--data-dir', dir, '--listen'], {
    detached: true, stdio: 'ignore',
  });
  first.unref();

  let endpoint = null;
  for (let i = 0; i < 80 && !endpoint; i++) {
    await new Promise((r) => setTimeout(r, 150));
    endpoint = readEndpoint(dir);
  }
  check('first daemon started', Boolean(endpoint), 'timed out');

  if (endpoint) {
    const second = spawn(process.execPath, [cli, 'serve', '--data-dir', dir, '--listen'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    second.stdout.on('data', (d) => { output += d; });
    second.stderr.on('data', (d) => { output += d; });
    const code = await new Promise((r) => second.on('close', r));

    check('second daemon exited non-zero', code !== 0, `exit ${code}`);
    check('and said why', /already uses|lose data/i.test(output), output.slice(0, 120));

    process.kill(endpoint.pid);
    await new Promise((r) => setTimeout(r, 600));
    check('first daemon stopped cleanly', !isProcessAlive(endpoint.pid));
  }
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`SINGLE-WRITER TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('SINGLE-WRITER TEST PASSED\n');
