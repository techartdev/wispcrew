/**
 * transcript-writer.ts — one writer at a time, across processes.
 *
 * ## The corruption this prevents
 *
 * A room transcript was found on disk containing this:
 *
 *     "...the token endpoint sits behCommitted asind the same
 *      infrastructure and never got the same treatment."
 *
 * One agent's sentence with another's spliced into it mid-word, and below
 * it the same message stored twice under two ids in the same second.
 * Neither model misbehaved. The transcript layer was written when a
 * conversation had one writer, and this profile has two PROCESSES writing:
 * the daemon, which runs turns, and the desktop main process, which writes
 * user messages and notices. Both did read-modify-write on the same JSON
 * file, and streaming rewrites that file on every token — so whoever wrote
 * second silently discarded everything the other had done since it read.
 *
 * ## Why a lock, and not agents taking turns
 *
 * The tempting fix is to have agents coordinate. That makes the integrity
 * of the STORE depend on the judgement of a MODEL, which is exactly
 * backwards. A capable model mostly complies; a small self-hosted one will
 * not, and neither will two agents that simply stream at the same instant.
 * An agent must be UNABLE to corrupt the room, not merely disinclined to.
 *
 * ## Why it is synchronous
 *
 * The first version queued writes on a promise chain. It serialised
 * correctly and broke eleven existing tests, because `pushTranscript` is
 * called from dozens of synchronous places that read the transcript back on
 * the very next line. Deferring the write turned every one of those into a
 * read-before-write.
 *
 * That is not a test artefact — it is the real contract. `pushTranscript`
 * promises the entry is stored when it returns, and callers depend on it.
 * So the lock spins synchronously instead: a transcript write is a
 * sub-millisecond file operation, contention is rare, and blocking briefly
 * is far cheaper than rewriting every call site to be async.
 *
 * Within one process this is already safe — `upsertTranscriptEntry` has no
 * await inside, so Node cannot interleave two of them. The lock exists for
 * the cross-process case, which is the one that actually bit.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TranscriptEntry } from '@wispcrew/shared';
import * as store from './store.js';
import { fileLog } from './filelog.js';

/**
 * How long a lock may be held before it is presumed abandoned.
 *
 * Generous next to a write, which is milliseconds. The asymmetry matters:
 * breaking a live lock reintroduces the corruption, while waiting slightly
 * too long merely delays one entry.
 */
const STALE_MS = 10_000;

/**
 * How long to spin before writing anyway.
 *
 * Bounded because losing the user's words is worse than risking a rare
 * interleave. Exceeding it is logged, since a lock that never frees is a
 * bug worth seeing rather than a condition to absorb silently.
 */
const MAX_SPIN_MS = 2_000;

function lockPath(conversationId: string): string {
  const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(store.transcriptDirPath(), `${safe}.lock`);
}

/**
 * Take the cross-process lock, or report that we could not.
 *
 * `wx` — exclusive create — is the portable atomic test-and-set: it
 * succeeds for exactly one caller and throws EEXIST for everyone else.
 * The holder's pid and timestamp go inside, so a lock left by a process
 * that died can be identified by age rather than guessed at.
 */
function acquire(file: string): boolean {
  const deadline = Date.now() + MAX_SPIN_MS;

  for (;;) {
    try {
      const handle = fs.openSync(file, 'wx');
      try {
        fs.writeSync(handle, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        fs.closeSync(handle);
      }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;

      /*
       * The directory may not exist yet on a brand-new profile. Create it
       * and retry rather than failing the write.
       */
      if (code === 'ENOENT') {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          continue;
        } catch {
          return false;
        }
      }

      if (code !== 'EEXIST') return false;

      /*
       * Somebody holds it. A process killed mid-write would otherwise wedge
       * this conversation permanently, which is a worse failure than the one
       * being fixed — so an old lock is broken.
       */
      let stale = false;
      try {
        const held = JSON.parse(fs.readFileSync(file, 'utf8')) as { at?: number };
        stale = typeof held.at !== 'number' || Date.now() - held.at > STALE_MS;
      } catch {
        // Unreadable or half-written: treat as stale rather than wedging.
        stale = true;
      }

      if (stale) {
        fileLog('[transcript] breaking stale lock on', path.basename(file));
        try {
          fs.rmSync(file, { force: true });
        } catch {
          return false;
        }
        continue;
      }

      if (Date.now() >= deadline) return false;

      /*
       * Busy-wait briefly. `Atomics.wait` would be tidier but needs a shared
       * buffer the other PROCESS cannot see, and the whole point here is
       * that the contending writer is in a different process.
       */
      const until = Date.now() + 2;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

function release(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* the next writer's staleness check clears it */
  }
}

/**
 * Run `work` with the conversation's write lock held.
 *
 * Per conversation, not global: two rooms share nothing, and one lock for
 * everything would make every agent wait on every other agent's disk I/O.
 */
export function withTranscriptLock<T>(conversationId: string, work: () => T): T {
  const file = lockPath(conversationId);
  const held = acquire(file);

  if (!held) {
    /*
     * Writing anyway is the lesser evil — dropping the entry loses somebody's
     * words — but it is recorded, because a lock that cannot be taken means
     * something is wrong that prose in a comment will not fix.
     */
    fileLog('[transcript] lock unavailable, writing unguarded', conversationId);
    return work();
  }

  try {
    return work();
  } finally {
    release(file);
  }
}

/**
 * Insert or replace an entry with the lock held.
 *
 * The only supported write path for anything that can run concurrently —
 * which, in a room, is everything.
 */
export function upsertEntryLocked(
  conversationId: string,
  entry: TranscriptEntry,
): TranscriptEntry[] {
  return withTranscriptLock(conversationId, () =>
    store.upsertTranscriptEntry(conversationId, entry),
  );
}
