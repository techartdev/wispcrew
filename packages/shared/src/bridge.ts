/**
 * GhostBot — the renderer ⇄ main IPC contract.
 *
 * This is the entire surface the desktop UI may use. It replaces the
 * reverse-engineered protocol shim with a small, explicit API that we own.
 *
 * Design rules, learned the hard way:
 *  1. **One typed interface, no string channels in UI code.** The preload
 *     exposes exactly `GhostBridge`; the renderer never calls `ipcRenderer`
 *     directly, so contextIsolation can stay on and the attack surface is
 *     enumerable in this file.
 *  2. **Requests return plain values, not envelopes.** Errors reject. The old
 *     shim's `{ok,value}|{ok,failure}` wrappers caused silent `malformed-reply`
 *     bugs whenever a shape drifted; a rejected promise cannot be misread.
 *  3. **Streaming is push, not poll.** Main pushes `onEvent` deltas, so the UI
 *     updates at token speed with no polling interval to tune and no wasted
 *     wakeups while an agent is idle.
 *  4. **Secrets never cross this boundary outbound.** `getSettings` reports
 *     `hasApiKey`/`isEncrypted`, never the key itself.
 */
import type {
  AgentRecord,
  AgentRunState,
  GlobalSettings,
  McpServerRecord,
  McpServerStatus,
  RoutineRecord,
  SkillRecord,
  ToolGrant,
  TranscriptEntry,
} from './domain.js';

/* ------------------------------------------------------------------ */
/* Push events (main → renderer)                                       */
/* ------------------------------------------------------------------ */

/**
 * Events streamed from main. `entry` carries the full replacement entry so
 * the renderer can upsert by id without reconstructing partial state.
 */
export type BridgeEvent =
  /** An entry was added or updated (streaming deltas arrive as updates). */
  | { type: 'transcript'; agentId: string; entry: TranscriptEntry }
  /** The agent's run state changed (drives the roster status dot). */
  | { type: 'run-state'; agentId: string; state: AgentRunState }
  /** A tool call needs a decision; resolve with `resolveApproval`. */
  | {
      type: 'approval';
      agentId: string;
      requestId: string;
      toolName: string;
      summary: string;
      detail?: string;
    }
  /** The agent roster changed (created/renamed/deleted elsewhere). */
  | { type: 'agents-changed'; agents: AgentRecord[] }
  /** MCP server connection states changed. */
  | { type: 'mcp-changed'; servers: McpServerStatus[] }
  /** A routine started or finished. */
  | { type: 'routines-changed'; routines: RoutineRecord[] }
  /** Standing tool permissions changed (granted, revoked, agent deleted). */
  | { type: 'grants-changed'; grants: ToolGrant[] }
  /** A subscription sign-in was added, refreshed or removed. */
  | { type: 'oauth-changed'; statuses: OAuthStatusView[] }
  /** Non-fatal problem worth surfacing in the UI. */
  | { type: 'notice'; level: 'info' | 'error'; text: string };

/* ------------------------------------------------------------------ */
/* Supporting shapes                                                   */
/* ------------------------------------------------------------------ */

/** Settings as reported to the UI — deliberately key-free. */
export interface SettingsView extends GlobalSettings {
  /** True when a provider key is stored (in the secrets store or env). */
  hasApiKey: boolean;
  /** True when the OS keychain is actually encrypting the secrets store. */
  isEncrypted: boolean;
}

/** A provider preset offered in the settings UI. */
export interface PresetView {
  id: string;
  label: string;
  kind: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  local?: boolean;
  keyHint: string;
  /** True when this preset signs in rather than taking an API key. */
  subscription?: boolean;
  /**
   * True when this provider already has a stored key or sign-in.
   *
   * Several providers can be configured at once and each agent picks one, so
   * the UI needs to show which are actually usable rather than implying the
   * currently-selected one is the only choice.
   */
  configured?: boolean;
}

export interface PersonaView {
  id: string;
  label: string;
  description: string;
}

/** Result of a provider connectivity check. */
export interface ConnectionTest {
  ok: boolean;
  error?: string;
  latencyMs?: number;
}

/** How the user answered an approval prompt. */
export type ApprovalResolution = 'allow-once' | 'allow-always' | 'deny';

/** Subscription sign-in state, safe to show in the UI (no tokens). */
export interface OAuthStatusView {
  vendor: 'anthropic' | 'chatgpt';
  signedIn: boolean;
  /** e.g. "max", "plus". */
  plan?: string;
  expiresAt?: number;
  /**
   * Quota as of the last request. Absent until the provider has been used
   * at least once — there is no usage endpoint to query up front.
   */
  usage?: UsageView;
}

