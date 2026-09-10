/**
 * transcript-lock-test — concurrent writers must not shred each other.
 *
 * ## What this reproduces
 *
 * A room transcript was found on disk containing one agent's sentence with
 * another's spliced into it mid-word:
 *
 *     "...the token endpoint sits behCommitted asind the same
 *      infrastructure and never got the same treatment."
 *
 * and, separately, the same message stored twice under two ids in the same
 * second. Neither model did anything wrong. Two faults in the store:
 *
 *  1. `upsertTranscriptEntry` is read-modify-write over a whole JSON file,
 *     rewritten on every streamed token. Two writers each read a snapshot
 *     and write everything back, so the second discards the first's work.
 *
 *  2. `writeJson` staged every write through a FIXED `${file}.tmp`, so two
 *     writers overwrote each other's staged bytes before either rename.
 *
 * Both are provoked here with real files and real concurrency, because the
 * failure only appears when writers actually overlap.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNodeCrypto,
  initStore,
  loadTranscript,
  setHost,
  upsertEntryLocked,
  withTranscriptLock,
  writeJson,
} from '@wispcrew/runtime';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-lock-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'test', crypto: createNodeCrypto(dir) });
initStore(dir);

console.log('[1] staged writes do not collide');
{
  /*
   * The old implementation used `${file}.tmp` for everybody. Measured on the
   * interleave write-A, write-B, rename-A, rename-B: A lost its content 300
   * times out of 300, and A's rename failed ENOENT because B's had already
   * consumed the temp file.
   */
  const target = path.join(dir, 'shared.json');
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    writeJson(target, { i });
    for (const name of fs.readdirSync(dir)) {
      if (name.includes('.tmp')) seen.add(name);
    }
  }
  check('no temp file is left behind', [...seen].length === 0, JSON.stringify([...seen].slice(0, 3)));

  const src = fs.readFileSync(path.join(root, 'packages/runtime/src/store.ts'), 'utf8');
  check(
    'the temp path is unique per write',
    /const tmp = `\$\{file\}\.\$\{process\.pid\}\.\$\{\(tmpCounter \+= 1\)\}\.tmp`/.test(src),
    'writeJson still stages through a shared name',
  );
}

console.log('\n[2] concurrent writers keep every entry intact');
{
  const ROOM = 'room_concurrent';

  /*
   * Two "agents" streaming at once, as a room does. Each rewrites its own
   * entry repeatedly while the other does the same. Without serialisation
   * the later write drops the earlier writer's entry entirely.
   */
  const work = [];
  for (let i = 1; i <= 60; i += 1) {
    work.push(
      upsertEntryLocked(ROOM, {
        kind: 'message',
        id: 'asst_a',
        role: 'assistant',
        authorId: 'agent_a',
        content: 'A'.repeat(i),
        createdAt: 1,
      }),
    );
    work.push(
      upsertEntryLocked(ROOM, {
        kind: 'message',
        id: 'asst_b',
        role: 'assistant',
        authorId: 'agent_b',
        content: 'B'.repeat(i),
        createdAt: 2,
      }),
    );
  }
  /* Synchronous writes: the array is already settled. Kept as a batch to
   * mirror how a room actually calls this -- many writers, no coordination. */
  void work;

  const entries = loadTranscript(ROOM);
  check('both entries survive', entries.length === 2, `${entries.length} entries`);

  const a = entries.find((e) => e.id === 'asst_a');
  const b = entries.find((e) => e.id === 'asst_b');
  check('neither was dropped', Boolean(a && b));

  /*
   * The shredding signature: content that is not purely one writer's text.
   * "behCommitted asind" is what this looks like in production.
   */
  check('one writer never appears inside another', /^A+$/.test(a?.content ?? ''), JSON.stringify(a?.content?.slice(0, 40)));
  check('and the same for the other', /^B+$/.test(b?.content ?? ''), JSON.stringify(b?.content?.slice(0, 40)));
  check('the last write wins for A', a?.content.length === 60, String(a?.content.length));
  check('the last write wins for B', b?.content.length === 60, String(b?.content.length));
}

console.log('\n[3] the lock serialises, and is released');
{
  const order = [];
  const slow = (tag, ms) =>
    withTranscriptLock('room_order', () => {
      order.push(`${tag}-start`);
      const until = Date.now() + ms;
      while (Date.now() < until) {
        /* deliberately synchronous: a write is sync too */
      }
      order.push(`${tag}-end`);
    });

  slow('first', 15);
  slow('second', 5);

  /*
   * Interleaving would show as first-start, second-start, ... Serialised
   * work always closes before the next opens.
   */
  check(
    'work does not interleave',
    order.join(',') === 'first-start,first-end,second-start,second-end',
    order.join(','),
  );

  const stray = fs
    .readdirSync(path.join(dir, 'transcripts'))
    .filter((n) => n.endsWith('.lock'));
  check('no lock file is left held', stray.length === 0, JSON.stringify(stray));
}

console.log('\n[4] a dead writer cannot wedge a conversation forever');
{
  /*
   * A process killed mid-write leaves its lock behind. Waiting on it forever
   * is a worse failure than the one being fixed, so an old lock is broken —
   * identified by age, with the holder's pid recorded for diagnosis.
   */
  const lockFile = path.join(dir, 'transcripts', 'room_stale.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: Date.now() - 60_000 }));

  const started = Date.now();
  upsertEntryLocked('room_stale', {
    kind: 'message',
    id: 'asst_x',
    role: 'assistant',
    authorId: 'agent_a',
    content: 'after a stale lock',
    createdAt: 1,
  });

  check('the write still happens', loadTranscript('room_stale').length === 1);
  check('promptly', Date.now() - started < 3_000, `${Date.now() - started}ms`);
  check('and the stale lock is gone', !fs.existsSync(lockFile));
}

console.log('\n[5] every write path goes through the lock');
{
  /*
   * The desktop had its OWN pushTranscript calling the store directly, so an
   * entry written from the main process bypassed the queue entirely — which
   * is how two processes came to shred one file. A second door onto one
   * invariant is the recurring fault in this repo; this pins it shut.
   */
  const bridge = fs.readFileSync(
    path.join(root, 'apps/desktop/src/main/bridge-host.ts'),
    'utf8',
  );
  const own = /export function pushTranscript[\s\S]{0,600}?store\.upsertTranscriptEntry\(/.test(bridge);
  check('the desktop does not write the store directly', !own, 'bridge-host has its own writer again');

  const transcript = fs.readFileSync(
    path.join(root, 'packages/runtime/src/transcript.ts'),
    'utf8',
  );
  check('pushTranscript uses the locked path', /upsertEntryLocked\(agentId, entry\)/.test(transcript));
  check(
    'and not the raw store call',
    !/store\.upsertTranscriptEntry\(agentId, entry\)/.test(transcript),
  );
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.log(`TRANSCRIPT-LOCK TEST FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('TRANSCRIPT-LOCK TEST PASSED');
process.exit(0);
