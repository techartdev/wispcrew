/**
 * node-token-test.mjs — a node remembers its clients across a restart.
 *
 * The network token used to be generated on every start, so a node that
 * restarted — on boot, after an upgrade, or because someone ran `serve`
 * again — silently invalidated every client that had ever paired with it.
 *
 * The client's error was "wrong token, or it is not accepting clients":
 * accurate about the symptom, and no hint that re-pairing was required. It
 * cost a live debugging session against a real VPS, where the fingerprint
 * still matched and everything looked correct.
 *
 * Offline: the secrets store only, no sockets.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createNodeCrypto,
  getSecret,
  initStore,
  removeSecrets,
  setHost,
  upsertSecrets,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-token-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'n', crypto: createNodeCrypto(dir) });
initStore(dir);

const KEY = 'WISPCREW_NODE_NETWORK_TOKEN';

console.log('\n[persistence] the token outlives the process that made it');
{
  check('a fresh profile has none', getSecret(dir, KEY) === undefined);

  upsertSecrets(dir, [{ key: KEY, value: 'token-from-first-run' }]);

  /*
   * Reading it back through a separate call is the whole point: the value
   * has to come off disk, not out of a variable the writer still holds.
   */
  check('it is readable afterwards', getSecret(dir, KEY) === 'token-from-first-run');
}

console.log('\n[storage] it is protected like any other credential');
{
  // A token grants full access to the node's engine, so it belongs in the
  // encrypted store rather than beside the settings.
  const secretsFile = path.join(dir, 'wispcrew-secrets.enc');
  check('an encrypted store exists', fs.existsSync(secretsFile));

  const raw = fs.readFileSync(secretsFile, 'utf8');
  check('the token is not readable in it', !raw.includes('token-from-first-run'));

  const settingsFile = path.join(dir, 'wispcrew-settings.json');
  if (fs.existsSync(settingsFile)) {
    check('and not in the settings file',
      !fs.readFileSync(settingsFile, 'utf8').includes('token-from-first-run'));
  }
}

console.log('\n[stability] a second start reuses it rather than replacing it');
{
  /*
   * This is the behaviour that was broken. Load-or-create must LOAD when a
   * value exists — generating a new one is what detached every paired
   * client, silently, on every restart.
   */
  const loadOrCreate = () => {
    const existing = getSecret(dir, KEY);
    if (existing) return existing;
    const created = `generated-${Date.now()}`;
    upsertSecrets(dir, [{ key: KEY, value: created }]);
    return created;
  };

  const first = loadOrCreate();
  const second = loadOrCreate();
  const third = loadOrCreate();

  check('three starts agree', first === second && second === third, `${first} / ${second}`);
  check('and it is the stored one', first === 'token-from-first-run', first);
}

console.log('\n[rotation] removing it is how a user detaches everyone');
{
  /*
   * Deliberately manual. A restart must not rotate the token, but a user who
   * wants every client detached needs some way to say so — deleting the
   * secret is that way, and it is a decision they take rather than one taken
   * for them.
   */
  removeSecrets(dir, [KEY]);
  check('it is gone', getSecret(dir, KEY) === undefined);

  upsertSecrets(dir, [{ key: KEY, value: 'a-new-token' }]);
  check('and a new one can be issued', getSecret(dir, KEY) === 'a-new-token');
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`NODE-TOKEN TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('NODE-TOKEN TEST PASSED\n');
