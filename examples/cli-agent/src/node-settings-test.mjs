/**
 * node-settings-test.mjs — a key reaches the store, or the call fails.
 *
 * `writeSettings` and `saveSettings` differ in one way that is invisible
 * until it costs a day: only `saveSettings` stores a credential.
 * `writeSettings` writes the patch as given, so an `apiKey` in it used to be
 * dropped on the floor.
 *
 * That shipped. `configureNode` called the wrong one, reported `{ ok: true }`,
 * and the VPS stored nothing — so a remote agent had no way to reach a model
 * and its turns produced empty transcripts with no error anywhere. The CLI's
 * `configure` command then made the identical mistake within an hour, which
 * is how a trap announces that it is a trap rather than a slip.
 *
 * Offline: store only, no daemon and no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createNodeCrypto,
  defaultSettings,
  hasProviderKey,
  initStore,
  readSettings,
  setHost,
  setProviderKey,
  writeSettings,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-nodeset-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'n', crypto: createNodeCrypto(dir) });
initStore(dir);

console.log('\n[storage] a key goes to the encrypted store, never the settings file');
{
  writeSettings(dir, { presetId: 'nvidia', model: 'test-model' });
  setProviderKey(dir, 'nvidia', 'nvapi-secret-value');

  check('the key is recorded', hasProviderKey(dir, 'nvidia') === true);

  const settingsFile = fs.readFileSync(path.join(dir, 'wispcrew-settings.json'), 'utf8');
  // Hard rule 5 exists because a debug path once wrote a key into this file.
  check('and not in the plaintext settings', !settingsFile.includes('nvapi-secret-value'));

  const secretsFile = fs.readFileSync(path.join(dir, 'wispcrew-secrets.enc'), 'utf8');
  check('and not readable in the secrets file', !secretsFile.includes('nvapi-secret-value'));
}

console.log('\n[isolation] a key belongs to one provider, not all of them');
{
  // A node holds only the credentials it was given; leaking one preset's key
  // to another would defeat the point of per-node secrets.
  check('another provider has none', hasProviderKey(dir, 'openai') === false);
}

console.log('\n[settings] a plain write leaves the key alone');
{
  writeSettings(dir, { model: 'another-model' });
  check('the key survives an unrelated write', hasProviderKey(dir, 'nvidia') === true);
  check('and the change lands', readSettings(dir, defaultSettings()).model === 'another-model');
}

console.log('\n[the trap] the method names are not interchangeable');
{
  /*
   * Documented as an assertion rather than a comment, because a comment did
   * not stop the second occurrence. `writeSettings` now throws on an apiKey
   * instead of discarding it: a loud failure at the call site beats a silent
   * one discovered on another machine days later.
   */
  const { nodeMethods } = await import('@wispcrew/daemon/methods');
  const methods = nodeMethods();

  check('both methods exist', typeof methods.writeSettings === 'function' &&
    typeof methods.saveSettings === 'function');

  let threw = false;
  try {
    methods.writeSettings({ presetId: 'nvidia', apiKey: 'nvapi-should-be-refused' });
  } catch {
    threw = true;
  }
  check('writeSettings refuses a key', threw);

  // And the one that is meant to take it, does.
  methods.saveSettings({ presetId: 'groq', apiKey: 'gsk-stored-properly' });
  check('saveSettings stores it', hasProviderKey(dir, 'groq') === true);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`NODE-SETTINGS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('NODE-SETTINGS TEST PASSED\n');
