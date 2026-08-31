/**
 * userdata-migration.ts — move user data from the pre-rebrand location.
 *
 * The app was renamed OpenAgent → WispCrew. Electron derives `userData`
 * from the app name, so the folder moved:
 *
 *   %APPDATA%\@openagent\desktop   (old, from package name "@openagent/desktop")
 *   %APPDATA%\WispCrew             (new, from app.setName('WispCrew'))
 *
 * The rebrand also renamed the files themselves (`openagent-*.json` →
 * `wispcrew-*.json`) and the env vars, so a straight folder copy is not
 * enough — each file is renamed as it is copied.
 *
 * This runs once: if the destination already holds data, nothing is copied.
 * Failure is never fatal — a fresh profile is better than refusing to boot.
 */
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileLog } from '@wispcrew/runtime';

/**
 * old basename → new basename
 *
 * Two renames deep now: OpenAgent → GhostBot → WispCrew. Both are listed
 * because a profile may have been left at either stage — someone who
 * installed once and never updated has an OpenAgent profile, and everyone
 * who used the last release has a GhostBot one.
 */
const FILE_RENAMES: Record<string, string> = {
  'openagent-settings.json': 'wispcrew-settings.json',
  'openagent-secrets.json': 'wispcrew-secrets.json',
  'openagent-secrets.enc': 'wispcrew-secrets.enc',
  'openagent-agents.json': 'wispcrew-agents.json',

  'ghostbot-settings.json': 'wispcrew-settings.json',
  'ghostbot-secrets.json': 'wispcrew-secrets.json',
  'ghostbot-secrets.enc': 'wispcrew-secrets.enc',
  'ghostbot-secrets-node.enc': 'wispcrew-secrets-node.enc',
};

/** Transcript files are per-agent: <product>-transcript-<id>.json */
const TRANSCRIPT_RE = /^(?:openagent|ghostbot)-transcript-(.+)\.json$/;

/**
 * Files that carry over unchanged.
 *
 * The engine's own storage lives here now — agents, routines, paired nodes,
 * the outbox and the node key are all product-neutral names, so they pass
 * through rather than being renamed.
 */
const PASSTHROUGH = new Set([
  'client-persistence.json',
  'agents.json',
  'routines.json',
  'skills.json',
  'nodes.json',
  'outbox.json',
  'grants.json',
  'node-key',
]);

/**
 * Directories that carry over whole.
 *
 * These hold the user's actual work. The previous migration had no concept
 * of directories at all, which is why it would have silently dropped every
 * conversation had transcripts not still been flat files at the time.
 */
const PASSTHROUGH_DIRS = new Set(['transcripts', 'checkpoints', 'skills', 'workspace']);

/**
 * Files that are dead and must NOT be carried forward.
 *
 * `ghostbot-agents.json` and `ghostbot-transcript-local-agent.json` are
 * sitting in real profiles right now, left by the last rename. Copying them
 * a second time would make them look deliberate to the next person.
 */
const OBSOLETE = new Set([
  'ghostbot-agents.json',
  'wispcrew-agents.json',
  'ghostbot-transcript-local-agent.json',
  'openagent-transcript-local-agent.json',
]);

/** Recursively copy a directory, returning how many files were written. */
function copyTree(from: string, to: string): number {
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyTree(source, target);
    else {
      fs.copyFileSync(source, target);
      count++;
    }
  }
  return count;
}

function candidateOldDirs(): string[] {
  const appData = app.getPath('appData');
  const home = os.homedir();

  return [
    /*
     * The platform-specific homes WispCrew used before `~/.wispcrew`.
     *
     * These hold a CURRENT user's real profile — agents, conversations,
     * keys — so they come first. Losing someone's roster to a tidier path
     * would be an unforgivable trade for the tidiness.
     */
    path.join(appData, 'WispCrew'),
    path.join(home, 'Library', 'Application Support', 'WispCrew'),
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'WispCrew'),

    // The immediately previous name, which is what an older user has.
    path.join(appData, 'GhostBot'),
    path.join(appData, 'ghostbot'),
    // Post-rebrand but pre-setName: builds that derived userData from the
    // package name before app.setName('WispCrew') was hoisted to module scope.
    path.join(appData, '@wispcrew', 'desktop'),
    // Older still.
    path.join(appData, 'OpenAgent'),
    path.join(appData, 'openagent'),
    path.join(appData, '@openagent', 'desktop'),
  ];
}

