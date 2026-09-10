/** node-liveness-test.mjs — node lastSeenAt follows real protocol activity. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const client = fs.readFileSync(path.join(repo, 'packages/runtime/src/node-client.ts'), 'utf8');
const remote = fs.readFileSync(path.join(repo, 'packages/runtime/src/node-remote.ts'), 'utf8');
const desktop = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/node-links.ts'), 'utf8');
let failures = 0;
const check = (label, ok) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}`); }
};

console.log('\n[node liveness] last seen follows authenticated node traffic');
check('node client exposes an activity callback', /onActivity\?: \(\) => void/.test(client));
check('node client invokes it for every parsed frame', /for \(const raw of frames\) \{[\s\S]*?onActivity\?\.\(\);/.test(client));
check('remote connector forwards the callback', /onActivity: options\.onActivity/.test(remote));
check('desktop records activity as node seen', /onActivity: \(\) => markNodeSeen\(dataDir, nodeId\)/.test(desktop));
check('desktop does not claim liveness from a timer', !/setInterval[\s\S]{0,300}markNodeSeen/.test(desktop));
console.log('');
if (failures) { console.error(`NODE-LIVENESS TEST FAILED — ${failures} assertion(s)\n`); process.exit(1); }
console.log('NODE-LIVENESS TEST PASSED\n');
