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
 * `@wispcrew/runtime`, which is the same code the desktop ultimately runs.
 * The duplication is the method *list*, not the behaviour.
 */
import { PERSONAS } from '@wispcrew/core';
import { describeLookup, findAllSubscriptions, PROVIDER_PRESETS } from '@wispcrew/llm';
import {
  createAgentWithRoom,
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
  addParticipant,
  getConversation,
  listCheckpoints,
  listConversations,
  loadTranscript,
  removeParticipant,
  runRoomTurn,
  updateConversation,
  LOCAL_HUMAN_ID,
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
  listTurns,
  updateTurn,
  rewindConversation,
  branchConversation,
  testConnection,
  testTelegram,
  TELEGRAM_TOKEN_KEY,
  getSecret,
} from '@wispcrew/runtime';
import { listPending, resolve as resolveApprovalRequest, touchApprovalListener } from './pending-approvals.js';
import { handleFor } from '@wispcrew/shared';

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
    // With its room: an agent that has none cannot be talked to.
    createAgent: (patch: never) => createAgentWithRoom(patch),
    updateAgent: (id: never, patch: never) => updateAgent(id, patch),
    deleteAgent: (id: never) => deleteAgent(id),
    duplicateAgent: (id: never) => duplicateAgent(id),

    /* rooms — conversations with participants */
    listConversations: () => listConversations(),

    addRoomAgent: (conversationId: never, agentId: never) => {
      const id = conversationId as unknown as string;
      const agent = listAgents().find((a) => a.id === (agentId as unknown as string));
      if (!agent) throw new Error('No such agent.');

      const room = getConversation(id);
      if (!room) throw new Error('No such conversation.');

      // A handle unique within THIS room: two agents called "Build server"
      // would otherwise share `@build`, and an ambiguous mention is worst
      // exactly when precision matters.
      const taken = room.participants
        .filter((p) => p.kind === 'agent')
        .map((p) => (p as { handle: string }).handle);

      return addParticipant(
        id,
        { kind: 'agent', id: agent.id, handle: handleFor(agent.name, taken) },
        LOCAL_HUMAN_ID,
        'You',
      );
    },

    removeRoomParticipant: (conversationId: never, participantId: never) =>
      removeParticipant(
        conversationId as unknown as string,
        participantId as unknown as string,
        LOCAL_HUMAN_ID,
        'You',
      ),

    setRoomMode: (conversationId: never, mode: never) =>
      updateConversation(conversationId as unknown as string, {
        mode: mode as unknown as 'directed' | 'open' | 'free',
      }),

    sendToRoom: (conversationId: never, text: never) => {
      /*
       * Fire and forget, like sendPrompt.
       *
       * A turn can take minutes and the caller must stay free to send
       * another message or interrupt. An un-awaited rejection here would
       * take down the daemon and every agent with it, so it is caught.
       */
      void runRoomTurn({
        conversationId: conversationId as unknown as string,
        text: text as unknown as string,
        speakerId: LOCAL_HUMAN_ID,
      }).catch((err: Error) => {
        emitEngineEvent({ type: 'notice', level: 'error', text: err.message });
      });
    },

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

      /*
       * Through the room, which writes the entry and claims the turn.
       *
       * This used to write the entry itself and call `runPrompt`, so a
       * message arriving twice ran twice — while the identical message sent
       * to a room ran once. A protection that covers some ways of sending
       * the same message is worse than none, because it looks complete.
       *
       * Not awaited, and its failures are caught here. Fire-and-forget is
       * what lets a client keep talking while the agent works — but it also
       * makes this the last place a rejection can be handled. Without the
       * catch it becomes an unhandled rejection, and on a daemon that means
       * the process dies: every other agent stops and every scheduled
       * routine with it, because one turn failed.
       */
      void runRoomTurn({
        conversationId: agentId,
        text,
        speakerId: LOCAL_HUMAN_ID,
      }).catch((err: Error) => {
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
    /*
     * Settings only — never a key.
     *
     * `saveSettings` below is the one that stores credentials. This writes
     * the patch as given, so an `apiKey` here would land in the plaintext
     * settings file, which is exactly the bug class hard rule 5 exists for.
     *
     * Refusing is deliberate. Silently dropping it shipped once and cost a
     * day: `configureNode` reported success, the VPS stored nothing, and a
     * remote agent produced empty turns with no error anywhere.
     */
    writeSettings: (patch: never) => {
      if ((patch as { apiKey?: unknown } | null)?.apiKey !== undefined) {
        throw new Error('writeSettings cannot store an API key — use saveSettings.');
      }
      return writeSettings(host().dataDir, patch);
    },
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
    /*
     * Pending approvals, for a client that can ask a person.
     *
     * These belong to whoever is at the machine the tool would run on, and
     * `wispcrew approvals` is that someone.
     */
    /*
     * Editing a conversation, from either host.
     *
     * The logic lives in the runtime rather than here, because the desktop
     * needs identical behaviour and two copies of transcript editing would
     * drift — this project has already had two functions that looked the
     * same and quietly did not.
     *
     * No session hooks are passed: a node has no live view to keep in step,
     * and the next turn rebuilds its history from the transcript anyway.
     */
    rewindConversation: (agentId: never, entryId: never, mode: never) =>
      rewindConversation(
        String(agentId),
        String(entryId),
        (mode as unknown as 'through' | 'before') ?? 'through',
      ),

    branchConversation: (agentId: never, entryId: never, name: never) =>
      branchConversation(String(agentId), String(entryId), name ? String(name) : undefined),

    /*
     * Does the configured provider actually answer?
     *
     * The difference between "configured" and "working", and it matters most
     * here: a headless machine has no settings panel to show a red dot, so
     * the first symptom would otherwise be an agent producing nothing.
     */
    testConnection: async (cfg: never) => {
      const settings = readSettings(host().dataDir, defaultSettings()) as Record<string, unknown>;
      const given = (cfg ?? {}) as Record<string, unknown>;

      return testConnection({
        presetId: String(given.presetId ?? settings.presetId ?? 'deepseek'),
        apiKey: given.apiKey as string | undefined,
        model: (given.model ?? settings.model) as string | undefined,
        baseUrl: (given.baseUrl ?? settings.baseUrl) as string | undefined,
      });
    },

    /*
     * Does Telegram accept a message from this machine?
     *
     * Same reasoning as `testConnection`, for the other credential a
     * headless node depends on. The runtime already had the function; only
     * the node's table was missing it, so the CLI's `test telegram` failed
     * with "Unknown method" on a real server.
     */
    testTelegram: async () => {
      const dataDir = host().dataDir;
      const token = getSecret(dataDir, TELEGRAM_TOKEN_KEY);
      if (!token) return { ok: false, error: 'No bot token saved on this machine.' };

      const settings = readSettings(dataDir, defaultSettings()) as {
        channels?: { telegram?: { chatId?: string } };
      };
      const chatId = settings.channels?.telegram?.chatId;
      if (!chatId) return { ok: false, error: 'No chat id configured on this machine.' };

      return testTelegram({ token, chatId });
    },

    /*
     * Turns, as tasks an external caller can follow.
     *
     * A turn is already durable and already survives a restart — it exists so
     * a claim is not lost when a node dies mid-run. Exposing it costs nothing
     * new and gives an orchestrator the one thing polling a transcript
     * cannot: a stable id whose state it can ask about, including after the
     * process that started the work has gone.
     */
    listTurns: (conversationId: never) => listTurns(conversationId as unknown as string),

    cancelTurn: (id: never) => {
      const wanted = String(id);
      const turn = listTurns().find((t) => t.id === wanted);
      if (!turn) throw new Error('No such task.');

      /*
       * Only an unfinished turn can be cancelled.
       *
       * Marking a completed one as cancelled would rewrite history: the work
       * happened and its output is in the transcript, so saying otherwise
       * makes the record lie to whoever reads it next.
       */
      if (turn.state === 'completed' || turn.state === 'failed') {
        throw new Error(`That task already ${turn.state}.`);
      }

      updateTurn(turn.id, { state: 'cancelled', detail: 'cancelled by a client' });
      return { ok: true, id: turn.id };
    },

    listApprovals: () => {
      /*
       * Asking counts as watching.
       *
       * A client that polls this is, by definition, one that intends to
       * answer — so listing registers interest and keeps it alive for a
       * while afterwards. Requiring a separate "I am watching" call would
       * mean a script that polls approvals still gets them denied, which is
       * a distinction nobody would guess.
       */
      touchApprovalListener();
      return listPending();
    },

    resolveApproval: (id: never, allowed: never) => {
      /*
       * Answerable now, where this used to throw.
       *
       * The old message said approvals belong to the attached client, which
       * was right when the only client was a desktop running its own engine.
       * A CLI attached to THIS node is a person sitting at this machine —
       * precisely who should decide whether a command runs on it.
       *
       * Still not a bypass: an unanswered request times out as a denial.
       */
      const settled = resolveApprovalRequest(String(id), Boolean(allowed));
      if (!settled) {
        throw new Error('That approval is unknown, already answered, or expired.');
      }
      return { ok: true };
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
