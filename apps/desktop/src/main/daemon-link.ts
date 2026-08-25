/**
 * daemon-link.ts — connect the desktop app to a background engine.
 *
 * The window is a client. The engine runs in a separate, **detached**
 * process, so quitting the app leaves routines running and long tasks
 * finishing — which is the entire point of the exercise.
 *
 * On launch:
 *   1. Look for a live daemon for this profile (endpoint file + live PID).
 *   2. If none, spawn one detached and wait for it to publish an endpoint.
 *   3. Connect over the local socket and hand the UI a client.
 *
 * Quitting closes the socket and nothing else. The daemon keeps its own
 * lifetime.
 *
 * ## Running the daemon without a system Node
 *
 * A packaged Electron app cannot assume `node` is installed. It can,
 * however, run its own binary as a plain Node interpreter via
 * `ELECTRON_RUN_AS_NODE`, which is how the daemon is launched in
 * production. Verified: it reports the bundled Node version and executes
 * ordinary scripts.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { app } from 'electron';
import {
  connectNode,
  engineBuildStamp,
  fileLog,
  isSameProcess,
  readEndpoint,
  type NodeClient,
  type NodeEndpoint,
} from '@wispcrew/runtime';

/** How long to wait for a freshly spawned daemon to publish its endpoint. */
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 150;

/**
 * Locate the daemon entry point.
 *
 * Development runs from the workspace; a packaged build carries the daemon
 * inside its resources. Both are checked because the same code path serves
 * `npm run desktop` and an installed app, and a wrong guess here fails at
 * launch rather than in CI.
 */
