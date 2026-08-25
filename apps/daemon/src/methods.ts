/**
 * methods.ts — what a node exposes to clients.
 *
 * The desktop app's bridge has 42 methods, but three of them are not a
 * node's job at all: `pickFiles` and `pickDirectory` open native dialogs,
 * and `getAppInfo` describes the running application. Those belong to
 * whichever client the user is sitting in front of — a remote node has no
 * screen to show a file picker on, and answering them from a VPS would be
 * meaningless or misleading.
 *
 * Everything else is engine work and lives here.
 *
 * ## Why this is written out rather than reused from the desktop
 *
 * The desktop's bridge imports Electron for those three methods, so a daemon
 * cannot import it. Rather than contort that module, the node exposes the
 * engine directly: the implementations below are thin calls into
 * `@ghostbot/runtime`, which is the same code the desktop ultimately runs.
 * The duplication is the method *list*, not the behaviour.
 */
import { PERSONAS } from '@ghostbot/core';
import { describeLookup, findAllSubscriptions, PROVIDER_PRESETS } from '@ghostbot/llm';
import {
  abortSession,
  allStatuses,
  clearSession,
  clearTranscript,
  emitEngineEvent,
  fileLog,
  duplicateAgent,
  hasProviderKey,
  setProviderKey,
  signOut as oauthSignOut,
  status as oauthStatus,
  syncMcpServers,
  createAgent,
  createRoutine,
  createSkill,
  deleteAgent,
  deleteRoutine,
  deleteSkill,
  defaultSettings,
  host,
  listAgents,
  listGrants,
  listRoutines,
  listSkills,
  listCheckpoints,
  loadTranscript,
  readCheckpoint,
  saveTranscript,
  newId,
  pushTranscript,
  statuses as mcpStatuses,
  readSettings,
  revokeAll,
  revoke as revokeGrant,
  runPrompt,
  runRoutineNow,
  updateAgent,
  updateRoutine,
  updateSkill,
  writeSettings,
} from '@ghostbot/runtime';

export type MethodTable = Record<string, (...args: never[]) => unknown>;

/**
 * The provider catalogue, with `configured` answered for *this* node.
 *
 * The list of presets is static, but whether each has a usable credential is
 * a property of the machine — which is the point of per-node secrets. A node
 * reports what it can actually do, not what the client's machine can.
 */
function providerCatalogue(): unknown[] {
  return PROVIDER_PRESETS.map((preset) => ({
    ...preset,
    configured: preset.subscription
      ? oauthStatus(host().dataDir, preset.id === 'chatgpt-subscription' ? 'chatgpt' : 'anthropic')
          .signedIn
      : preset.local || hasProviderKey(host().dataDir, preset.id),
  }));
}

/** Settings as the UI sees them: never the key itself, only whether one exists. */
function settingsView(): unknown {
  const settings = readSettings(host().dataDir, defaultSettings()) as Record<string, unknown>;
  const presetId = (settings.presetId as string | undefined) ?? 'deepseek';
  return {
    ...settings,
    apiKey: undefined,
    hasApiKey: hasProviderKey(host().dataDir, presetId),
    isEncrypted: host().crypto.available(),
    encryptionDescription: host().crypto.describe(),
  };
}

/**
 * Build the node's method table.
 *
 * Unknown methods are rejected by the caller with the method name, so a
 * client asking for something a node does not implement gets a clear error
 * rather than a hang.
 */
