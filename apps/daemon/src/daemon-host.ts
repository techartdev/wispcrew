/**
 * daemon-host.ts — where a headless WispCrew keeps its data.
 *
 * The desktop app asks Electron for `userData`. A daemon has no such
 * authority, so it follows platform convention and lets the user override
 * explicitly with `--data-dir`.
 *
 * The directory is chosen so that a daemon started by hand, by systemd, or
 * by the desktop app all land in the same place — otherwise a user would
 * configure a provider in the UI and find the daemon had never heard of it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileLog } from '@wispcrew/runtime';
import { createNodeCrypto, type HostEnvironment } from '@wispcrew/runtime';

/**
 * Everything WispCrew stores lives in `~/.wispcrew`.
 *
 * One path on every platform, and one a person can find, back up and delete
 * without knowing what `%APPDATA%` or `XDG_CONFIG_HOME` mean. It is also
 * where a developer expects a tool of this kind to keep its state — the same
 * convention as the coding CLIs this sits alongside.
 *
 * It replaces three platform-specific locations that existed only because
 * Electron's `userData` chose them:
 *
 *   Windows  %APPDATA%\WispCrew
 *   macOS    ~/Library/Application Support/WispCrew
 *   Linux    $XDG_CONFIG_HOME/WispCrew, else ~/.config/WispCrew
 *
 * Those are still read for migration; see `legacyDataDirs`.
 */
export function defaultDataDir(): string {
  if (process.env.WISPCREW_DATA_DIR) return path.resolve(process.env.WISPCREW_DATA_DIR);
  return path.join(os.homedir(), '.wispcrew');
}

/**
 * Where a profile might have been before, newest convention first.
 *
 * Read once, on a first run with no `~/.wispcrew`, so an existing user keeps
 * their agents, conversations and keys. Losing someone's roster to a tidier
 * path would be an unforgivable trade.
 */
export function legacyDataDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'WispCrew'),
    path.join(home, 'Library', 'Application Support', 'WispCrew'),
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'WispCrew'),
  ];
}

/**
 * Default workspace for agents that do not set their own.
 *
 * Deliberately a dedicated directory rather than the user's Documents or the
 * process working directory. A daemon started from `/` or from a systemd
 * unit has no meaningful cwd, and pointing file tools at a home directory by
 * accident is exactly the kind of surprise a confined workspace exists to
 * prevent.
 */
export function defaultWorkspace(dataDir: string): string {
  return path.join(dataDir, 'workspace');
}

/**
 * Bring an older profile forward when `~/.wispcrew` is new and empty.
 *
 * The desktop has migrated for a while; the daemon did not, and moving the
 * default path without this meant a HEADLESS machine silently started fresh
 * — the VPS reported one agent where its store held three, because the
 * daemon was reading a directory that had just been created.
 *
 * A server is exactly where nobody is watching the first launch, so this
 * has to be automatic and it has to be safe: it copies only into an empty
 * directory, and never overwrites anything.
 */
function adoptLegacyProfile(dataDir: string): void {
  // Anything at all means this profile is in use. Merging two profiles is a
  // far worse outcome than not migrating.
  if (fs.readdirSync(dataDir).length > 0) return;

  const source = legacyDataDirs().find((dir) => {
    try {
      return dir !== dataDir && fs.existsSync(path.join(dir, 'agents.json'));
    } catch {
      return false;
    }
  });
  if (!source) return;

  try {
    fs.cpSync(source, dataDir, { recursive: true, force: false, errorOnExist: false });
    fileLog('[daemon] adopted the profile at', source);
  } catch (err) {
    // A failed migration must not stop the daemon starting. An empty profile
    // is recoverable; a node that will not boot is not.
    fileLog('[daemon] could not adopt', source, (err as Error).message);
  }
}

export function daemonHost(options: { dataDir?: string; workspace?: string } = {}): HostEnvironment {
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : defaultDataDir();
  const workspace = options.workspace ? path.resolve(options.workspace) : defaultWorkspace(dataDir);

  fs.mkdirSync(dataDir, { recursive: true });

  // Only when the caller did not name a directory: an explicit --data-dir is
  // a deliberate choice and must never be quietly filled from somewhere else.
  if (!options.dataDir) adoptLegacyProfile(dataDir);
  fs.mkdirSync(workspace, { recursive: true });

  return {
    dataDir,
    defaultWorkspaceRoot: workspace,
    // No OS keychain on a headless box; this is honest about that and says
    // so through `available()`, which the UI surfaces verbatim.
    crypto: createNodeCrypto(dataDir),
    nodeName: process.env.WISPCREW_NODE_NAME || os.hostname(),
  };
}
