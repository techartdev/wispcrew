/**
 * node-reconnect-test.mjs — node links retry after a close or failed dial.
 *
 * This is a source-level probe because node-links is Electron main-process
 * code and its remote transport is intentionally real TLS. It pins the
 * scheduling seam: older code dropped a closed link and had no code path
 * capable of dialing it again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const source = fs.readFileSync(
  path.join(repo, 'apps', 'desktop', 'src', 'main', 'node-links.ts'),
  'utf8',
);

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

console.log('\n[node reconnect] dropped nodes retry without blocking routing');
check('keeps reconnect timers per node', /const reconnectTimers = new Map/.test(source));
check('uses capped exponential backoff', /RECONNECT_INITIAL_MS.*RECONNECT_MAX_MS/s.test(source) && /Math\.min\(RECONNECT_INITIAL_MS \* 2 \*\* attempt, RECONNECT_MAX_MS\)/.test(source));
check('schedules another dial after a close', /onClose:[\s\S]*scheduleReconnect\(dataDir, nodeId, onEvent\)/.test(source));
check('schedules another dial after a failed connection', /\.catch\(\(err\) =>[\s\S]*scheduleReconnect\(dataDir, nodeId, onEvent\)/.test(source));
check('does not schedule duplicate retry timers', /reconnectTimers\.has\(nodeId\)/.test(source));
check('coalesces concurrent connection attempts', /const connecting = new Map/.test(source) && /const pending = connecting\.get\(nodeId\)/.test(source));
check('keeps existingLink a synchronous map lookup', /export function existingLink[\s\S]*return links\.get\(nodeId\)\?\.client \?\? null;/.test(source));
check('stops timers during application shutdown', /closeNodeLinks[\s\S]*clearTimeout\(timer\)/.test(source));

console.log('');
if (failures) {
  console.error(`NODE-RECONNECT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('NODE-RECONNECT TEST PASSED\n');
