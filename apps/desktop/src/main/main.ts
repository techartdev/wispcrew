/**
 * WispCrew — Electron main process.
 *
 * Startup:
 *   1. Set the app name (must precede any `getPath('userData')` call).
 *   2. Migrate any older profile, open the durable store.
 *   3. Register the IPC bridge, connect MCP servers, start the scheduler.
 *   4. Load our own renderer. There is no sign-in: the UI shows a setup
 *      panel until a provider is configured.
 *
 * The renderer is fully sandboxed (`sandbox: true`, `contextIsolation: true`,
 * `nodeIntegration: false`) and reaches the main process only through the
 * explicit surface in `preload.ts` / `bridge-host.ts`.
 */
import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProvider, configFromPreset, describeProviderError } from '@wispcrew/llm';
import { personaById } from '@wispcrew/core';
import { ToolRegistry } from '@wispcrew/tools';
import type {
  AgentRecord,
  Attachment,
  GlobalSettings,
  RoutineRecord,
  TranscriptEntry,
} from '@wispcrew/shared';
import { attachmentsToPromptText } from '@wispcrew/runtime';
import { rebuildHistory } from '@wispcrew/runtime';
import {
  createAgentWithRoom,
  defaultSettings,
  createNodeCrypto,
  initGrants,
  installNotifySender,
  setRemoteRunner,
  migrateAgentsToConversations,
  installScheduler,
  installSkillReader,
  seedBuiltinSkills,
  runPrompt,
  runRoutine,
  setApprovalAsker,
  setHost,
} from '@wispcrew/runtime';
import { allStatuses, recordUsage, resolveToken, type OAuthVendor } from '@wispcrew/runtime';
import { migrateLegacyKey, providerSecretKey, setProviderKey } from '@wispcrew/runtime';
import type { UsageSnapshot } from '@wispcrew/llm';
import {
  isTerminal,
  makeAskAgentTool,
  rootContext,
  TERMINAL_NOTICE,
  type DelegationContext,
} from '@wispcrew/runtime';
import { initFileLog, fileLog } from '@wispcrew/runtime';
import { readSettings, writeSettings } from '@wispcrew/runtime';
import { getSession, setRunning } from '@wispcrew/runtime';
import { buildMcpTools, syncMcpServers, closeAllMcp } from '@wispcrew/runtime';
import { readSecrets, upsertSecrets } from '@wispcrew/runtime';
import { migrateUserData } from './userdata-migration.js';
import { electronHost } from './electron-host.js';
import { handoffIsCurrent, writeDaemonSecrets } from './secrets-handoff.js';
import { linkToDaemon, type DaemonLink } from './daemon-link.js';
import { startDesktopNotifications } from './desktop-notify.js';
import {
  closeNodeLinks,
  connectKnownNodes,
  setNodeApprovalAsker,
  existingLink,
  routeForCall,
} from './node-links.js';
import * as store from '@wispcrew/runtime';
import {
  attachWindowEventSink,
  registerBridge,
  emitEvent,
  emitAgents,
  emitMcp,
  emitRoutines,
  pushTranscript,
  requestApproval,
} from './bridge-host.js';
import { startScheduler, stopScheduler, stopWatches, syncWatches } from '@wispcrew/runtime';

// Must run at module scope, BEFORE anything reads app.getPath('userData').
// Electron caches the userData path on first access and otherwise derives it
// from the package name (@wispcrew/desktop → %APPDATA%\@wispcrew\desktop).
app.setName('WispCrew');

/**
 * The project's home. Single constant so moving the repository is a one-line
 * change rather than a hunt through menus, docs and templates.
 */
export const PROJECT_URL = 'https://github.com/techartdev/wispcrew';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_HTML = path.join(__dirname, 'renderer', 'index.html');

/** Window/taskbar icon; packaged builds embed it in the executable. */
const ICON_PATH = (() => {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.png')]
    : [
        path.join(__dirname, '..', '..', '..', 'build', 'icons', '256x256.png'),
        path.join(__dirname, '..', '..', '..', 'build', 'icon.png'),
      ];
  return candidates.find((p) => fs.existsSync(p));
})();

