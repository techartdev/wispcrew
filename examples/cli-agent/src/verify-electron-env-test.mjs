/**
 * verify-electron-env-test.mjs — verify's screenshot child starts Electron,
 * even when its parent is an Electron-as-Node process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const source = fs.readFileSync(path.join(repo, 'scripts', 'verify.mjs'), 'utf8');

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

console.log('\n[verify Electron environment] screenshot child is a desktop app');
const spawn = /execFileSync\(electron, \['\.', `--user-data-dir=\$\{profile\}`\], \{[\s\S]*?\n        \}\);/.exec(source)?.[0] ?? '';
check('finds the screenshot Electron spawn', spawn !== '');
check('inherits the normal parent environment', /\.\.\.process\.env/.test(spawn));
check('removes Electron-as-Node mode for that child', /ELECTRON_RUN_AS_NODE:\s*undefined/.test(spawn));
check('keeps capture configuration in the child environment', /WISPCREW_CAPTURE:\s*shot/.test(spawn));

console.log('');
if (failures) {
  console.error(`VERIFY-ELECTRON-ENV TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('VERIFY-ELECTRON-ENV TEST PASSED\n');
