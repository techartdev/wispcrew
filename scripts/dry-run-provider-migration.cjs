/**
 * dry-run-provider-migration.cjs — run the provider migration on a COPY of
 * the real profile, and print what it would do.
 *
 * A migration that rewrites the roster is a migration that can lose it, and
 * this one runs at startup in both hosts. Seeing its decisions on real data
 * before it touches real data is cheap.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  setHost,
  createNodeCrypto,
  initStore,
  listAgents,
  migrateAgentsToExplicitProvider,
} = require('../packages/runtime/dist/index.js');

const real = path.join(os.homedir(), '.wispcrew');
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-dryrun-'));

// Only the files the migration reads and writes. Copying the secrets would
// put real credentials in a temp directory for no benefit.
for (const name of ['agents.json', 'wispcrew-settings.json']) {
  const from = path.join(real, name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(copy, name));
}

setHost({ dataDir: copy, defaultWorkspaceRoot: copy, nodeName: 'dry', crypto: createNodeCrypto(copy) });
initStore(copy);

console.log('BEFORE');
for (const a of listAgents()) {
  console.log(
    `  ${a.name.padEnd(26)} provider=${String(a.presetId ?? '(inherit)').padEnd(22)} model=${String(a.model ?? '(inherit)')}`,
  );
}

const result = migrateAgentsToExplicitProvider();

console.log('\nFILLED IN');
if (result.filled.length === 0) console.log('  (nothing — every agent was already explicit)');
for (const a of result.filled) console.log(`  ${a.name.padEnd(26)} -> ${a.presetId} / ${a.model}`);

console.log('\nUNUSABLE PAIRINGS');
if (result.broken.length === 0) console.log('  (none)');
for (const b of result.broken) console.log(`  ${b.name.padEnd(26)} ${b.presetId} / ${b.model}\n    ${b.why}`);

console.log('\nAFTER');
for (const a of listAgents()) {
  console.log(
    `  ${a.name.padEnd(26)} provider=${String(a.presetId).padEnd(22)} model=${String(a.model)}`,
  );
}

// Idempotence is what makes it safe for two hosts to both run it at startup.
const again = migrateAgentsToExplicitProvider();
console.log(`\nSECOND RUN filled ${again.filled.length} (should be 0)`);

fs.rmSync(copy, { recursive: true, force: true });
