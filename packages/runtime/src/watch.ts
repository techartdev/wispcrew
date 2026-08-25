/**
 * watch.ts — waking an agent when a file changes.
 *
 * The third way an agent starts working, alongside a cron schedule and a
 * follow-up it set for itself. Useful for the things a schedule handles
 * badly: "tell me when this log mentions an error", "run the tests when I
 * save".
 *
 * ## Debouncing is the whole problem
 *
 * A single save produces several filesystem events — editors write a temp
 * file, rename it, touch the directory — and a build produces thousands. An
 * agent woken once per event would run continuously, cost money, and be
 * useless.
 *
 * So changes are collected and the agent is woken once the directory has
 * been quiet for a moment, with a list of what changed. That turns a noisy
 * stream into one meaningful question.
 *
 * ## The path list is a hint, not an inventory
 *
 * Platforms coalesce events differently, and Windows does so aggressively:
 * writing 200 files in a burst produced *two* events, one of them with a
 * null filename. Measured, not assumed.
 *
 * So `onChange` receives some of what changed, not all of it. That suits the
 * purpose — the agent is being woken to go and look — but a caller must not
 * treat the list as complete.
 *
 * ## Why not a dependency
 *
 * `chokidar` handles more edge cases, but this app runs shell commands and
 * every dependency is a supply-chain decision. `fs.watch` with recursive
 * mode covers Windows and macOS natively, and Linux since Node 20 — the
 * platforms GhostBot ships on. The gap is that Linux support is newer, so
 * failure there is reported rather than assumed away.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileLog } from './filelog.js';

/**
 * How long the directory must be quiet before the agent is woken.
 *
 * Long enough that a save's several events, or a build's thousands, collapse
 * into one wake-up. Short enough that "run the tests when I save" still
 * feels immediate.
 */
const QUIET_PERIOD_MS = 2_000;

/** Never wake more often than this, however busy the directory is. */
const MIN_INTERVAL_MS = 10_000;

export interface WatchRequest {
  /** Directory to watch, already resolved and inside the workspace. */
  directory: string;
  /** Only wake for paths matching this, e.g. `*.log`. Unset means everything. */
  pattern?: string;
  /** Called once the directory has settled, with what changed. */
  onChange: (paths: string[]) => void;
}

export interface Watcher {
  stop(): void;
}

/**
 * Match a path against a simple glob.
 *
 * Deliberately not a full glob implementation: `*` and `?` cover what a user
 * types for this ("*.log", "src/*.ts"), and anything cleverer invites
 * mistakes that are hard to see in a pattern box.
 */
export function matchesPattern(filePath: string, pattern?: string): boolean {
  if (!pattern) return true;

  const normalised = filePath.replace(/\\/g, '/');
  const escaped = pattern
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');

  // Anchored at the end so "*.log" matches a nested path, which is what a
  // user means by it.
  return new RegExp(`(^|/)${escaped}$`).test(normalised);
}

/**
 * Watch a directory, waking the caller once it settles.
 *
 * Returns a watcher whose `stop` is safe to call twice — routines are
 * removed and re-added, and a double stop should not be an error the caller
 * has to guard against.
 */
export function watchDirectory(request: WatchRequest): Watcher {
  const { directory, pattern, onChange } = request;

  let pendingPaths = new Set<string>();
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFired = 0;
  let stopped = false;

  const flush = () => {
    quietTimer = null;
    if (stopped || pendingPaths.size === 0) return;

    /*
     * Respect the floor even after a quiet period.
     *
     * A directory that changes every three seconds would otherwise wake the
     * agent every three seconds — quiet by the letter of the rule, and
     * exactly the runaway this exists to prevent.
     */
    const since = Date.now() - lastFired;
    if (since < MIN_INTERVAL_MS) {
      quietTimer = setTimeout(flush, MIN_INTERVAL_MS - since);
      quietTimer.unref?.();
      return;
    }

    const paths = [...pendingPaths];
    pendingPaths = new Set();
    lastFired = Date.now();
    onChange(paths);
  };

  let native: fs.FSWatcher;
  try {
    native = fs.watch(directory, { recursive: true }, (_event, filename) => {
      if (stopped || !filename) return;

      const relative = filename.toString();
      if (!matchesPattern(relative, pattern)) return;

      pendingPaths.add(relative);
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(flush, QUIET_PERIOD_MS);
      // Never a reason to keep the process alive: a pending debounce should
      // not stop a daemon from exiting.
      quietTimer.unref?.();
    });
  } catch (err) {
    /*
     * Recursive watching is native on Windows and macOS and available on
     * Linux from Node 20, but a container or an unusual filesystem can still
     * refuse. Reported rather than swallowed: a watch that silently never
     * fires is worse than one that says it could not start.
     */
    fileLog('[watch] could not watch', directory, (err as Error).message);
    throw new Error(
      `Could not watch ${directory}: ${(err as Error).message}. ` +
        'Recursive watching may not be supported on this filesystem.',
    );
  }

  native.on('error', (err) => fileLog('[watch] error', directory, err.message));

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (quietTimer) clearTimeout(quietTimer);
      try {
        native.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Describe a watch for the user.
 *
 * Shown wherever a routine's schedule would be, so a watch reads as a peer
 * of "Hourly at :00" rather than as a special case.
 */
export function describeWatch(directory: string, pattern?: string): string {
  const name = path.basename(directory) || directory;
  return pattern ? `When ${pattern} changes in ${name}` : `When anything changes in ${name}`;
}
