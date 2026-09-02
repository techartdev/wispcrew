/**
 * checkpoint-test.mjs — a destroyed conversation can be recovered.
 *
 * A transcript is written whole, so any write that shortens one loses the
 * difference permanently. During development a careless cleanup erased a
 * real 33-entry conversation with nothing to restore from. This is the
 * safety net for that.
 *
 * Offline: files only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgent,
  createNodeCrypto,
  initStore,
  listCheckpoints,
  loadTranscript,
  readCheckpoint,
  saveTranscript,
  setHost,
  upsertTranscriptEntry,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-ckpt-'));
setHost({
  dataDir: dir,
  defaultWorkspaceRoot: dir,
  nodeName: 'test',
  crypto: createNodeCrypto(dir),
});
initStore(dir);

const agent = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Valuable conversation' });

const entry = (i) => ({
  kind: 'message',
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  content: `message number ${i}`,
  createdAt: Date.now() + i,
});

console.log('\n[growing] streaming does not checkpoint on every token');
{
  for (let i = 0; i < 20; i++) upsertTranscriptEntry(agent.id, entry(i));
  check('the transcript grew', loadTranscript(agent.id).length === 20);
  // Thousands of copies per conversation would be pure churn: a growing
  // transcript has lost nothing, since the old state is a prefix of the new.
  check('no checkpoints were taken', listCheckpoints(dir, agent.id).length === 0,
    String(listCheckpoints(dir, agent.id).length));
}

console.log('\n[the disaster] a cleanup that removes most of a conversation');
{
  const before = loadTranscript(agent.id);
  // Exactly the shape of the real incident: a filter that matched far more
  // than intended.
  const survivors = before.filter((e) => e.id === 'm19');
  saveTranscript(agent.id, survivors, 'cleanup');

  check('the transcript really was shortened', loadTranscript(agent.id).length === 1);

  const points = listCheckpoints(dir, agent.id);
  check('a checkpoint was taken', points.length === 1, String(points.length));
  check('it holds the entries that were lost', points[0]?.entries === 20, String(points[0]?.entries));
  check('and records why', points[0]?.reason === 'cleanup', points[0]?.reason);
}

console.log('\n[recovery] the conversation comes back');
{
  const points = listCheckpoints(dir, agent.id);
  const restored = readCheckpoint(points[0].file);
  check('the checkpoint reads', Array.isArray(restored) && restored.length === 20,
    String(restored?.length));
  check('with the original content', restored?.[5]?.content === 'message number 5',
    restored?.[5]?.content);

  saveTranscript(agent.id, restored, 'restore');
  check('the transcript is whole again', loadTranscript(agent.id).length === 20);
}

console.log('\n[clear] clearing a conversation is also recoverable');
{
  const beforeCount = listCheckpoints(dir, agent.id).length;
  saveTranscript(agent.id, [], 'clear');
  check('the transcript is empty', loadTranscript(agent.id).length === 0);
  check('but a checkpoint was kept', listCheckpoints(dir, agent.id).length > beforeCount);
}

console.log('\n[retention] old checkpoints are pruned, newest kept');
{
  for (let round = 0; round < 15; round++) {
    saveTranscript(agent.id, [entry(0), entry(1), entry(2)], 'seed');
    saveTranscript(agent.id, [entry(0)], `shrink ${round}`);
  }
  const points = listCheckpoints(dir, agent.id);
  check('retention is bounded', points.length <= 10, String(points.length));
  check('newest first', points.every((p, i) => i === 0 || points[i - 1].createdAt >= p.createdAt));
  // Losing the *recent* ones would defeat the purpose: a mistake is usually
  // noticed within a few actions.
  check('the most recent is retained', points[0]?.reason?.startsWith('shrink'), points[0]?.reason);
}

console.log('\n[isolation] one agent cannot see another\'s checkpoints');
{
  const other = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Unrelated' });
  saveTranscript(other.id, [entry(0), entry(1)], 'seed');
  saveTranscript(other.id, [], 'clear');

  const mine = listCheckpoints(dir, agent.id);
  check('checkpoints are per agent', mine.every((p) => p.agentId === agent.id));
  check('the other agent has its own', listCheckpoints(dir, other.id).length === 1);
}

console.log('\n[robust] a corrupt checkpoint does not break listing');
{
  fs.writeFileSync(path.join(dir, 'checkpoints', `${agent.id}.9999999999999.json`), 'not json');
  const points = listCheckpoints(dir, agent.id);
  check('listing still works', Array.isArray(points) && points.length > 0);
  check('and skips the damaged one', !points.some((p) => p.createdAt === 9999999999999));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`CHECKPOINT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CHECKPOINT TEST PASSED\n');
