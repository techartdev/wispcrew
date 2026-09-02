/**
 * nvidia-probe.cjs — which listed models actually answer.
 *
 * Being in `/v1/models` is not the same as being servable. This project has
 * lost an hour to a model that was listed and returned 404 on chat, and more
 * to one that reached end-of-life while in use. Listing is a catalogue;
 * this sends a real one-token request and reports what came back.
 *
 *   node scripts/nvidia-probe.cjs [substring]
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
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'probe', crypto: createNodeCrypto(dir) });
initStore(dir);

const secrets = readSecrets(dir);
const key = secrets[providerSecretKey('nvidia')] ?? secrets[LEGACY_KEY];
if (!key) {
  console.error('no nvidia key in this profile');
  process.exit(1);
}

const filter = process.argv[2] ?? 'instruct';

async function main() {
  const list = await fetch('https://integrate.api.nvidia.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  }).then((r) => r.json());

  const ids = (list.data ?? [])
    .map((m) => m.id)
    .filter((id) => id.includes(filter))
    // Embedding, reward and safety models are not chat models; asking them
    // to chat produces a confusing error rather than a useful answer.
    .filter((id) => !/embed|reward|guard|parse|safety|rerank|ocr|vl-/.test(id))
    .sort();

  console.error(`probing ${ids.length} model(s) matching "${filter}"\n`);

  for (const id of ids) {
    const started = Date.now();
    try {
      const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          max_tokens: 8,
          stream: false,
        }),
      });

      if (!res.ok) {
        const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 90);
        console.log(`  ${res.status.toString().padEnd(4)} ${id}  ${body}`);
        continue;
      }

      const json = await res.json();
      const said = (json.choices?.[0]?.message?.content ?? '').trim().slice(0, 30);
      console.log(`  OK   ${id}  ${Date.now() - started}ms  "${said}"`);
    } catch (err) {
      console.log(`  ERR  ${id}  ${String(err).slice(0, 80)}`);
    }
  }
}

void main();
