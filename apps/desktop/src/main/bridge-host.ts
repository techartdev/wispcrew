/**
 * bridge-host.ts — main-process implementation of the `GhostBridge` contract.
 *
 * This is the entire renderer-facing surface of the app. It replaces the
 * reverse-engineered protocol shim with ~30 explicit, typed handlers we own.
 *
 * Conventions:
 *  - One `ipcMain.handle` per bridge method, named `gb:<method>`. Electron
 *    has no wildcard channels, so the list is explicit by necessity — which
 *    is also what makes the attack surface reviewable.
 *  - Handlers return plain values and throw on failure. The preload converts
 *    a rejection into a rejected promise in the renderer; there are no
 *    `{ok,value}` envelopes to get subtly wrong.
 *  - Events are pushed to every live window via `gb:event`.
 *  - No secret ever leaves through this boundary. `getSettings` reports
 *    `hasApiKey`/`isEncrypted` only.
 */
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron';
import {
  chatgptOAuth,
  claudeOAuth,
  createProvider,
  configFromPreset,
  describeLookup,
  describeProviderError,
  findAllSubscriptions,
  findAnthropicSubscription,
  findOpenAiSubscription,
  PROVIDER_PRESETS,
} from '@ghostbot/llm';
import { PERSONAS } from '@ghostbot/core';
import type {
  AgentRecord,
  ApprovalResolution,
  Attachment,
  BridgeEvent,
  GlobalSettings,
  McpServerRecord,
  RoutineRecord,
  SettingsView,
  SkillRecord,
  TranscriptEntry,
} from '@ghostbot/shared';
import * as store from './store.js';
import { loadAttachments } from './attachments.js';
import { readSettings, writeSettings } from './settings-file.js';
import { readSecrets, upsertSecrets, isEncryptionAvailable } from './secrets-store.js';
import { statuses as mcpStatuses, syncMcpServers } from './mcp-manager.js';
import { runRoutineNow, refreshNextRunTime, refreshNextRunTimes } from './scheduler.js';
import { abortSession, clearSession, seedSessionHistory } from './agent-sessions.js';
import { prefixBefore, prefixThrough, rebuildHistory } from './branching.js';
import { grant, isGranted, listGrants, revoke, revokeAll, revokeForAgent } from './grants.js';
import {
  allStatuses,
  saveCredential,
  signOut,
  status,
  type OAuthVendor,
} from './oauth-store.js';
import { fileLog } from './filelog.js';

/**
 * Ask the user to paste the authorization code Anthropic's callback page
 * shows.
 *
 * A modal input box rather than an in-app panel: the sign-in is a short,
 * blocking step, and the code expires within about a minute, so anything
 * that lets the window be lost behind the browser makes it fail.
 */