function daemonEntry(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'daemon', 'cli.js')]
    : [
        path.join(app.getAppPath(), '..', 'daemon', 'dist', 'cli.js'),
        path.join(app.getAppPath(), '..', '..', 'apps', 'daemon', 'dist', 'cli.js'),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Start a daemon that outlives this process.
 *
 * `detached` plus `unref` is what makes quitting the app harmless: the child
 * gets its own process group and is not tied to the parent's stdio, so it
 * keeps running when the window closes.
 */
function spawnDaemon(entry: string, dataDir: string): void {
  const child = spawn(process.execPath, [entry, 'serve', '--data-dir', dataDir, '--listen'], {
    detached: true,
    /*
     * All streams discarded, deliberately.
     *
     * Capturing stderr to diagnose a failed start seemed harmless and was
     * not: an open pipe to a detached child keeps the parent's event loop
     * alive, so Electron would not quit. The app hung on exit until this
     * went back to `ignore`.
     *
     * The daemon writes to the shared log file instead, which is where its
     * startup problems belong anyway — a client that has already exited
     * cannot report them.
     */
    stdio: 'ignore',
    env: {
      ...process.env,
      // Run the Electron binary as a plain Node interpreter, so a packaged
      // app needs no system Node installed.
      ELECTRON_RUN_AS_NODE: '1',
    },
  });

  child.unref();
  fileLog('[daemon-link] spawned daemon pid', String(child.pid ?? 'unknown'), 'entry', entry);
}

/** Wait for a daemon to publish a usable endpoint. */
async function waitForEndpoint(dataDir: string): Promise<NodeEndpoint | null> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const endpoint = readEndpoint(dataDir);
    if (endpoint) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

export interface DaemonLink {
  client: NodeClient;
  endpoint: NodeEndpoint;
  /** True when this launch started the daemon rather than finding one. */
  started: boolean;
}

/**
 * Connect to the local daemon, starting it if necessary.
 *
 * Returns null when no daemon could be reached. The caller then falls back
 * to running the engine in-process — a degraded mode where closing the
 * window stops agents, but the app still works. Refusing to start at all
 * because a background process failed would be a worse trade.
 */
export async function linkToDaemon(
  dataDir: string,
  onEvent: (event: unknown) => void,
): Promise<DaemonLink | null> {
  /*
   * An explicit way back to the single-process app.
   *
   * Useful when diagnosing whether a problem belongs to the daemon or to the
   * app, and as a safety valve for a user whose environment cannot spawn one
   * — a locked-down machine, an antivirus that objects to a detached child.
   */
  if (process.env.WISPCREW_NO_DAEMON) {
    fileLog('[daemon-link] disabled by WISPCREW_NO_DAEMON; running in-process');
    return null;
  }

  let endpoint = readEndpoint(dataDir);
  let started = false;

  /*
   * Replace a daemon running older code than ours.
   *
   * A daemon deliberately outlives the app, so it keeps whatever it loaded
   * at startup. After an upgrade the UI is new and the engine is not, and
   * nothing about that is visible: bugs stay fixed in the code and broken in
   * the running process.
   *
   * This bit us for real. A shell-quoting fix was built and committed, and
   * the daemon that had started eleven minutes earlier carried on mangling
   * commands, so the fix appeared not to work.
   *
   * Restarting is safe because the daemon owns nothing but its own process:
   * the store is on disk, and a fresh one picks up exactly where this left
   * off.
   */
  if (endpoint && typeof endpoint.buildStamp === 'number') {
    const ours = engineBuildStamp();
    if (ours > 0 && endpoint.buildStamp > 0 && endpoint.buildStamp < ours) {
      fileLog(
        '[daemon-link] daemon is running older code; restarting it',
        `(daemon ${new Date(endpoint.buildStamp).toISOString()} < app ${new Date(ours).toISOString()})`,
      );
      /*
       * Confirm the pid is still OUR daemon before signalling it.
       *
       * A pid is not an identity. If the daemon died and the OS recycled its
       * number, this file names a stranger's process, and killing that in
       * exchange for a small convenience would be a serious bug. The start
       * time is checked; an unconfirmed pid is left alone and the stale
       * endpoint simply discarded, which reaches the same outcome safely.
       */
      if (isSameProcess(endpoint.pid, endpoint.startedAt)) {
        try {
          process.kill(endpoint.pid);
        } catch {
          /* already gone */
        }
        // Give it a moment to release the socket before a new one binds.
        await new Promise((resolve) => setTimeout(resolve, 600));
      } else {
        fileLog('[daemon-link] stale endpoint does not name a live daemon; not signalling');
      }
      endpoint = null;
    }
  }

  if (!endpoint) {
    const entry = daemonEntry();
    if (!entry) {
      fileLog('[daemon-link] no daemon entry point found; staying in-process');
      return null;
    }
    spawnDaemon(entry, dataDir);
    endpoint = await waitForEndpoint(dataDir);
    started = true;
    if (!endpoint) {
      fileLog('[daemon-link] daemon did not publish an endpoint in time');
      return null;
    }
  }

  try {
    const socket = net.connect(endpoint.address);

    /*
     * `unref` the socket so it is never a reason to stay alive.
     *
     * An open connection is a live handle in the event loop, and Electron
     * will not exit while one exists. Without this the app HUNG at quit: the
     * window closed, the daemon was healthy, and the process simply never
     * ended. Closing the socket in `before-quit` did not help, because the
     * handle had already pinned the loop.
     *
     * Unreferencing does not close it — frames still flow normally while the
     * app runs. It only removes it from the set of handles keeping the
     * process alive.
     */
    socket.unref();

    const client = await connectNode({
      socket,
      token: endpoint.token,
      clientName: `wispcrew-desktop/${app.getVersion()}`,
      onEvent,
      onClose: (reason) => fileLog('[daemon-link] disconnected:', reason),
    });
    fileLog('[daemon-link] connected to', client.nodeName, started ? '(started)' : '(existing)');
    return { client, endpoint, started };
  } catch (err) {
    /*
     * A stale endpoint file is the common cause: the daemon died without
     * cleaning up and its PID was recycled by an unrelated process, so the
     * liveness check passed. Remove it so the next launch starts fresh
     * rather than failing the same way forever.
     */
    fileLog('[daemon-link] connect failed', (err as Error).message);
    try {
      fs.rmSync(path.join(dataDir, 'node-endpoint.json'), { force: true });
    } catch {
      /* best effort */
    }
    return null;
  }
}
