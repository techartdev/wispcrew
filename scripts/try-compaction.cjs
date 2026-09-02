/**
 * try-compaction.cjs — compact a COPY of a real conversation.
 *
 *   node scripts/try-compaction.cjs "<agent or room>"
 *
 * Copies the whole profile to a temp directory first. Compaction rewrites
 * somebody's conversation, and proving it works must not be the thing that
 * damages the conversation being proved on.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rt = require('../packages/runtime/dist/index.js');

const src = path.join(os.homedir(), '.wispcrew');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-compact-'));

// The store, the transcripts and the secrets, so the provider actually works.
for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name);
  if (fs.statSync(from).isDirectory()) {
    if (name === 'checkpoints') continue;
    fs.cpSync(from, path.join(box, name), { recursive: true });
  } else {
    fs.copyFileSync(from, path.join(box, name));
  }
}

rt.setHost({
  dataDir: box,
  defaultWorkspaceRoot: box,
  nodeName: 'compaction-probe',
  crypto: rt.createNodeCrypto(box),
});
rt.initStore(box);

const wanted = process.argv[2];

async function main() {
  const room =
    rt.listConversations().find((c) => c.id === wanted) ||
    rt.listConversations().find((c) => c.title.toLowerCase() === String(wanted).toLowerCase());

  if (!room) {
    console.error(`no conversation "${wanted}"`);
    process.exit(1);
  }

  const before = rt.loadTranscript(room.id);
  const beforeReport = await rt.getContextReport(room.id);
  console.log(`"${room.title}"`);
  console.log(`  ${before.length} entries, ~${beforeReport.used} tokens\n`);

  const started = Date.now();
  const result = await rt.compactConversation(room.id);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (!result.ok) {
    console.log(`refused after ${secs}s: ${result.reason}`);
    fs.rmSync(box, { recursive: true, force: true });
    return;
  }

  const after = rt.loadTranscript(room.id);
  const afterReport = await rt.getContextReport(room.id);

  console.log(`compacted in ${secs}s`);
  console.log(`  replaced ${result.replaced}, kept ${result.kept}`);
  console.log(`  ${before.length} -> ${after.length} entries`);
  console.log(`  ~${beforeReport.used} -> ~${afterReport.used} tokens\n`);

  // The recent turns must be untouched, not merely present.
  const tail = before.slice(before.length - result.kept);
  const same = JSON.stringify(tail) === JSON.stringify(after.slice(1));
  console.log(`  kept turns byte-identical: ${same}`);

  // And the previous version must be recoverable.
  const checkpoints = rt.listCheckpoints(box, room.id);
  console.log(`  checkpoints: ${checkpoints.length} (${checkpoints[0]?.reason ?? 'none'})`);
  const restored = checkpoints[0] ? rt.readCheckpoint(checkpoints[0].file) : null;
  console.log(`  restores ${restored?.length ?? 0} entries\n`);

  console.log('--- the summary ---');
  console.log(String(after[0]?.text ?? '').slice(0, 1400));

  fs.rmSync(box, { recursive: true, force: true });
}

void main();
