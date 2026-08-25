/**
 * daemon-host.ts — where a headless GhostBot keeps its data.
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
import { createNodeCrypto, type HostEnvironment } from '@ghostbot/runtime';

/**
 * Default data directory, matching where Electron puts `userData` so both
 * hosts share one profile on a single machine.
 *
 *   Windows  %APPDATA%\GhostBot
 *   macOS    ~/Library/Application Support/GhostBot
 *   Linux    $XDG_CONFIG_HOME/GhostBot, else ~/.config/GhostBot
 */
export function defaultDataDir(): string {
  if (process.env.GHOSTBOT_DATA_DIR) return path.resolve(process.env.GHOSTBOT_DATA_DIR);

  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'GhostBot');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'GhostBot');
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'GhostBot');
  }
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

export function daemonHost(options: { dataDir?: string; workspace?: string } = {}): HostEnvironment {
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : defaultDataDir();
  const workspace = options.workspace ? path.resolve(options.workspace) : defaultWorkspace(dataDir);

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  return {
    dataDir,
    defaultWorkspaceRoot: workspace,
    // No OS keychain on a headless box; this is honest about that and says
    // so through `available()`, which the UI surfaces verbatim.
    crypto: createNodeCrypto(dataDir),
    nodeName: process.env.GHOSTBOT_NODE_NAME || os.hostname(),
  };
}
