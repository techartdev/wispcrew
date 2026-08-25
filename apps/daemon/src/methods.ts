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
import {
  abortSession,
  clearTranscript,
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
  loadTranscript,
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

    /* conversation */
    getTranscript: (id: never) => loadTranscript(id),
    clearTranscript: (id: never) => clearTranscript(id),
    sendPrompt: (id: never, prompt: never) => runPrompt(id, prompt),
    stopAgent: (id: never) => abortSession(id),

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
    getSettings: () => readSettings(host().dataDir, defaultSettings()),
    writeSettings: (patch: never) => writeSettings(host().dataDir, patch),

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

    /* mcp */
    listMcpServers: () => mcpStatuses(),

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