/**
 * Which old profile to adopt when several exist.
 *
 * Order alone is not enough. This machine has both an abandoned
 * `@openagent/desktop` folder and a live GhostBot one, and taking the first
 * that exists imported two stale files while silently ignoring two real
 * agents and six conversations — measured, not hypothetical.
 *
 * The most recently used profile is the one the user was actually working
 * in, so `agents.json` decides: whichever was written last wins, and a
 * profile without one loses to any profile that has one.
 */
function bestOldDir(candidates: string[]): string | undefined {
  let best: { dir: string; when: number } | undefined;

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;

    let when = 0;
    for (const marker of ['agents.json', 'wispcrew-agents.json', 'ghostbot-agents.json']) {
      try {
        when = Math.max(when, fs.statSync(path.join(dir, marker)).mtimeMs);
      } catch {
        /* not present */
      }
    }

    // A profile with no roster at all is still a candidate, but only if
    // nothing better turns up.
    if (!best || when > best.when) best = { dir, when };
  }

  return best?.dir;
}

function mapName(name: string): string | null {
  // Dead files are rejected before anything else, so a rename entry
  // cannot accidentally resurrect one.
  if (OBSOLETE.has(name)) return null;
  if (FILE_RENAMES[name]) return FILE_RENAMES[name];
  const m = TRANSCRIPT_RE.exec(name);
  if (m) return `wispcrew-transcript-${m[1]}.json`;
  if (PASSTHROUGH.has(name)) return name;
  // Already-renamed files (from an intermediate @wispcrew\desktop profile).
  if (name.startsWith('wispcrew-')) return name;
  return null; // unknown file: leave it behind
}

/**
 * Ensure the app name is WispCrew, then import any pre-rebrand profile.
 * Returns the resolved userData directory.
 */
export function migrateUserData(): string {
  // NOTE: `app.setName('WispCrew')` must already have run at module scope in
  // main.ts — Electron caches the userData path on first access, so setting
  // the name here would be too late and data would land in the
  // package-derived %APPDATA%\@wispcrew\desktop folder instead.
  /*
   * `~/.wispcrew`, not Electron's `userData`.
   *
   * One path on every platform, and one a person can find, back up and
   * delete without knowing what `%APPDATA%` means. Electron's own choice is
   * now just another directory to migrate FROM — the desktop and the daemon
   * must agree, and `defaultDataDir()` in the daemon says the same thing.
   */
  const userDataDir = path.join(os.homedir(), '.wispcrew');

  try {
    fs.mkdirSync(userDataDir, { recursive: true });

    /*
     * Has this profile been used?
     *
     * The original test was "a file starting with wispcrew-", which fails
     * for a GhostBot profile — it has none, so a second launch would try to
     * migrate again on top of live data. `agents.json` is the honest
     * marker: it appears the moment anything real happens, whatever the
     * product was called.
     */
    const existing = fs.readdirSync(userDataDir);
    const alreadyHasData =
      existing.includes('agents.json') || existing.some((f) => f.startsWith('wispcrew-'));
    if (alreadyHasData) return userDataDir;

    const oldDir = bestOldDir(candidateOldDirs().filter((d) => d !== userDataDir));
    if (!oldDir) return userDataDir;

    let copied = 0;
    for (const entry of fs.readdirSync(oldDir, { withFileTypes: true })) {
      const name = entry.name;
      const from = path.join(oldDir, name);

      /*
       * Directories hold the user's actual work.
       *
       * The original version copied files only, which was correct when
       * transcripts were flat `<product>-transcript-<id>.json` files. They
       * now live in `transcripts/`, so a file-only migration would silently
       * drop every conversation — along with checkpoints and skills.
       */
      if (entry.isDirectory()) {
        if (!PASSTHROUGH_DIRS.has(name)) continue;
        const to = path.join(userDataDir, name);
        if (fs.existsSync(to)) continue;
        copied += copyTree(from, to);
        continue;
      }

      const target = mapName(name);
      if (!target) continue;
      const to = path.join(userDataDir, target);
      if (fs.existsSync(to)) continue;
      fs.copyFileSync(from, to);
      copied++;
    }

    if (copied > 0) {
      fileLog('[migrate] imported', String(copied), 'files from', oldDir);
      console.log(`[migrate] imported ${copied} file(s) from ${oldDir}`);
    }
  } catch (err) {
    fileLog('[migrate] failed', (err as Error).message);
  }

  return userDataDir;
}