/** Subscription quota, as far as the provider reports it. */
export interface UsageView {
  tier?: string;
  percentUsed?: number;
  resetsAt?: number;
  limited?: boolean;
  creditsBalance?: number;
  creditsUnlimited?: boolean;
  observedAt: number;
  /** Pre-formatted sentence, so the renderer needs no date logic. */
  summary: string;
}

/** A sign-in an installed CLI already holds, which we could adopt. */
export interface DetectedSignIn {
  vendor: 'anthropic' | 'chatgpt';
  /** Which CLI it came from, e.g. "Claude Code". */
  source: string;
  available: boolean;
  /** Human explanation when `available` is false. */
  detail: string;
  plan?: string;
}

/* ------------------------------------------------------------------ */
/* The bridge                                                          */
/* ------------------------------------------------------------------ */

/**
 * The API exposed on `window.ghostbot`. Every method is asynchronous and
 * rejects with a plain `Error` on failure.
 */
export interface GhostBridge {
  /* -- lifecycle ------------------------------------------------- */

  /**
   * Subscribe to pushed events. Returns an unsubscribe function; callers
   * must invoke it on teardown (React effects do this automatically).
   */
  onEvent(listener: (event: BridgeEvent) => void): () => void;

  /* -- agents ---------------------------------------------------- */

  listAgents(): Promise<AgentRecord[]>;
  createAgent(patch: Partial<AgentRecord>): Promise<AgentRecord>;
  updateAgent(id: string, patch: Partial<AgentRecord>): Promise<AgentRecord>;
  deleteAgent(id: string): Promise<void>;
  /** Copy profile/persona/skills — never conversation history. */
  duplicateAgent(id: string): Promise<AgentRecord>;

  /* -- conversation ---------------------------------------------- */

  getTranscript(agentId: string, limit?: number): Promise<TranscriptEntry[]>;
  /**
   * Queue a user message; streaming replies arrive via `onEvent`.
   * `attachmentPaths` are absolute paths that main reads and classifies —
   * the renderer never loads file contents itself.
   */
  sendPrompt(agentId: string, prompt: string, attachmentPaths?: string[]): Promise<void>;
  /** Native file picker for attachments; returns absolute paths. */
  pickFiles(): Promise<string[]>;
  /** Abort the in-flight turn, leaving a provider-valid history. */
  interrupt(agentId: string): Promise<void>;
  /** Clear history for a fresh start (keeps the agent itself). */
  clearConversation(agentId: string): Promise<void>;
  /**
   * Discard everything after `entryId` and continue from there.
   * `mode: "before"` also drops the named entry — used for "edit and retry",
   * where the user rephrases the message that is being removed.
   */
  rewindConversation(
    agentId: string,
    entryId: string,
    mode?: 'through' | 'before',
  ): Promise<TranscriptEntry[]>;
  /**
   * Copy the conversation up to `entryId` into a new agent and return it.
   * The original is left untouched, so two lines of enquiry can proceed from
   * a shared prefix.
   */
  branchConversation(agentId: string, entryId: string): Promise<AgentRecord>;
  resolveApproval(requestId: string, resolution: ApprovalResolution): Promise<void>;

  /* -- subscription sign-in -------------------------------------- */

  /** Sign-in state per vendor; never includes tokens. */
  listOAuthStatus(): Promise<OAuthStatusView[]>;
  /**
   * Run the browser sign-in for a vendor. Resolves when the user completes
   * it, or rejects with a message explaining what went wrong.
   */
  oauthSignIn(vendor: 'anthropic' | 'chatgpt'): Promise<OAuthStatusView>;
  oauthSignOut(vendor: 'anthropic' | 'chatgpt'): Promise<OAuthStatusView[]>;
  /** Adopt a sign-in an installed CLI already has, without a browser round-trip. */
  oauthImportFromCli(vendor: 'anthropic' | 'chatgpt'): Promise<OAuthStatusView>;
  /** What the CLIs on this machine currently offer, for the UI to suggest. */
  listDetectedCliSignIns(): Promise<DetectedSignIn[]>;

  /* -- standing tool permissions --------------------------------- */

  /** Every "always allow" the user has granted, newest first. */
  listToolGrants(): Promise<ToolGrant[]>;
  revokeToolGrant(agentId: string, toolName: string): Promise<ToolGrant[]>;
  revokeAllToolGrants(): Promise<ToolGrant[]>;