let mainWindow: BrowserWindow | null = null;
/**
 * Set when a background daemon owns the engine; null when running in-process.
 *
 * Also the switch that decides whether quitting stops anything: with a
 * daemon, quitting closes a socket and leaves the work running.
 */
let daemonLink: DaemonLink | null = null;

/**
 * How long startup waits for a background engine.
 *
 * Kept short because nothing is on screen until it resolves. Starting a
 * daemon takes well under a second when it works; anything longer means
 * something is wrong, and the user is better served by a running app than a
 * blank one.
 */
const DAEMON_LINK_TIMEOUT_MS = 4000;

/** Resolve with `fallback` if the promise has not settled in time. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}
let userDataDir = '';

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'WispCrew',
        submenu: [
          { role: 'about', label: 'About WispCrew' },
          { type: 'separator' },
          {
            label: 'Settings…',
            accelerator: isMac ? 'Cmd+,' : 'Ctrl+,',
            click: () => mainWindow?.webContents.send('wc:event', { type: 'open-settings' }),
          },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'quit', label: 'Quit WispCrew' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: 'Project on GitHub',
            click: () => void shell.openExternal(PROJECT_URL),
          },
        ],
      },
    ]),
  );
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'WispCrew',
    backgroundColor: '#0f1115',
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Avoid a white flash before React paints.
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Links open in the user's browser, never as an in-app window: an
  // in-app navigation would give remote content our preload.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    fileLog('[renderer]', String(level), message.slice(0, 400));
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    fileLog('[load-fail]', String(code), desc, url);
  });

  await mainWindow.loadFile(RENDERER_HTML);
  fileLog('[main] renderer loaded');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Debug helper: WISPCREW_AUTOSEND='prompt' drives one turn through the
  // real pipeline (bridge → agent → provider) without a human clicking.
  if (process.env.WISPCREW_AUTOSEND) {
    setTimeout(() => {
      const agentId = store.listAgents()[0]?.id;
      if (!agentId) return;
      pushTranscript(agentId, {
        kind: 'message',
        id: store.newId('usr'),
        role: 'user',
        content: process.env.WISPCREW_AUTOSEND!,
        createdAt: Date.now(),
      });
      void runPrompt(agentId, process.env.WISPCREW_AUTOSEND!);
    }, 2500);
  }

  // Debug helper: WISPCREW_CAPTURE=<path.png> screenshots then quits.
  //
  // CI uses this as its "does the app actually render" gate, so a failure
  // must exit non-zero. Quitting 0 after failing to capture would let a
  // broken build pass silently — which is worse than no check at all.
  if (process.env.WISPCREW_CAPTURE) {
    setTimeout(() => {
      void (async () => {
        let ok = false;
        try {
          const img = await mainWindow?.webContents.capturePage();
          if (img && !img.isEmpty()) {
            fs.writeFileSync(process.env.WISPCREW_CAPTURE!, img.toPNG());
            ok = true;
          } else {
            fileLog('[capture] window produced an empty image');
          }
        } catch (err) {
          fileLog('[capture] failed', (err as Error).message);
        } finally {
          /*
           * `app.exit`, not `app.quit`.
           *
           * `quit` waits for outstanding handles, and once the app has
           * spawned a detached daemon it never stops waiting — measured: the
           * app rendered correctly and simply never ended, while the same
           * build with WISPCREW_NO_DAEMON exited in 8.6s.
           *
           * This is a CI gate that has already captured its screenshot and
           * written the file, so there is nothing left to flush. Exiting with
           * the right status is the entire remaining job.
           */
          app.exit(ok ? 0 : 1);
        }
      })();
    }, Number(process.env.WISPCREW_CAPTURE_DELAY ?? 8000));
  }
}