export function nodeMethods(): MethodTable {
  return {
    /* agents */
    listAgents: () => listAgents(),
    createAgent: (patch: never) => createAgent(patch),
    updateAgent: (id: never, patch: never) => updateAgent(id, patch),
    deleteAgent: (id: never) => deleteAgent(id),
    duplicateAgent: (id: never) => duplicateAgent(id),

    /* conversation */
    getTranscript: (id: never) => loadTranscript(id),
    clearTranscript: (id: never) => clearTranscript(id),
    /**
     * Accept a prompt and start a turn.
     *
     * Two things here were wrong when this table was first written, and both
     * were visible to the user:
     *
     *  1. It called `runPrompt` directly, which does NOT record the user's
     *     message — the desktop bridge did that separately. Once the desktop
     *     started forwarding to a daemon, typed messages stopped appearing in
     *     the transcript at all.
     *
     *  2. It awaited the turn, so the call did not return until the agent had
     *     finished. A client could not send anything mid-run, because the
     *     previous request was still in flight.
     *
     * The message is now persisted first and the run is deliberately not
     * awaited: results stream back as events, exactly as they do locally.
     */
    sendPrompt: (id: never, prompt: never) => {
      const agentId = id as unknown as string;
      const text = String(prompt ?? '').trim();
      if (!text) return;

      pushTranscript(agentId, {
        kind: 'message',
        id: newId('usr'),
        role: 'user',
        content: text,
        createdAt: Date.now(),
      });

      /*
       * Not awaited, and its failures are caught here.
       *
       * Fire-and-forget is what lets a client keep talking while the agent
       * works — but it also makes this the last place a rejection can be
       * handled. Without the catch it becomes an unhandled rejection, and on
       * a daemon that means the process dies: every other agent stops and
       * every scheduled routine with it, because one turn failed.
       */
      void runPrompt(agentId, text).catch((err: Error) => {
        fileLog('[node] turn failed', agentId, err?.message ?? String(err));
        emitEngineEvent({
          type: 'notice',
          level: 'error',
          text: err?.message ?? 'The turn failed.',
        });
      });
    },
    stopAgent: (id: never) => abortSession(id),
    // The UI calls this `interrupt`; same operation, kept under both names so
    // a client does not need to know which engine it is talking to.
    interrupt: (id: never) => abortSession(id),

    /*
     * History recovery.
     *
     * Checkpoints live beside the transcript they protect, so a remote
     * agent's saved versions are on the node, not on whichever machine the
     * user happens to be sitting at.
     */
    listHistory: (id: never) =>
      listCheckpoints(host().dataDir, id as unknown as string).map((point) => ({
        file: point.file,
        createdAt: point.createdAt,
        entries: point.entries,
        reason: point.reason,
      })),
    restoreHistory: (id: never, file: never) => {
      const agentId = id as unknown as string;
      const entries = readCheckpoint(file as unknown as string);
      if (!entries) throw new Error('That saved version could not be read.');
      // Checkpoint what is there now, so a mistaken restore is undoable too.
      saveTranscript(agentId, entries, 'before restore');
      clearSession(agentId);
      return entries;
    },
    clearConversation: (id: never) => {
      clearSession(id);
      clearTranscript(id);
    },

    /* providers — the catalogue is static, but `configured` is per node */
    getPresets: () => providerCatalogue(),
    getPersonas: () => PERSONAS.map((p) => ({ id: p.id, label: p.label, description: p.description })),

    /*
     * Rewind and branch are deliberately absent.
     *
     * They are composed in the desktop bridge from several runtime calls
     * (rebuild history, prefix the transcript, seed a session). Reimplementing
     * that composition here would be a second copy that drifts. They belong in
     * the runtime first; until then a client performs them against its own
     * local engine, which is where conversations are edited anyway.
     */

    /* settings */
    getSettings: () => settingsView(),
    writeSettings: (patch: never) => writeSettings(host().dataDir, patch),
    saveSettings: (patch: never) => {
      /*
       * A key sent here is stored on THIS node and goes no further.
       *
       * That is the whole point of per-node secrets: a VPS holds only the
       * credentials the user gave it, so a compromised node costs that
       * node's keys rather than every key they own.
       */
      const { apiKey, ...rest } = (patch ?? {}) as { apiKey?: string } & Record<string, unknown>;
      const targetPreset =
        (rest.presetId as string | undefined) ??
        (readSettings(host().dataDir, defaultSettings()) as { presetId?: string }).presetId;
      if (apiKey && targetPreset) setProviderKey(host().dataDir, targetPreset, apiKey);
      writeSettings(host().dataDir, { ...rest, apiKey: undefined } as never);
      return settingsView();
    },

    /* routines */
    listRoutines: () => listRoutines(),
    createRoutine: (patch: never) => createRoutine(patch),
    updateRoutine: (id: never, patch: never) => updateRoutine(id, patch),
    deleteRoutine: (id: never) => deleteRoutine(id),
    runRoutineNow: (id: never) => runRoutineNow(id),

    /* skills */
    listSkills: () => listSkills(),
    createSkill: (patch: never) => createSkill(patch),
    updateSkill: (id: never, patch: never) => updateSkill(id, patch),
    deleteSkill: (id: never) => deleteSkill(id),

    /* permissions */
    listToolGrants: () => listGrants(),
    revokeToolGrant: (agentId: never, toolName: never) => revokeGrant(agentId, toolName),
    revokeAllToolGrants: () => revokeAll(),

    /* mcp — servers run on the node, so their lifecycle belongs here */
    listMcpServers: () => mcpStatuses(),
    addMcpServer: async (server: never) => {
      const settings = readSettings(host().dataDir, defaultSettings()) as {
        mcpServers?: unknown[];
      };
      const servers = [...(settings.mcpServers ?? []), server];
      writeSettings(host().dataDir, { mcpServers: servers } as never);
      return syncMcpServers({ ...settings, mcpServers: servers } as never);
    },
    removeMcpServer: async (name: never) => {
      const settings = readSettings(host().dataDir, defaultSettings()) as {
        mcpServers?: { name?: string }[];
      };
      const servers = (settings.mcpServers ?? []).filter((s) => s.name !== name);
      writeSettings(host().dataDir, { mcpServers: servers } as never);
      return syncMcpServers({ ...settings, mcpServers: servers } as never);
    },

    /* subscription sign-in state; the tokens themselves never leave the node */
    listOAuthStatus: () => allStatuses(host().dataDir),
    oauthSignOut: (vendor: never) => {
      oauthSignOut(host().dataDir, vendor);
      return allStatuses(host().dataDir);
    },
    listDetectedCliSignIns: () =>
      findAllSubscriptions().map((l) => ({
        vendor: (l.status === 'found' ? l.auth.vendor : l.vendor) === 'openai' ? 'chatgpt' : 'anthropic',
        source: l.status === 'found' ? l.auth.source : l.source,
        available: l.status === 'found',
        detail: describeLookup(l),
      })),

    /*
     * Interactive methods a node cannot complete alone.
     *
     * `resolveApproval` answers a question this node asked; `oauthSignIn`
     * needs a browser on the user's screen. Both are rejected with a message
     * that says what to do rather than failing obscurely — a client should
     * perform these against its own engine, and the node then sees the
     * result through the shared store.
     */
    resolveApproval: () => {
      throw new Error(
        'Approvals are answered by the client that is attached, not by the node.',
      );
    },
    oauthSignIn: () => {
      throw new Error(
        'Signing in needs a browser. Sign in on the machine you are sitting at, ' +
          'or configure this node with an API key.',
      );
    },
    oauthImportFromCli: () => {
      throw new Error(
        'Importing a CLI sign-in reads credentials from this machine. ' +
          'Run it on the node itself, or give the node its own API key.',
      );
    },

    /* node identity, so a client can show which machine it is talking to */
    nodeInfo: () => ({
      name: host().nodeName,
      dataDir: host().dataDir,
      workspace: host().defaultWorkspaceRoot,
      secrets: host().crypto.describe(),
      platform: process.platform,
    }),
  };
}
