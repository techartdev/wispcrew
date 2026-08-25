/**
 * userdata-migration.ts — move user data from the pre-rebrand location.
 *
 * The app was renamed OpenAgent → GhostBot. Electron derives `userData`
 * from the app name, so the folder moved:
 *
 *   %APPDATA%\@openagent\desktop   (old, from package name "@openagent/desktop")
 *   %APPDATA%\GhostBot             (new, from app.setName('GhostBot'))
 *
 * The rebrand also renamed the files themselves (`openagent-*.json` →
 * `ghostbot-*.json`) and the env vars, so a straight folder copy is not
 * enough — each file is renamed as it is copied.
 *
 * This runs once: if the destination already holds data, nothing is copied.
 * Failure is never fatal — a fresh profile is better than refusing to boot.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileLog } from '@ghostbot/runtime';

/** old basename → new basename */
const FILE_RENAMES: Record<string, string> = {
  'openagent-settings.json': 'ghostbot-settings.json',
  'openagent-secrets.json': 'ghostbot-secrets.json',
  'openagent-secrets.enc': 'ghostbot-secrets.enc',
  'openagent-agents.json': 'ghostbot-agents.json',
};

/** Transcript files are per-agent: openagent-transcript-<id>.json */
const TRANSCRIPT_RE = /^openagent-transcript-(.+)\.json$/;

/** Files that carry over unchanged. */
const PASSTHROUGH = new Set(['client-persistence.json']);

function candidateOldDirs(): string[] {
  const appData = app.getPath('appData');
  return [
    // Pre-rebrand locations.
    path.join(appData, '@openagent', 'desktop'),
    path.join(appData, 'openagent'),
    path.join(appData, 'OpenAgent'),
    // Post-rebrand but pre-setName: builds that derived userData from the
    // package name before app.setName('GhostBot') was hoisted to module scope.
    path.join(appData, '@ghostbot', 'desktop'),
  ];
}

function mapName(name: string): string | null {
  if (FILE_RENAMES[name]) return FILE_RENAMES[name];
  const m = TRANSCRIPT_RE.exec(name);
  if (m) return `ghostbot-transcript-${m[1]}.json`;
  if (PASSTHROUGH.has(name)) return name;
  // Already-renamed files (from an intermediate @ghostbot\desktop profile).
  if (name.startsWith('ghostbot-')) return name;
  return null; // unknown file: leave it behind
}

/**
 * Ensure the app name is GhostBot, then import any pre-rebrand profile.
 * Returns the resolved userData directory.
 */
export function migrateUserData(): string {
  // NOTE: `app.setName('GhostBot')` must already have run at module scope in
  // main.ts — Electron caches the userData path on first access, so setting
  // the name here would be too late and data would land in the
  // package-derived %APPDATA%\@ghostbot\desktop folder instead.
  const userDataDir = app.getPath('userData');

  try {
    fs.mkdirSync(userDataDir, { recursive: true });

    // Already migrated (or a fresh install that has since been used)?
    const alreadyHasData = fs
      .readdirSync(userDataDir)
      .some((f) => f.startsWith('ghostbot-'));
    if (alreadyHasData) return userDataDir;

    const oldDir = candidateOldDirs().find(
      (d) => d !== userDataDir && fs.existsSync(d),
    );
    if (!oldDir) return userDataDir;

    let copied = 0;
    for (const name of fs.readdirSync(oldDir)) {
      const target = mapName(name);
      if (!target) continue;
      const from = path.join(oldDir, name);
      const to = path.join(userDataDir, target);
      if (!fs.statSync(from).isFile() || fs.existsSync(to)) continue;
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
