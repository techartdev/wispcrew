/**
 * GhostBot — Electron main process.
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
import { attachmentsToPromptText } from './attachments.js';
import { rebuildHistory } from './branching.js';
import { initGrants } from './grants.js';
import {
  isTerminal,
  makeAskAgentTool,
  rootContext,
  TERMINAL_NOTICE,
  type DelegationContext,
} from './delegation.js';
import { initFileLog, fileLog } from './filelog.js';
import { readSettings, writeSettings } from './settings-file.js';
import { getSession, setRunning } from './agent-sessions.js';
import { buildMcpTools, syncMcpServers, closeAllMcp } from './mcp-manager.js';
import { readSecrets, upsertSecrets } from './secrets-store.js';
import { migrateUserData } from './userdata-migration.js';
import * as store from './store.js';
import {
  registerBridge,
  emitEvent,
  emitAgents,
  emitMcp,
  emitRoutines,
  pushTranscript,
  requestApproval,
} from './bridge-host.js';
import { startScheduler, stopScheduler } from './scheduler.js';

// Must run at module scope, BEFORE anything reads app.getPath('userData').
// Electron caches the userData path on first access and otherwise derives it
// from the package name (@ghostbot/desktop → %APPDATA%\@ghostbot\desktop).
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

function defaultSettings(): GlobalSettings {
  return {
    presetId: process.env.GHOSTBOT_PROVIDER ?? 'deepseek',
    model: process.env.GHOSTBOT_MODEL,
    baseUrl: process.env.GHOSTBOT_BASE_URL,
    approvalPolicy: 'ask',
    theme: 'system',
  };
}

/** Read the provider API key from the encrypted store, then env. */
function resolveApiKey(presetId: string): string | undefined {
  const secrets = readSecrets(userDataDir);
  const perProvider: Record<string, string> = {
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    groq: 'GROQ_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  };
  for (const name of ['GHOSTBOT_API_KEY', perProvider[presetId]].filter(Boolean) as string[]) {
    if (secrets[name]) return secrets[name];
  }
  return process.env.GHOSTBOT_API_KEY;
}

/**
 * Resolve the effective configuration for an agent: per-agent overrides win
 * over the global defaults, so one agent can run a cheap model in a scratch
 * directory while another uses a stronger model against a real project.
 */
function effectiveConfig(agent: AgentRecord | undefined, settings: GlobalSettings) {
  const presetId = agent?.presetId ?? settings.presetId ?? 'deepseek';
  return {
    presetId,
    model: agent?.model ?? settings.model,
    baseUrl: settings.baseUrl,
    workspaceRoot: agent?.workspaceRoot ?? settings.workspaceRoot ?? app.getPath('documents'),
    approvalPolicy: agent?.approvalPolicy ?? settings.approvalPolicy ?? 'ask',
    persona: agent?.persona ?? settings.persona,
    apiKey: resolveApiKey(presetId),
  };
}

/**
 * Build the system prompt for an agent.
 *
 * An explicit `description` is the agent's own durable instruction set and
 * takes precedence; otherwise we fall back to the chosen built-in persona.
 */
function systemPromptFor(agent: AgentRecord | undefined, personaId: string | undefined, model?: string) {
  const described = agent?.description?.trim();
  if (described) return described;
  return personaById(personaId)?.build({ modelHint: model }) ?? undefined;
}

/**
 * Expand a leading `/skill` reference into that skill's instructions.
 *
 * The renderer does this too (so the user sees the expansion in their own
 * message), but it must also happen here: routines and any other non-UI
 * caller reach `runPrompt` directly and would otherwise send a literal
 * "/changelog" to the model.
 *
 * Expanding twice is harmless — after the first pass the text no longer
 * starts with a slash command.
 */
function expandSkill(prompt: string): string {
  const m = /^\/([\w-]+)\s*([\s\S]*)$/.exec(prompt);
  if (!m) return prompt;
  const skill = store
    .listSkills()
    .find((s) => s.enabled && s.name.toLowerCase() === (m[1] ?? '').toLowerCase());
  if (!skill) return prompt;
  const rest = (m[2] ?? '').trim();
  return rest ? `${skill.body}\n\n---\n\n${rest}` : skill.body;
}

/**
 * Drop a trailing user message from a transcript.
 *
 * Callers append the user's message to the transcript before invoking
 * `runPrompt`, and `Agent.run` appends it to the model history itself. Seeding
 * a cold session from the raw transcript would therefore send it twice — which
 * the model reads as the user repeating themselves.
 */
function dropTrailingUserEntry(entries: TranscriptEntry[]): TranscriptEntry[] {
  const last = entries[entries.length - 1];
  if (last && last.kind === 'message' && last.role === 'user') return entries.slice(0, -1);
  return entries;
}

/**
 * Run one prompt for an agent, streaming results to the renderer.
 *
 * The assistant message keeps a single stable id and is rewritten as tokens
 * arrive, so the UI updates in place rather than accumulating fragments.
 */
async function runPrompt(
  agentId: string,
  rawPrompt: string,
  attachments: Attachment[] = [],
  delegation?: DelegationContext,
): Promise<string> {
  const expanded = expandSkill(rawPrompt);
  // Non-image attachments are inlined ahead of the user's own words so the
  // model reads the material before the instruction about it. Images travel
  // separately as structured vision content.
  const attachmentText = attachmentsToPromptText(attachments);
  const prompt = attachmentText ? `${attachmentText}\n\n${expanded}`.trim() : expanded;
  const images = attachments.filter((a) => a.kind === 'image');
  const settings = readSettings(userDataDir, defaultSettings()) as GlobalSettings;
  const agent = store.getAgent(agentId);
  const cfg = effectiveConfig(agent, settings);

  const preset = configFromPreset(cfg.presetId, {
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
  });
  const provider = createProvider(preset);
  const check = provider.validate();
  if (!check.ok) {
    pushTranscript(agentId, {
      kind: 'notice',
      id: store.newId('err'),
      level: 'error',
      // `validate()` already returns a complete, actionable sentence;
      // prefixing it just adds jargon in front of the useful part.
      text: check.error,
      createdAt: Date.now(),
    });
    emitEvent({ type: 'run-state', agentId, state: 'error' });
    return check.error;
  }

  const assistantId = store.newId('asst');
  let text = '';
  const flush = (streaming: boolean) => {
    const entry: TranscriptEntry = {
      kind: 'message',
      id: assistantId,
      role: 'assistant',
      content: text,
      isStreaming: streaming,
      createdAt: Date.now(),
    };
    pushTranscript(agentId, entry);
  };

  // A delegated run inherits the caller's (possibly narrowed) policy so an
  // agent cannot gain permissions by asking a more privileged agent to act
  // for it. A top-level run starts a fresh delegation chain.
  const chain = delegation ?? rootContext(cfg.approvalPolicy, agentId);
  const effectivePolicy = delegation ? delegation.policy : cfg.approvalPolicy;

  // Built-in tools plus anything the configured MCP servers expose.
  const tools = new ToolRegistry();
  for (const tool of await buildMcpTools(settings as never)) tools.register(tool);
  // Delegation: only offered when another agent exists and we are within the
  // depth limit (`makeAskAgentTool` returns null otherwise).
  const askAgent = makeAskAgentTool(agentId, chain, runDelegated);
  if (askAgent) tools.register(askAgent as never);
  for (const name of agent?.disabledTools ?? []) tools.unregister(name);

  const fingerprint = JSON.stringify({
    presetId: cfg.presetId,
    model: preset.model,
    baseUrl: preset.baseUrl,
    hasKey: Boolean(cfg.apiKey),
    persona: cfg.persona ?? '',
    description: agent?.description ?? '',
    workspaceRoot: cfg.workspaceRoot,
    policy: effectivePolicy,
    // The delegation roster and depth change the tool set, so a session
    // built at one depth must not be reused at another.
    delegates: askAgent ? askAgent.definition.description.length : 0,
    mcp: (settings.mcpServers ?? []).map(
      (s) => `${s.name}:${s.command}:${(s.args ?? []).join(' ')}:${s.disabled ? 0 : 1}`,
    ),
  });

  const session = getSession(agentId, {
    provider,
    tools,
    workspaceRoot: cfg.workspaceRoot,
    systemPrompt: systemPromptFor(agent, cfg.persona, preset.model),
    fingerprint,
    // Cold start: rebuild what the model should remember from the transcript
    // the user can see. Without this, restarting the app (or opening a
    // freshly branched agent) left the model with no memory of a
    // conversation plainly visible on screen.
    //
    // The caller has already appended this turn's user message to the
    // transcript, and `Agent.run` appends it again — so the trailing user
    // entry is dropped here to avoid sending it twice.
    initialHistory: rebuildHistory(dropTrailingUserEntry(store.loadTranscript(agentId))),
    onApprovalRequired: async (req) => {
      // `readonly` denies anything needing approval; `auto` grants it.
      if (effectivePolicy === 'readonly') return false;
      if (effectivePolicy === 'auto') return true;
      return requestApproval(agentId, {
        toolName: req.toolName,
        summary: req.summary,
        detail: req.detail,
      });
    },
  });

  // The Agent is reused across turns, so rebind the sink for this run.
  session.setEventSink((e) => {
    if (e.type === 'delta') {
      text += e.text;
      flush(true);
    } else if (e.type === 'tool_call_start') {
      pushTranscript(agentId, {
        kind: 'tool-call',
        id: e.call.id,
        toolName: e.call.name,
        args: e.call.args,
        status: 'running',
        createdAt: Date.now(),
      });
    } else if (e.type === 'tool_call_result') {
      pushTranscript(agentId, {
        kind: 'tool-call',
        id: e.result.id,
        toolName: e.result.name,
        status: e.result.ok ? 'completed' : e.result.errorCode === 'denied' ? 'denied' : 'failed',
        content: e.result.content.slice(0, 4000),
        createdAt: Date.now(),
      });
    } else if (e.type === 'error') {
      // A fatal error is rethrown by `Agent.run` and reported below with a
      // message the user can act on. Emitting the raw text here too would
      // show the same failure twice — once as "fetch failed", once as the
      // explanation. Non-fatal notices (e.g. "Turn aborted by user") have no
      // second chance, so they are still shown.
      if (e.fatal) return;
      pushTranscript(agentId, {
        kind: 'notice',
        id: store.newId('err'),
        level: 'error',
        text: e.message,
        createdAt: Date.now(),
      });
    }
  });

  setRunning(agentId, true);
  emitEvent({ type: 'run-state', agentId, state: 'thinking' });
  flush(true);

  try {
    const final = await session.run(prompt, images);
    text = final.content;
  } catch (err) {
    // Raw provider failures are hostile — an HTTP 401 arrives as a wall of
    // JSON, a wrong base URL as the single word "fetch failed". Translate to
    // something that says what to change. A user-initiated Stop returns null
    // and is not reported as an error at all.
    const friendly = describeProviderError(err, {
      label: preset.label,
      baseUrl: preset.baseUrl,
      model: preset.model,
    });
    if (friendly) {
      pushTranscript(agentId, {
        kind: 'notice',
        id: store.newId('err'),
        level: 'error',
        text: friendly,
        createdAt: Date.now(),
      });
    }
  } finally {
    setRunning(agentId, false);
    flush(false);
    emitEvent({ type: 'run-state', agentId, state: 'idle' });
  }
  return text;
}

/**
 * Run a prompt on a delegate and return its answer to the calling agent.
 *
 * The delegate's work is written to its own transcript — the user can open
 * that agent and read exactly what it was asked and what it did, rather than
 * the delegation being an invisible side effect. A notice marks where the
 * request came from.
 */
async function runDelegated(
  targetId: string,
  task: string,
  chain: DelegationContext,
): Promise<string> {
  const caller = store.getAgent(chain.stack[chain.stack.length - 2] ?? '');
  pushTranscript(targetId, {
    kind: 'notice',
    id: store.newId('note'),
    level: 'info',
    text: `Task delegated by ${caller?.name ?? 'another agent'}.`,
    createdAt: Date.now(),
  });
  pushTranscript(targetId, {
    kind: 'message',
    id: store.newId('usr'),
    role: 'user',
    content: task,
    createdAt: Date.now(),
  });

  // Tell a terminal delegate that the buck stops with it. Otherwise an agent
  // whose instructions say "always hand this on" just finds no ask_agent tool
  // and echoes the request back instead of answering.
  const effectiveTask = isTerminal(targetId, chain) ? `${task}${TERMINAL_NOTICE}` : task;
  const answer = await runPrompt(targetId, effectiveTask, [], chain);
  return answer.trim() || '(the agent returned no text)';
}

/** Execute a routine by sending its prompt to the owning agent. */
async function runRoutine(routine: RoutineRecord): Promise<void> {
  pushTranscript(routine.agentId, {
    kind: 'notice',
    id: store.newId('note'),
    level: 'info',
    text: `Routine "${routine.name}" started.`,
    createdAt: Date.now(),
  });
  pushTranscript(routine.agentId, {
    kind: 'message',
    id: store.newId('usr'),
    role: 'user',
    content: routine.prompt,
    createdAt: Date.now(),
  });
  await runPrompt(routine.agentId, routine.prompt);
}

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
            label: 'Settings…',
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
  // real pipeline (bridge → agent → provider) without a human clicking.
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
  // broken build pass silently — which is worse than no check at all.
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
  store.initStore(userDataDir);
  initGrants(userDataDir);

  // One-time hardening: if an earlier build left the provider key in the
  // plaintext settings file, move it into the encrypted secrets store.
  try {
    const existing = readSettings(userDataDir, {}) as GlobalSettings & { apiKey?: string };
    if (existing.apiKey) {
      upsertSecrets(userDataDir, [{ key: 'GHOSTBOT_API_KEY', value: existing.apiKey }]);
      writeSettings(userDataDir, { apiKey: undefined } as never);
      fileLog('[secrets] moved plaintext settings apiKey → encrypted store');
    }
  } catch (err) {
    fileLog('[secrets] settings migration failed', (err as Error).message);
  }

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
