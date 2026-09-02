/**
 * nvidia-models.cjs — list the models the NVIDIA key can actually reach.
 *
 * Being in `/v1/models` is not the same as being servable: this project has
 * already lost an hour to a model that was listed and returned 404 on chat,
 * and another to one that reached its end of life while in use. This prints
 * the catalogue so a live one can be chosen rather than guessed.
 */
const {
  setHost,
  createNodeCrypto,
  initStore,
  readSecrets,
  providerSecretKey,
  LEGACY_KEY,
} = require('../packages/runtime/dist/index.js');
const os = require('node:os');
const path = require('node:path');

const dir = path.join(os.homedir(), '.wispcrew');
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'shot', crypto: createNodeCrypto(dir) });
initStore(dir);

const secrets = readSecrets(dir);
const key = secrets[providerSecretKey('nvidia')] ?? secrets[LEGACY_KEY];
if (!key) {
  console.error('no nvidia key in this profile');
  process.exit(1);
}

fetch('https://integrate.api.nvidia.com/v1/models', {
  headers: { Authorization: `Bearer ${key}` },
})
  .then((r) => r.json())
  .then((j) => {
    const ids = (j.data ?? []).map((m) => m.id).sort();
    for (const id of ids) console.log(id);
    console.error(`${ids.length} models`);
  })
  .catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
