/**
 * watch-manager.ts — keeping filesystem watchers in step with routines.
 *
 * The scheduler owns a clock; this owns watchers. Both wake the same
 * routines through the same runner, so a watch-triggered run records its
 * history and reports failures exactly like a scheduled one.
 */
import type { RoutineRecord } from '@wispcrew/shared';
import { fileLog } from './filelog.js';
import { listRoutines, newId, recordRoutineRun } from './store.js';
import { watchDirectory, type Watcher } from './watch.js';

type RoutineRunner = (routine: RoutineRecord) => Promise<void>;

const watchers = new Map<string, Watcher>();
const inFlight = new Set<string>();
let runner: RoutineRunner | null = null;
let notify: (() => void) | undefined;

/**
 * Start or update watchers to match the current routines.
 *
 * Called at startup and whenever routines change. Comparing what is running
 * against what should be running is simpler than tracking individual edits,
 * and it self-heals: a watcher that failed to start is retried on the next
 * sync rather than being lost until restart.
 */
export function syncWatches(run: RoutineRunner, onChange?: () => void): void {
  runner = run;
  notify = onChange;

  const wanted = listRoutines().filter((r) => r.watchPath && r.enabled !== false);
  const wantedIds = new Set(wanted.map((r) => r.id));

  // Stop watchers whose routine was removed, disabled, or repointed.
  for (const [id, watcher] of watchers) {
    if (!wantedIds.has(id)) {
      watcher.stop();
      watchers.delete(id);
      fileLog('[watch] stopped', id);
    }
  }

  for (const routine of wanted) {
    if (watchers.has(routine.id)) continue;
    try {
      const watcher = watchDirectory({
        directory: routine.watchPath!,
        pattern: routine.watchPattern,
        onChange: (paths) => void fireWatch(routine.id, paths),
      });
      watchers.set(routine.id, watcher);
      fileLog('[watch] watching', routine.watchPath!, 'for', routine.name);
    } catch (err) {
      /*
       * A watch that cannot start is recorded as a failed run.
       *
       * The alternative is a routine that looks enabled and never fires,
       * which is the worst outcome: the user believes they are being
       * watched when they are not.
       */
      recordRoutineRun(routine.id, {
        id: newId('run'),
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: 'error',
        summary: (err as Error).message.slice(0, 300),
      });
      notify?.();
    }
  }
}

/** Run a routine because files changed. */
async function fireWatch(routineId: string, paths: string[]): Promise<void> {
  if (!runner) return;

  /*
   * Skip rather than queue when a run is already in progress.
   *
   * A routine that reacts to file changes and itself writes files could
   * otherwise trigger itself indefinitely. Skipping is recorded so the user
   * can see it happened.
   */
  if (inFlight.has(routineId)) {
    recordRoutineRun(routineId, {
      id: newId('run'),
      startedAt: Date.now(),
      finishedAt: Date.now(),
      status: 'skipped',
      summary: 'Files changed while the previous run was still working.',
    });
    notify?.();
    return;
  }

  const routine = listRoutines().find((r) => r.id === routineId);
  if (!routine) return;

  inFlight.add(routineId);
  const runId = newId('run');
  const startedAt = Date.now();
  recordRoutineRun(routineId, { id: runId, startedAt, status: 'running' });
  notify?.();

  /*
   * Tell the agent what changed.
   *
   * The list is a hint rather than an inventory — platforms coalesce events,
   * and Windows heavily — so the prompt says "including" and invites the
   * agent to look for itself.
   */
  const changed = paths.slice(0, 20).join(', ');
  const withContext: RoutineRecord = {
    ...routine,
    prompt:
      `${routine.prompt}\n\n` +
      `(Files changed under ${routine.watchPath}, including: ${changed}. ` +
      'Check the directory for the full picture.)',
  };

  try {
    await runner(withContext);
    recordRoutineRun(routineId, { id: runId, startedAt, finishedAt: Date.now(), status: 'ok' });
  } catch (err) {
    recordRoutineRun(routineId, {
      id: runId,
      startedAt,
      finishedAt: Date.now(),
      status: 'error',
      summary: (err as Error).message.slice(0, 300),
    });
    fileLog('[watch] run failed', routineId, (err as Error).message);
  } finally {
    inFlight.delete(routineId);
    notify?.();
  }
}

/** Stop every watcher. Used at shutdown. */
export function stopWatches(): void {
  for (const watcher of watchers.values()) watcher.stop();
  watchers.clear();
}

/** How many watchers are active; used for diagnostics and tests. */
export function activeWatchCount(): number {
  return watchers.size;
}
