/**
 * GhostBot Ã¢â‚¬â€ Electron main process.
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
import { createProvider, configFromPreset, describeProviderError } from '@ghostbot/llm';
import { personaById } from '@ghostbot/core';
import { ToolRegistry } from '@ghostbot/tools';
import type {
  AgentRecord,
  Attachment,
  GlobalSettings,
  RoutineRecord,
  TranscriptEntry,
} from '@ghostbot/shared';
import { attachmentsToPromptText } from '@ghostbot/runtime';
import { rebuildHistory } from '@ghostbot/runtime';
import {
  defaultSettings,
  initGrants,
  runPrompt,
  runRoutine,
  setApprovalAsker,
  setHost,
} from '@ghostbot/runtime';
import { allStatuses, recordUsage, resolveToken, type OAuthVendor } from '@ghostbot/runtime';
import { migrateLegacyKey, providerSecretKey, setProviderKey } from '@ghostbot/runtime';
import type { UsageSnapshot } from '@ghostbot/llm';
import {
  isTerminal,
  makeAskAgentTool,
  rootContext,
  TERMINAL_NOTICE,
  type DelegationContext,
} from '@ghostbot/runtime';
import { initFileLog, fileLog } from '@ghostbot/runtime';
import { readSettings, writeSettings } from '@ghostbot/runtime';
import { getSession, setRunning } from '@ghostbot/runtime';
import { buildMcpTools, syncMcpServers, closeAllMcp } from '@ghostbot/runtime';
import { readSecrets, upsertSecrets } from '@ghostbot/runtime';
import { migrateUserData } from './userdata-migration.js';
import { electronHost } from './electron-host.js';
import * as store from '@ghostbot/runtime';
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
import { startScheduler, stopScheduler } from '@ghostbot/runtime';

// Must run at module scope, BEFORE anything reads app.getPath('userData').
// Electron caches the userData path on first access and otherwise derives it
// from the package name (@ghostbot/desktop Ã¢â€ â€™ %APPDATA%\@ghostbot\desktop).
app.setName('GhostBot');

/**
 * The project's home. Single constant so moving the repository is a one-line
 * change rather than a hunt through menus, docs and templates.
 */
export const PROJECT_URL = 'https://github.com/techartdev/ghostbot';

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
let userDataDir = '';

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'GhostBot',
        submenu: [
          { role: 'about', label: 'About GhostBot' },
          { type: 'separator' },
          {
            label: 'SettingsÃ¢â‚¬Â¦',
            accelerator: isMac ? 'Cmd+,' : 'Ctrl+,',
            click: () => mainWindow?.webContents.send('gb:event', { type: 'open-settings' }),
          },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'quit', label: 'Quit GhostBot' },
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
    title: 'GhostBot',
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

  // Debug helper: GHOSTBOT_AUTOSEND='prompt' drives one turn through the
  // real pipeline (bridge Ã¢â€ â€™ agent Ã¢â€ â€™ provider) without a human clicking.
  if (process.env.GHOSTBOT_AUTOSEND) {
    setTimeout(() => {
      const agentId = store.listAgents()[0]?.id;
      if (!agentId) return;
      pushTranscript(agentId, {
        kind: 'message',
        id: store.newId('usr'),
        role: 'user',
        content: process.env.GHOSTBOT_AUTOSEND!,
        createdAt: Date.now(),
      });
      void runPrompt(agentId, process.env.GHOSTBOT_AUTOSEND!);
    }, 2500);
  }

  // Debug helper: GHOSTBOT_CAPTURE=<path.png> screenshots then quits.
  //
  // CI uses this as its "does the app actually render" gate, so a failure
  // must exit non-zero. Quitting 0 after failing to capture would let a
  // broken build pass silently Ã¢â‚¬â€ which is worse than no check at all.
  if (process.env.GHOSTBOT_CAPTURE) {
    setTimeout(() => {
      void (async () => {
        let ok = false;
        try {
          const img = await mainWindow?.webContents.capturePage();
          if (img && !img.isEmpty()) {
            fs.writeFileSync(process.env.GHOSTBOT_CAPTURE!, img.toPNG());
            ok = true;
          } else {
            fileLog('[capture] window produced an empty image');
          }
        } catch (err) {
          fileLog('[capture] failed', (err as Error).message);
        } finally {
          if (ok) app.quit();
          else app.exit(1);
        }
      })();
    }, Number(process.env.GHOSTBOT_CAPTURE_DELAY ?? 8000));
  }
}

app.whenReady().then(async () => {
  initFileLog();
  userDataDir = migrateUserData();
  /*
   * Hand the headless engine its environment before anything touches disk.
   *
   * `@ghostbot/runtime` refuses to guess a data directory â€” a wrong guess
   * would put someone's agents and keys somewhere they never chose â€” so this
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
      fileLog('[secrets] moved plaintext settings apiKey Ã¢â€ â€™ encrypted per-provider store');
    }
  } catch (err) {
    fileLog('[secrets] settings migration failed', (err as Error).message);
  }

  // Attribute a pre-existing shared key to the provider it was set up for,
  // so adding a second provider does not hand the first one's key to it.
  migrateLegacyKey(userDataDir, (readSettings(userDataDir, {}) as GlobalSettings).presetId);

  // Every install has at least one agent so the UI is never empty.
  if (store.listAgents().length === 0) {
    store.createAgent({ name: 'Assistant', persona: 'general' });
    fileLog('[main] created default agent');
  }

  registerBridge({
    userDataDir,
    runPrompt,
    defaults: defaultSettings,
  });

  /*
   * Connect the headless engine to this host.
   *
   * The engine broadcasts events without knowing who listens, and asks for
   * approval without knowing who answers. Here that means: deliver to open
   * windows, and raise an approval card. A daemon supplies different
   * answers for both — and with nobody to ask, denies.
   */
  attachWindowEventSink();
  setApprovalAsker((agentId, req) => requestApproval(agentId, req));

  buildMenu();
  await createWindow();

  // Connect MCP servers in the background; failures are reported, not fatal.
  void syncMcpServers(readSettings(userDataDir, defaultSettings()) as never)
    .then(emitMcp)
    .catch((err) => fileLog('[mcp] initial sync failed', (err as Error).message));

  startScheduler(runRoutine, emitRoutines);
  emitAgents();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopScheduler();
  void closeAllMcp();
});
