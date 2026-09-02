/**
 * probe-model.cjs — ask one provider for one model, and print what it says.
 *
 *   node scripts/probe-model.cjs <presetId> <model>
 *
 * Exists to settle "why is this a 404?" without reasoning about it. A 404
 * from a provider means two different things — "busy" and "not mine" — and
 * the only way to tell them apart is to look at the body.
 */
const {
  setHost,
  createNodeCrypto,
  initStore,
  readSecrets,
  providerSecretKey,
  LEGACY_KEY,
} = require('../packages/runtime/dist/index.js');
const { PROVIDER_PRESETS } = require('../packages/llm/dist/index.js');
const os = require('node:os');
const path = require('node:path');

const dir = path.join(os.homedir(), '.wispcrew');
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'probe', crypto: createNodeCrypto(dir) });
initStore(dir);

const [presetId, model] = process.argv.slice(2);
const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
if (!preset) {
  console.error(`no preset "${presetId}". Have: ${PROVIDER_PRESETS.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

const secrets = readSecrets(dir);
const key = secrets[providerSecretKey(presetId)] ?? secrets[LEGACY_KEY];

console.log(`preset   ${preset.id}  (${preset.label})`);
console.log(`host     ${preset.baseUrl || '(subscription endpoint)'}`);
console.log(`model    ${model}`);
console.log(`key      ${key ? 'present' : 'ABSENT'}`);
console.log('');

if (!preset.baseUrl) {
  console.log('This preset signs in rather than taking a key; nothing to probe here.');
  process.exit(0);
}

fetch(`${preset.baseUrl.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key ?? ''}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'ok' }],
    max_tokens: 4,
    stream: false,
  }),
})
  .then(async (r) => {
    console.log(`HTTP ${r.status}`);
    console.log((await r.text()).slice(0, 400));
  })
  .catch((e) => console.error(String(e)));