async function promptForAuthCode(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) return null;

  // Electron has no text-input dialog, so a tiny always-on-top window with
  // one field is the honest way to do this without pulling in a dependency.
  const prompt = new BrowserWindow({
    width: 520,
    height: 260,
    parent: win,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Finish signing in to Claude',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const html = `<!doctype html><meta charset="utf-8">
<style>
 body{font-family:system-ui;background:#161a21;color:#e6e9ef;margin:0;padding:20px}
 h3{margin:0 0 6px;font-size:15px}
 p{margin:0 0 14px;color:#98a1b0;font-size:13px;line-height:1.5}
 input{width:100%;padding:9px 11px;background:#1c212a;border:1px solid #333b49;
   border-radius:8px;color:#e6e9ef;font:inherit;font-size:13px;box-sizing:border-box}
 input:focus{outline:none;border-color:#39c2f0}
 .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
 button{padding:7px 14px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;
   background:#1c212a;border:1px solid #333b49;color:#e6e9ef}
 .primary{background:#1b8fd4;border-color:#1b8fd4;color:#fff;font-weight:550}
</style>
<h3>Paste the code from your browser</h3>
<p>Claude's page shows a code after you approve the sign-in. Paste it here —
codes expire after about a minute.</p>
<input id="c" autofocus placeholder="code#state" spellcheck="false">
<div class="row">
  <button onclick="done('')">Cancel</button>
  <button class="primary" onclick="done(document.getElementById('c').value)">Sign in</button>
</div>
<script>
 function done(v){ location.href = 'ghostbot-code://' + encodeURIComponent(v); }
 document.getElementById('c').addEventListener('keydown', e => {
   if (e.key === 'Enter') done(e.target.value);
   if (e.key === 'Escape') done('');
 });
</script>`;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (!prompt.isDestroyed()) prompt.destroy();
      resolve(value);
    };

    // The page signals its result by navigating to a custom scheme, which we
    // intercept — no preload or IPC channel needed for a one-shot dialog.
    prompt.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('ghostbot-code://')) return;
      event.preventDefault();
      const value = decodeURIComponent(url.slice('ghostbot-code://'.length)).trim();
      finish(value || null);
    });
    prompt.on('closed', () => finish(null));
    void prompt.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

/**
 * Name a branch without accumulating "copy of copy of".
 *
 * "Research" -> "Research (2)" -> "Research (3)".
 */
function nextBranchName(name: string): string {
  const m = /^(.*) \((\d+)\)$/.exec(name);
  const base = m ? m[1]! : name;
  const start = m ? Number(m[2]) + 1 : 2;
  const taken = new Set(store.listAgents().map((a) => a.name));
  for (let n = start; n < start + 500; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

/** Injected by main.ts so the bridge stays free of agent-loop details. */
export interface BridgeContext {
  userDataDir: string;
  /**
   * Execute a prompt for an agent; streams via the emit callbacks.
   * Resolves with the assistant's final text (used by agent delegation);
   * the bridge itself ignores the value.
   */
  runPrompt(agentId: string, prompt: string, attachments?: Attachment[]): Promise<unknown>;
  /** Default settings when the file is absent (env fallbacks). */
  defaults(): GlobalSettings;
}

let ctx: BridgeContext;

/** Pending approvals: requestId → resolver awaiting the user's decision. */
const pendingApprovals = new Map<string, (approved: boolean) => void>();
/** Tools the user chose "always allow" for, per agent, for this app run. */
/**
 * Approvals still awaiting a decision, keyed by requestId. The tool name is
 * kept alongside the resolver so "always allow" can record a grant for the
 * right tool once the user answers.
 */
const pendingMeta = new Map<string, { agentId: string; toolName: string }>();

/* ------------------------------------------------------------------ */
/* Event fan-out                                                       */
/* ------------------------------------------------------------------ */

/** Push an event to every open window. */
export function emitEvent(event: BridgeEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('gb:event', event);
  }
}

/** Convenience: push a transcript entry and persist it in one step. */
export function pushTranscript(agentId: string, entry: TranscriptEntry): void {
  store.upsertTranscriptEntry(agentId, entry);
  emitEvent({ type: 'transcript', agentId, entry });
}

export function emitAgents(): void {
  emitEvent({ type: 'agents-changed', agents: store.listAgents() });
}

export function emitRoutines(): void {
  emitEvent({ type: 'routines-changed', routines: store.listRoutines() });
}

export function emitMcp(): void {
  emitEvent({ type: 'mcp-changed', servers: mcpStatuses() });
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

/**
 * Ask the user to approve a tool call.
 *
 * Returns a promise that settles when the renderer calls `resolveApproval`.
 * "Always allow" is remembered per agent+tool for the lifetime of the
 * process — deliberately not persisted, so a standing grant cannot outlive
 * the session that granted it without the user knowing.
 */
export function requestApproval(
  agentId: string,
  req: { toolName: string; summary: string; detail?: string },
): Promise<boolean> {
  // A standing grant the user made earlier, in this session or a previous
  // one. Persisted grants are listed and revocable in Settings — a permission
  // the user cannot see or withdraw would be worse than asking every time.
  if (isGranted(agentId, req.toolName)) return Promise.resolve(true);

  const requestId = store.newId('appr');
  const entry: TranscriptEntry = {
    kind: 'approval',
    id: requestId,
    requestId,
    toolName: req.toolName,
    summary: req.summary,
    detail: req.detail,
    status: 'pending',
    createdAt: Date.now(),
  };
  pushTranscript(agentId, entry);
  emitEvent({ type: 'run-state', agentId, state: 'awaiting-approval' });
  emitEvent({ type: 'approval', agentId, requestId, ...req });

  pendingMeta.set(requestId, { agentId, toolName: req.toolName });

  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(requestId, (approved) => {
      pendingMeta.delete(requestId);
      pushTranscript(agentId, {
        ...entry,
        status: approved ? 'approved' : 'denied',
      });
      resolve(approved);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Settings helpers                                                    */
/* ------------------------------------------------------------------ */

/** Does a usable provider key exist anywhere (secrets store or env)? */
function hasStoredKey(presetId: string): boolean {
  const secrets = readSecrets(ctx.userDataDir);
  const perProvider: Record<string, string> = {
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    groq: 'GROQ_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  };
  if (secrets.GHOSTBOT_API_KEY) return true;
  const named = perProvider[presetId];
  if (named && secrets[named]) return true;
  return Boolean(process.env.GHOSTBOT_API_KEY);
}

function settingsView(): SettingsView {
  const s = readSettings(ctx.userDataDir, ctx.defaults()) as GlobalSettings;
  return {
    ...s,
    hasApiKey: hasStoredKey(s.presetId ?? 'deepseek'),
    isEncrypted: isEncryptionAvailable(),
  };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/** Register every bridge channel. Call once, after `app.whenReady()`. */
export function registerBridge(context: BridgeContext): void {
  ctx = context;

  const handle = <T>(name: string, fn: (...args: never[]) => T | Promise<T>): void => {
    ipcMain.handle(`gb:${name}`, async (_e, ...args) => {
      try {
        return await (fn as (...a: unknown[]) => T | Promise<T>)(...args);
      } catch (err) {
        // Log then rethrow: the renderer sees a rejected promise with the
        // message, and we keep a durable trace for debugging.
        fileLog('[bridge] error', name, (err as Error).message);
        throw err;
      }
    });
  };

  /* -- agents -------------------------------------------------- */

  handle('listAgents', () => store.listAgents());

  handle('createAgent', (patch: Partial<AgentRecord>) => {
    const created = store.createAgent(patch);
    emitAgents();
    return created;
  });

  handle('updateAgent', (id: string, patch: Partial<AgentRecord>) => {
    const updated = store.updateAgent(id, patch);
    emitAgents();
    return updated;
  });

  handle('deleteAgent', (id: string) => {
    clearSession(id);
    store.deleteAgent(id);
    // Drop standing grants with the agent, so an id that happens to be
    // reused can never inherit a permission granted to something else.
    revokeForAgent(id);
    emitEvent({ type: 'grants-changed', grants: listGrants() });
    // Routines belonging to a deleted agent would never fire again; remove
    // them rather than leaving invisible orphans in the store.
    for (const r of store.listRoutines(id)) store.deleteRoutine(r.id);
    emitAgents();
    emitRoutines();
  });

  handle('duplicateAgent', (id: string) => {
    const copy = store.duplicateAgent(id);
    emitAgents();
    return copy;
  });

  /* -- conversation -------------------------------------------- */

  handle('getTranscript', (agentId: string, limit?: number) => {
    const all = store.loadTranscript(agentId);
    return typeof limit === 'number' ? all.slice(-limit) : all;
  });

  handle('sendPrompt', async (agentId: string, prompt: string, attachmentPaths?: string[]) => {
    const text = String(prompt ?? '').trim();
    const paths = Array.isArray(attachmentPaths) ? attachmentPaths.filter((p) => typeof p === 'string') : [];
    if (!text && paths.length === 0) return;

    const attachments = paths.length ? await loadAttachments(paths) : [];

    pushTranscript(agentId, {
      kind: 'message',
      id: store.newId('usr'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      // Store metadata only: base64 image data would bloat the transcript
      // file by megabytes per message and is never re-sent from history.
      ...(attachments.length
        ? {
            attachments: attachments.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              size: a.size,
              kind: a.kind,
            })),
          }
        : {}),
    });

    // Deliberately not awaited: the call returns as soon as the prompt is
    // accepted, and results stream back as events.
    void ctx.runPrompt(agentId, text, attachments);
  });

  handle('pickFiles', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All supported', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'json', 'csv', 'yaml', 'yml', 'ts', 'js', 'py', 'go', 'rs', 'java', 'html', 'css', 'xml', 'log'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  handle('interrupt', (agentId: string) => {
    const stopped = abortSession(agentId);
    if (stopped) {
      pushTranscript(agentId, {
        kind: 'notice',
        id: store.newId('note'),
        level: 'info',
        text: 'Run interrupted.',
        createdAt: Date.now(),
      });
      emitEvent({ type: 'run-state', agentId, state: 'idle' });
    }
  });

  handle('clearConversation', (agentId: string) => {
    clearSession(agentId);
    store.clearTranscript(agentId);
    emitEvent({ type: 'run-state', agentId, state: 'idle' });
  });

  handle('rewindConversation', (agentId: string, entryId: string, mode?: 'through' | 'before') => {
    const entries = store.loadTranscript(agentId);
    const kept = mode === 'before' ? prefixBefore(entries, entryId) : prefixThrough(entries, entryId);
    // A missing entry is not an error: the UI may have rendered the button
    // before the transcript was cleared or trimmed underneath it.
    if (kept === null) return entries;

    store.saveTranscript(agentId, kept);
    // Keep the live Agent's memory in step with what the user now sees;
    // otherwise the model would still remember the discarded turns.
    seedSessionHistory(agentId, rebuildHistory(kept));
    emitEvent({ type: 'run-state', agentId, state: 'idle' });
    for (const entry of kept.slice(-1)) {
      emitEvent({ type: 'transcript', agentId, entry });
    }
    return kept;
  });

  handle('branchConversation', (agentId: string, entryId: string) => {
    const source = store.getAgent(agentId);
    if (!source) throw new Error(`No such agent: ${agentId}`);
    const entries = store.loadTranscript(agentId);
    const kept = prefixThrough(entries, entryId);
    if (kept === null) throw new Error('That message is no longer in the conversation.');

    // A branch is a new agent with the same configuration, seeded with the
    // shared prefix. The original conversation is untouched.
    const branch = store.createAgent({
      ...source,
      id: undefined,
      name: nextBranchName(source.name),
      pinned: false,
    });
    store.saveTranscript(branch.id, kept);
    emitAgents();
    return branch;
  });

  handle('resolveApproval', (requestId: string, resolution: ApprovalResolution) => {
    const resolve = pendingApprovals.get(requestId);
    if (!resolve) return;
    pendingApprovals.delete(requestId);

    // "Always allow" records a standing grant for this agent + tool. Only an
    // explicit allow-always does so — a denial never creates a grant.
    if (resolution === 'allow-always') {
      const meta = pendingMeta.get(requestId);
      if (meta) {
        grant(meta.agentId, meta.toolName);
        emitEvent({ type: 'grants-changed', grants: listGrants() });
      }
    }
    resolve(resolution !== 'deny');
  });

  /* -- subscription sign-in ------------------------------------ */

  handle('listOAuthStatus', () => allStatuses(ctx.userDataDir));

  handle('oauthSignIn', async (vendor: OAuthVendor) => {
    if (vendor === 'chatgpt') {
      // Loopback flow: the browser redirects straight back to us, so there
      // is nothing for the user to copy.
      const pending = await chatgptOAuth.startLogin();
      await shell.openExternal(pending.authorizeUrl);
      const credential = await pending.completed;
      saveCredential(ctx.userDataDir, 'chatgpt', credential);
    } else {
      // Anthropic registers one non-loopback redirect for this client, so
      // the callback page shows a code the user pastes back. That is a
      // constraint of the registration, not a shortcut.
      const pkce = claudeOAuth.generatePkce();
      await shell.openExternal(claudeOAuth.buildAuthorizeUrl(pkce));
      const answer = await promptForAuthCode();
      if (!answer) throw new Error('Sign-in cancelled.');
      const parsed = claudeOAuth.parseAuthorizationInput(answer);
      if (!parsed.code) throw new Error('That did not look like an authorization code.');
      const credential = await claudeOAuth.exchangeAuthorizationCode(
        parsed.code,
        parsed.state ?? pkce.verifier,
        pkce.verifier,
      );
      saveCredential(ctx.userDataDir, 'anthropic', credential);
    }
    emitEvent({ type: 'oauth-changed', statuses: allStatuses(ctx.userDataDir) });
    return status(ctx.userDataDir, vendor);
  });

  handle('oauthSignOut', (vendor: OAuthVendor) => {
    signOut(ctx.userDataDir, vendor);
    emitEvent({ type: 'oauth-changed', statuses: allStatuses(ctx.userDataDir) });
    return allStatuses(ctx.userDataDir);
  });

  handle('oauthImportFromCli', (vendor: OAuthVendor) => {
    const lookup = vendor === 'chatgpt' ? findOpenAiSubscription() : findAnthropicSubscription();
    if (lookup.status !== 'found') {
      throw new Error(describeLookup(lookup));
    }
    const auth = lookup.auth;
    saveCredential(ctx.userDataDir, vendor, {
      type: 'oauth',
      access: auth.accessToken,
      // A CLI-held credential may carry no refresh token we can see; the
      // store treats an absent one as "cannot refresh", and the user is told
      // to sign in properly when it lapses.
      refresh: '',
      expires: auth.expiresAt ?? Date.now() + 60 * 60 * 1000,
      ...(auth.accountId ? { accountId: auth.accountId } : {}),
      ...(auth.plan ? { plan: auth.plan } : {}),
    });
    emitEvent({ type: 'oauth-changed', statuses: allStatuses(ctx.userDataDir) });
    return status(ctx.userDataDir, vendor);
  });

  handle('listDetectedCliSignIns', () =>
    findAllSubscriptions().map((l) => ({
      vendor: (l.status === 'found' ? l.auth.vendor : l.vendor) === 'openai' ? 'chatgpt' : 'anthropic',
      source: l.status === 'found' ? l.auth.source : l.source,
      available: l.status === 'found',
      detail: describeLookup(l),
      ...(l.status === 'found' && l.auth.plan ? { plan: l.auth.plan } : {}),
    })),
  );

  handle('listToolGrants', () => listGrants());

  handle('revokeToolGrant', (agentId: string, toolName: string) => {
    revoke(agentId, toolName);
    emitEvent({ type: 'grants-changed', grants: listGrants() });
    return listGrants();
  });

  handle('revokeAllToolGrants', () => {
    revokeAll();
    emitEvent({ type: 'grants-changed', grants: listGrants() });
    return listGrants();
  });

  /* -- settings & providers ------------------------------------ */

  handle('getSettings', () => settingsView());

  handle('saveSettings', (patch: Partial<GlobalSettings> & { apiKey?: string }) => {
    const { apiKey, ...rest } = patch;
    // The key goes to the encrypted store; it must never reach the settings
    // file, which is plaintext JSON.
    if (apiKey) upsertSecrets(ctx.userDataDir, [{ key: 'GHOSTBOT_API_KEY', value: apiKey }]);
    writeSettings(ctx.userDataDir, { ...rest, apiKey: undefined } as never);
    if (rest.mcpServers) {
      void syncMcpServers(readSettings(ctx.userDataDir, {}) as never).then(emitMcp);
    }
    return settingsView();
  });

  handle('getPresets', () => PROVIDER_PRESETS);

  handle('getPersonas', () =>
    PERSONAS.map((p) => ({ id: p.id, label: p.label, description: p.description })),
  );

  handle(
    'testConnection',
    async (cfg: { presetId: string; apiKey?: string; model?: string; baseUrl?: string }) => {
      const started = Date.now();
      try {
        // Fall back to the stored key so "Test" works without retyping it.
        const key = cfg.apiKey || readSecrets(ctx.userDataDir).GHOSTBOT_API_KEY;
        const preset = configFromPreset(cfg.presetId, {
          apiKey: key,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
        });
        const provider = createProvider(preset);
        const check = provider.validate();
        if (!check.ok) return { ok: false, error: check.error };

        let ok = false;
        let error = 'No response from the endpoint.';
        for await (const chunk of provider.chat({
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 8,
          stream: false,
        })) {
          if (chunk.kind === 'done') {
            ok = true;
            error = '';
          } else if (chunk.kind === 'error') {
            error = chunk.message;
          }
        }
        return { ok, error: error || undefined, latencyMs: Date.now() - started };
      } catch (err) {
        // "Test connection" is exactly where a misconfiguration should be
        // explained rather than dumped, so translate here too.
        const target = configFromPreset(cfg.presetId, {
          model: cfg.model,
          baseUrl: cfg.baseUrl,
        });
        return {
          ok: false,
          error:
            describeProviderError(err, {
              label: target.label,
              baseUrl: target.baseUrl,
              model: target.model,
            }) ?? 'Cancelled.',
        };
      }
    },
  );

  /* -- MCP ----------------------------------------------------- */

  const currentSettings = () => readSettings(ctx.userDataDir, ctx.defaults()) as GlobalSettings;

  const persistServers = async (servers: McpServerRecord[]) => {
    writeSettings(ctx.userDataDir, { mcpServers: servers } as never);
    await syncMcpServers({ mcpServers: servers } as never);
    emitMcp();
    return mcpStatuses();
  };

  handle('listMcpServers', () => mcpStatuses());

  handle('addMcpServer', async (server: McpServerRecord) => {
    const servers = currentSettings().mcpServers ?? [];
    if (servers.some((s) => s.name === server.name)) {
      throw new Error(`An MCP server named "${server.name}" already exists.`);
    }
    return persistServers([...servers, server]);
  });

  handle('updateMcpServer', async (name: string, patch: Partial<McpServerRecord>) => {
    const servers = (currentSettings().mcpServers ?? []).map((s) =>
      s.name === name ? { ...s, ...patch } : s,
    );
    return persistServers(servers);
  });

  handle('removeMcpServer', async (name: string) => {
    const servers = (currentSettings().mcpServers ?? []).filter((s) => s.name !== name);
    return persistServers(servers);
  });

  handle('setMcpToolEnabled', (prefixedTool: string, enabled: boolean) => {
    const s = currentSettings();
    const disabled = new Set(s.mcpDisabledTools ?? []);
    if (enabled) disabled.delete(prefixedTool);
    else disabled.add(prefixedTool);
    writeSettings(ctx.userDataDir, { mcpDisabledTools: [...disabled] } as never);
  });

  /* -- routines ------------------------------------------------ */

  handle('listRoutines', (agentId?: string) => store.listRoutines(agentId));

  handle('createRoutine', (patch: Partial<RoutineRecord> & { agentId: string }) => {
    const created = store.createRoutine(patch);
    refreshNextRunTime(created.id);
    emitRoutines();
    return store.listRoutines().find((r) => r.id === created.id) ?? created;
  });

  handle('updateRoutine', (id: string, patch: Partial<RoutineRecord>) => {
    const updated = store.updateRoutine(id, patch);
    refreshNextRunTime(id);
    emitRoutines();
    return store.listRoutines().find((r) => r.id === id) ?? updated;
  });

  handle('deleteRoutine', (id: string) => {
    store.deleteRoutine(id);
    emitRoutines();
  });

  handle('runRoutineNow', async (id: string) => {
    await runRoutineNow(id);
    emitRoutines();
  });

  /* -- skills -------------------------------------------------- */

  handle('listSkills', () => store.listSkills());

  handle('createSkill', (patch: Partial<SkillRecord>) => store.createSkill(patch));

  handle('updateSkill', (id: string, patch: Partial<SkillRecord>) => store.updateSkill(id, patch));

  handle('deleteSkill', (id: string) => store.deleteSkill(id));

  /* -- misc ---------------------------------------------------- */

  handle('pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle('openPath', async (target: string) => {
    // `openPath` refuses anything that is not an existing file/dir, and we
    // never pass a URL here, so this cannot be turned into a browser launcher.
    await shell.openPath(target);
  });

  handle('getAppInfo', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron ?? 'unknown',
  }));

  refreshNextRunTimes();
  fileLog('[bridge] registered');
}