  /* -- settings & providers -------------------------------------- */

  getSettings(): Promise<SettingsView>;
  /** `apiKey`, when present, is routed to the encrypted secrets store. */
  saveSettings(patch: Partial<GlobalSettings> & { apiKey?: string }): Promise<SettingsView>;
  getPresets(): Promise<PresetView[]>;
  getPersonas(): Promise<PersonaView[]>;
  testConnection(cfg: {
    presetId: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }): Promise<ConnectionTest>;

  /* -- MCP ------------------------------------------------------- */

  listMcpServers(): Promise<McpServerStatus[]>;
  addMcpServer(server: McpServerRecord): Promise<McpServerStatus[]>;
  updateMcpServer(name: string, patch: Partial<McpServerRecord>): Promise<McpServerStatus[]>;
  removeMcpServer(name: string): Promise<McpServerStatus[]>;
  setMcpToolEnabled(prefixedTool: string, enabled: boolean): Promise<void>;

  /* -- routines -------------------------------------------------- */

  listRoutines(agentId?: string): Promise<RoutineRecord[]>;
  createRoutine(patch: Partial<RoutineRecord> & { agentId: string }): Promise<RoutineRecord>;
  updateRoutine(id: string, patch: Partial<RoutineRecord>): Promise<RoutineRecord>;
  deleteRoutine(id: string): Promise<void>;
  /** Fire immediately, ignoring the schedule (the "Test run" button). */
  runRoutineNow(id: string): Promise<void>;

  /* -- skills ---------------------------------------------------- */

  listSkills(): Promise<SkillRecord[]>;
  createSkill(patch: Partial<SkillRecord>): Promise<SkillRecord>;
  updateSkill(id: string, patch: Partial<SkillRecord>): Promise<SkillRecord>;
  deleteSkill(id: string): Promise<void>;

  /* -- misc ------------------------------------------------------ */

  /** Native directory picker for choosing a workspace root. */
  pickDirectory(): Promise<string | null>;
  /** Open a path in the OS file manager / default handler. */
  openPath(target: string): Promise<void>;
  getAppInfo(): Promise<{ version: string; platform: string; electron: string }>;

  /* -- nodes ---------------------------------------------------- */

  /**
   * Machines this client has paired with.
   *
   * `connected` reflects a live link, which is the only useful answer: a
   * node that is asleep or on another network is a normal state, and the UI
   * should say so rather than implying it is broken.
   *
   * Tokens are never included — they grant shell access on that machine and
   * stay in the encrypted store, like an API key.
   */
  listNodes(): Promise<NodeSummary[]>;

  /**
   * Pair with a node that is showing a code.
   *
   * `expectFingerprint` is optional but recommended: comparing it against
   * what the node printed is what stops someone intercepting the first
   * connection from pairing you with their machine instead.
   */
  pairNode(address: string, code: string, expectFingerprint?: string): Promise<NodeSummary>;

  /** Forget a node and delete its token. */
  forgetNode(nodeId: string): Promise<NodeSummary[]>;

  /* -- notification channels ------------------------------------ */

  /** Send a real test message, so a wrong chat id is caught at setup. */
  testTelegram(): Promise<{ ok: boolean; error?: string }>;

  /** Read the chat id from a bot the user has already messaged. */
  discoverChatId(): Promise<string | null>;

  /* -- history recovery ----------------------------------------- */

  /**
   * Earlier versions of a conversation, newest first.
   *
   * Kept automatically whenever a write would remove entries: clearing,
   * rewinding, or anything else that shortens the transcript. A conversation
   * that only grows produces none, because nothing was lost.
   */
  listHistory(agentId: string): Promise<HistoryPoint[]>;

  /**
   * Put a saved version back, returning the restored entries.
   *
   * The replaced transcript is itself checkpointed first, so a restore
   * chosen by mistake can be undone the same way.
   */
  restoreHistory(agentId: string, file: string): Promise<TranscriptEntry[]>;
}

/** A recoverable earlier version of a conversation. */
export interface HistoryPoint {
  /** Opaque handle; pass back to `restoreHistory`. */
  file: string;
  createdAt: number;
  entries: number;
  /** What caused it to be kept, e.g. "cleared" or "rewind". */
  reason: string;
}

/** A paired machine, as the UI sees it. */
export interface NodeSummary {
  id: string;
  name: string;
  address: string;
  fingerprint: string;
  pairedAt: number;
  lastSeenAt?: number;
  connected?: boolean;
}

declare global {
  interface Window {
    ghostbot: GhostBridge;
  }
}
