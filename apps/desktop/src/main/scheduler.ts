/**
 * scheduler.ts — drives routines on their cron schedules.
 *
 * A single timer ticks once a minute (aligned to the wall-clock minute) and
 * fires any routine whose expression matches. One timer for all routines,
 * rather than one per routine, keeps behaviour predictable when routines are
 * added, edited, or deleted while the app runs.
 *
 * Design decisions worth knowing:
 *
 *  - **Missed ticks are not replayed.** If the machine sleeps for six hours,
 *    the routine does not fire six times on wake. Catch-up storms are almost
 *    never what a user wants from "post a standup summary at 09:00", and a
 *    burst of agent runs costs real API money.
 *
 *  - **A routine never overlaps itself.** If the previous run is still going
 *    when the next tick matches, the tick is recorded as `skipped` rather
 *    than queued. Agents can run for minutes; queueing would compound.
 *
 *  - **Firing is best-effort and never throws into the timer.** A failing
 *    routine records an `error` run and the scheduler keeps going.
 *
 *  - **The tick is idempotent per minute.** We remember the last fired minute
 *    per routine so a slightly early/late timer cannot double-fire.
 */
import type { RoutineRecord } from '@ghostbot/shared';
import { listRoutines, recordRoutineRun, updateRoutine, newId } from './store.js';
import { matches, nextRun, parseCron, systemTimeZone } from './cron.js';
import { fileLog } from './filelog.js';

/** Runs a routine's prompt through its agent. Injected to avoid a cycle. */
export type RoutineRunner = (routine: RoutineRecord) => Promise<void>;

let timer: ReturnType<typeof setTimeout> | null = null;
let runner: RoutineRunner | null = null;
let onChange: (() => void) | null = null;

/** Routine ids currently executing (overlap guard). */
const inFlight = new Set<string>();
/** routineId → "YYYY-MM-DDTHH:MM" of the last minute we fired it. */
const lastFiredMinute = new Map<string, string>();

/** Stable minute key for de-duplication, independent of timezone. */
function minuteKey(date: Date): string {
  return date.toISOString().slice(0, 16);
}

/**
 * Start the scheduler. `run` executes a routine's prompt; `notify` is called
 * whenever routine records change so the UI can refresh.
 */
export function startScheduler(run: RoutineRunner, notify?: () => void): void {
  runner = run;
  onChange = notify ?? null;
  refreshNextRunTimes();
  scheduleNextTick();
  fileLog('[scheduler] started');
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  runner = null;
  fileLog('[scheduler] stopped');
}

/**
 * Sleep until the top of the next minute, then tick.
 *
 * Re-arming from the actual clock each time (rather than setInterval) keeps
 * the scheduler aligned after system sleep or clock drift.
 */
function scheduleNextTick(): void {
  if (timer) clearTimeout(timer);
  const now = Date.now();
  const msIntoMinute = now % 60_000;
  // +250ms so we land just inside the new minute, never a hair before it.
  const delay = 60_000 - msIntoMinute + 250;
  timer = setTimeout(() => {
    void tick().finally(scheduleNextTick);
  }, delay);
  // Don't let the timer hold the process open at quit time.
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
}

/** Evaluate every enabled routine against the current minute. */
async function tick(): Promise<void> {
  if (!runner) return;
  const now = new Date();
  const key = minuteKey(now);

  for (const routine of listRoutines()) {
    if (!routine.enabled) continue;

    let fields;
    try {
      fields = parseCron(routine.cron);
    } catch (err) {
      // A malformed expression should not silently do nothing forever.
      fileLog('[scheduler] invalid cron', routine.id, (err as Error).message);
      continue;
    }

    const zone = routine.timezone || systemTimeZone();
    if (!matches(fields, now, zone)) continue;
    if (lastFiredMinute.get(routine.id) === key) continue;
    lastFiredMinute.set(routine.id, key);

    if (inFlight.has(routine.id)) {
      recordRoutineRun(routine.id, {
        id: newId('run'),
        startedAt: now.getTime(),
        finishedAt: now.getTime(),
        status: 'skipped',
        summary: 'Previous run was still in progress.',
      });
      onChange?.();
      continue;
    }

    void fireRoutine(routine);
  }
}

/** Execute one routine, recording start/finish and refreshing `nextRunAt`. */
async function fireRoutine(routine: RoutineRecord): Promise<void> {
  if (!runner) return;
  const runId = newId('run');
  const startedAt = Date.now();
  inFlight.add(routine.id);

  recordRoutineRun(routine.id, { id: runId, startedAt, status: 'running' });
  onChange?.();
  fileLog('[scheduler] firing', routine.id, routine.name);

  try {
    await runner(routine);
    recordRoutineRun(routine.id, {
      id: runId,
      startedAt,
      finishedAt: Date.now(),
      status: 'ok',
    });
  } catch (err) {
    recordRoutineRun(routine.id, {
      id: runId,
      startedAt,
      finishedAt: Date.now(),
      status: 'error',
      summary: (err as Error).message.slice(0, 300),
    });
    fileLog('[scheduler] routine failed', routine.id, (err as Error).message);
  } finally {
    inFlight.delete(routine.id);
    refreshNextRunTime(routine.id);
    onChange?.();
  }
}

/** Fire a routine immediately, bypassing the schedule ("Test run"). */
export async function runRoutineNow(routineId: string): Promise<void> {
  const routine = listRoutines().find((r) => r.id === routineId);
  if (!routine) throw new Error(`No such routine: ${routineId}`);
  if (inFlight.has(routineId)) throw new Error('That routine is already running.');
  await fireRoutine(routine);
}

/** True when a routine is executing right now (drives a UI spinner). */
export function isRoutineRunning(routineId: string): boolean {
  return inFlight.has(routineId);
}

/** Recompute and persist `nextRunAt` for one routine. */
export function refreshNextRunTime(routineId: string): void {
  const routine = listRoutines().find((r) => r.id === routineId);
  if (!routine) return;
  try {
    const next = routine.enabled
      ? nextRun(routine.cron, new Date(), routine.timezone || systemTimeZone())
      : null;
    updateRoutine(routineId, { nextRunAt: next?.getTime() });
  } catch {
    // Invalid cron: leave nextRunAt cleared so the UI can flag it.
    updateRoutine(routineId, { nextRunAt: undefined });
  }
}

/** Recompute `nextRunAt` for every routine (startup, and after edits). */
export function refreshNextRunTimes(): void {
  for (const r of listRoutines()) refreshNextRunTime(r.id);
}