app.whenReady().then(async () => {
  initFileLog();
  userDataDir = migrateUserData();
  /*
   * Hand the headless engine its environment before anything touches disk.
   *
   * `@wispcrew/runtime` refuses to guess a data directory — a wrong guess
   * would put someone's agents and keys somewhere they never chose — so this
   * must run before the first store or secrets access.
   */
  setHost(electronHost(userDataDir));
  store.initStore(userDataDir);
  initGrants(userDataDir);

  /*
   * Key migrations, in this order deliberately.
   *
   * First rescue any key an old build left in the *plaintext* settings file,
   * storing it against the provider it was configured for. Then attribute a
   * legacy shared key to that same provider. Running these the other way
   * round would re-create the shared key immediately after removing it.
   */
  try {
    const existing = readSettings(userDataDir, {}) as GlobalSettings & { apiKey?: string };
    if (existing.apiKey && existing.presetId) {
      setProviderKey(userDataDir, existing.presetId, existing.apiKey);
      writeSettings(userDataDir, { apiKey: undefined } as never);
      fileLog('[secrets] moved plaintext settings apiKey → encrypted per-provider store');
    }
  } catch (err) {
    fileLog('[secrets] settings migration failed', (err as Error).message);
  }

  // Attribute a pre-existing shared key to the provider it was set up for,
  // so adding a second provider does not hand the first one's key to it.
  migrateLegacyKey(userDataDir, (readSettings(userDataDir, {}) as GlobalSettings).presetId);

  /*
   * Every install has at least one agent so the UI is never empty.
   *
   * Done before the daemon link, while this process is still the only thing
   * touching the store. The daemon does the same check on its own startup,
   * so whichever runs first wins and the other sees a non-empty roster —
   * they never both create one.
   */
  if (store.listAgents().length === 0) {
    createAgentWithRoom({ name: 'Assistant', persona: 'general' });
    fileLog('[main] created default agent');
  }

  /*
   * Connect to the background engine before the bridge is registered.
   *
   * Order matters: the bridge asks `remote()` on every call, so the link must
   * exist before the first one arrives. Doing it afterwards would let the
   * window's opening calls run locally while later ones go to the daemon —
   * two writers for a moment, which is the state that loses data.
   *
   * Bounded, because this blocks the window from opening. A daemon that
   * cannot be reached quickly is treated as absent and the app runs the
   * engine itself; an app that will not launch is worse than one whose
   * agents stop at quit.
   */
  daemonLink = await withTimeout(
    linkToDaemon(userDataDir, (event) => emitEvent(event as never)),
    DAEMON_LINK_TIMEOUT_MS,
    null,
  );

  registerBridge({
    userDataDir,
    runPrompt,
    defaults: defaultSettings,
    // Read per call rather than captured, so losing the daemon mid-session
    // falls back to the local engine instead of failing every method.
    remote: () => daemonLink?.client ?? null,
    /*
     * Route an agent's calls to the machine that owns it.
     *
     * The agent record is read from the local roster, which is the client's
     * view of every node's agents. `nodeId` unset means the local engine,
     * which is every agent until a user pairs something.
     */
    remoteForAgent: (method, args) =>
      routeForCall((agentId) => store.getAgent(agentId)?.nodeId, method, args),
  });

  /*
   * Connect the headless engine to this host.
   *
   * The engine broadcasts events without knowing who listens, and asks for
   * approval without knowing who answers. Here that means: deliver to open
   * windows, and raise an approval card. A daemon supplies different
   * answers for both — and with nobody to ask, denies.
   */
  /*
   * Give every agent a room.
   *
   * Idempotent: a migrated room reuses the agent id, so a second run
   * finds nothing to do. Either host may start first.
   */
  migrateAgentsToConversations();
  /*
   * Carry room traffic between machines.
   *
   * An agent belongs to one node; its workspace, files and provider key are
   * there. When a room holds agents from several machines, this process is
   * the only one that can reach them all — nodes do not know about each
   * other and there is no coordinator.
   *
   * The consequence is stated rather than hidden: a multi-node room needs a
   * connected client and pauses without one. Single-node agents and routines
   * are unaffected, because they never needed the relay.
   */
  setRemoteRunner(async (nodeId, agentId, text) => {
    const link = existingLink(nodeId);
    if (!link) throw new Error('not connected');
    await link.call('sendPrompt', [agentId, text]);
  });

  installNotifySender();
  installScheduler();
  // Lets an agent read one section of a skill instead of being handed
  // the whole thing on every invocation.
  installSkillReader();
  // Installed once, then the user's to edit or delete. A builtin that
  // reappeared after being deleted would be a bug nobody could work around.
  seedBuiltinSkills();
  /*
   * Deliver anything the daemon queued for us.
   *
   * Only a GUI process can raise a native notification, so work done
   * while the app was closed surfaces shortly after it opens.
   */
  startDesktopNotifications(userDataDir);
  attachWindowEventSink();
  setApprovalAsker((agentId, req) => requestApproval(agentId, req));

  /*
   * The same person, asked by a machine across the network.
   *
   * A node with an agent that needs a tool now reaches whoever is driving
   * this desktop, instead of parking the request until it times out as a
   * denial with no card ever shown.
   */
  setNodeApprovalAsker((agentId, req) => requestApproval(agentId, req));

  /*
   * Share this profile's credentials with a background daemon.
   *
   * The daemon cannot open the OS keychain, so without this it would run
   * with zero providers and fail every routine. Refreshed whenever the
   * secrets change, not merely when the file is absent — a provider added
   * in the UI must reach the daemon too.
   *
   * This lowers protection on those keys from "OS keychain" to "readable by
   * anything running as this user". See secrets-handoff.ts for why that is
   * the right default on one machine, and why it never applies to a remote
   * node: keys are written beside the profile, never sent anywhere.
   */
  try {
    if (!handoffIsCurrent(userDataDir, createNodeCrypto(userDataDir))) {
      writeDaemonSecrets(userDataDir);
    }
  } catch (err) {
    fileLog('[main] secrets handoff failed', (err as Error).message);
  }

  buildMenu();
  await createWindow();

  /*
   * Exactly one engine owns this profile.
   *
   * With a daemon attached it runs the scheduler and the MCP servers, and
   * this process runs neither. Starting a second scheduler here would fire
   * every routine twice, and a second writer on one JSON store silently
   * loses updates — measured, see the concurrency note in store.ts.
   *
   * Without a daemon the app is the engine. That is a real downgrade —
   * quitting stops agents — but a working app beats refusing to launch
   * because a background process failed to start.
   */
  if (daemonLink) {
    fileLog('[main] engine owned by the daemon:', daemonLink.endpoint.nodeName);
  } else {
    fileLog('[main] no daemon reachable; running the engine in-process');

    // Connect MCP servers in the background; failures are reported, not fatal.
    void syncMcpServers(readSettings(userDataDir, defaultSettings()) as never)
      .then(emitMcp)
      .catch((err) => fileLog('[mcp] initial sync failed', (err as Error).message));

    startScheduler(runRoutine, emitRoutines);
    syncWatches(runRoutine, emitRoutines);
  }

  /*
   * Reconnect to paired machines in the background.
   *
   * Deliberately not awaited: a node that is asleep or on another network
   * must not delay the window. The routing layer only uses links that are
   * already open, so an agent on an unreachable node reports as unavailable
   * rather than hanging the UI on a connection attempt.
   */
  void connectKnownNodes(userDataDir, (event) => emitEvent(event as never)).catch((err) =>
    fileLog('[nodes] initial connect failed', (err as Error).message),
  );

  emitAgents();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  /*
   * Close the socket and nothing else.
   *
   * When a daemon owns the engine, quitting must NOT stop it — that is the
   * whole point. Only the in-process fallback has a scheduler and MCP
   * servers of its own to shut down.
   */
  closeNodeLinks();
  if (daemonLink) {
    daemonLink.client.close();
    daemonLink = null;
    return;
  }
  stopScheduler();
  stopWatches();
  void closeAllMcp();
});

/*
 * Make sure quitting actually ends the process.
 *
 * Spawning a detached daemon leaves this process with handles Electron does
 * not consider disposable — measured: with a daemon the app rendered and ran
 * correctly but never exited, while the same build with WISPCREW_NO_DAEMON
 * exited in 8.6s. Chasing each handle individually is a losing game, and a
 * desktop app that lingers invisibly after the user quits is a bug they will
 * notice long before they notice why.
 *
 * `will-quit` fires after `before-quit`, so the socket has already been
 * closed and the daemon left running by the time this runs. Exiting here is
 * therefore a clean shutdown that simply refuses to wait for stragglers.
 */
app.on('will-quit', () => {
  // Give any in-flight write a tick to flush, then leave.
  setTimeout(() => process.exit(0), 50).unref();
});
