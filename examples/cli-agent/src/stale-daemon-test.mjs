/**
 * stale-daemon-test.mjs — a daemon running old code is replaced, not trusted.
 *
 * A daemon outlives the app by design, so it keeps whatever engine it loaded
 * at startup. After an upgrade the UI is new and the engine is not, and
 * nothing about that is visible.
 *
 * This happened for real: a shell-quoting fix was built, tested and
 * committed, and the daemon that had started eleven minutes earlier kept
 * mangling commands. The fix looked like it had not worked, and the agent
 * using it kept inventing workarounds for a bug that no longer existed in
 * the code.
 *
 * Offline: local processes only.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  engineBuildStamp,
  isProcessAlive,
  readEndpoint,
  writeEndpoint,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const cli = fileURLToPath(new URL('../../../apps/daemon/dist/cli.js', import.meta.url));
if (!fs.existsSync(cli)) {
  console.error(`  FAIL the daemon is not built — expected ${cli}`);
  console.error('       run: npm run build');
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-stale-'));

console.log('\n[stamp] the engine reports when it was built');
{
  const stamp = engineBuildStamp();
  check('a stamp is available', stamp > 0, String(stamp));
  check('it is a plausible time', stamp < Date.now() + 60_000 && stamp > 1_600_000_000_000,
    new Date(stamp).toISOString());
  check('and it is stable between calls', stamp === engineBuildStamp());
}

console.log('\n[publish] a running daemon records its stamp');
let endpoint = null;
{
  const daemon = spawn(process.execPath, [cli, 'serve', '--data-dir', dir, '--listen'], {
    detached: true,
    stdio: 'ignore',
  });
  daemon.unref();

  for (let i = 0; i < 80 && !endpoint; i++) {
    await new Promise((r) => setTimeout(r, 150));
    endpoint = readEndpoint(dir);
  }
  check('the daemon started', Boolean(endpoint), 'timed out');
  if (endpoint) {
    check('its endpoint carries a build stamp', typeof endpoint.buildStamp === 'number',
      JSON.stringify(endpoint.buildStamp));
    check('matching the engine it loaded', endpoint.buildStamp === engineBuildStamp(),
      `${endpoint.buildStamp} vs ${engineBuildStamp()}`);
  }
}

console.log('\n[detect] an older stamp is recognised as stale');
{
  // Rewrite the endpoint as though this daemon had started before the last
  // build — the exact situation after a rebuild while one is running.
  const aged = { ...endpoint, buildStamp: engineBuildStamp() - 60_000 };
  writeEndpoint(dir, aged);

  const reread = readEndpoint(dir);
  check('the aged stamp persists', reread.buildStamp < engineBuildStamp());

  // This is the comparison linkToDaemon makes.
  const isStale = reread.buildStamp > 0 && reread.buildStamp < engineBuildStamp();
  check('it is judged stale', isStale);

  // And a current one must NOT be, or every launch would restart the daemon.
  writeEndpoint(dir, { ...endpoint, buildStamp: engineBuildStamp() });
  const fresh = readEndpoint(dir);
  check('a current daemon is left alone', !(fresh.buildStamp < engineBuildStamp()));
}

console.log('\n[missing] an endpoint without a stamp is tolerated');
{
  // Written by an older build that predates this field. Restarting on
  // "unknown" would be wrong: it is not evidence of staleness.
  const { buildStamp, ...withoutStamp } = endpoint;
  writeEndpoint(dir, withoutStamp);
  const reread = readEndpoint(dir);
  check('it still reads', Boolean(reread));
  check('and is not treated as stale', typeof reread.buildStamp !== 'number');
}

if (endpoint) {
  try {
    process.kill(endpoint.pid);
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 600));
  check('the daemon stopped', !isProcessAlive(endpoint.pid));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`STALE-DAEMON TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('STALE-DAEMON TEST PASSED\n');
