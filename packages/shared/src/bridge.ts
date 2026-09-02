/**
 * WispCrew — the renderer ⇄ main IPC contract.
 *
 * This is the entire surface the desktop UI may use. It replaces the
 * reverse-engineered protocol shim with a small, explicit API that we own.
 *
 * Design rules, learned the hard way:
 *  1. **One typed interface, no string channels in UI code.** The preload
 *     exposes exactly `WispBridge`; the renderer never calls `ipcRenderer`
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
import type { ConversationRecord, RoomMode } from './conversation.js';

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
  /**
   * A room changed: renamed, re-moded, a member added or removed, or its
   * greeting edited.
   *
   * Its own event rather than another `agents-changed`. Renaming a room
   * borrowed that one and it worked, because the client re-reads the room
   * list whenever the roster changes — but a room is not an agent, and
   * riding on that coincidence meant every OTHER room change announced
   * nothing at all. Changing the mode, adding a member or editing the
   * greeting from the CLI left an open window showing the old room until it
   * was reloaded.
   */
  | { type: 'rooms-changed'; conversations: ConversationRecord[] }
  /** MCP server connection states changed. */
  | { type: 'mcp-changed'; servers: McpServerStatus[] }
  /** A routine started or finished. */
  | { type: 'routines-changed'; routines: RoutineRecord[] }
  | { type: 'skills-changed'; skills: SkillRecord[] }
  /** Standing tool permissions changed (granted, revoked, agent deleted). */
  | { type: 'grants-changed'; grants: ToolGrant[] }
  /** A subscription sign-in was added, refreshed or removed. */
  | { type: 'oauth-changed'; statuses: OAuthStatusView[] }
  /** Non-fatal problem worth surfacing in the UI. */
  | { type: 'notice'; level: 'info' | 'error'; text: string };

/* ------------------------------------------------------------------ */
/* Supporting shapes                                                   */
/* ------------------------------------------------------------------ */

/**
 * How full a conversation's context is, as the UI sees it.
 *
 * Declared here rather than imported from the runtime because the renderer
 * is sandboxed and may only depend on `shared`.
 */
export interface ContextReportView {
  conversationId: string;
  /** Tokens the next request would carry. */
  used: number;
  /** True when `used` is the provider's own figure, not an estimate. */
  measured: boolean;
  /** The model's context window, when this build knows it. */
  limit?: number;
  /** Fraction used, 0–1. Absent when the limit is unknown. */
  fraction?: number;
  /* Always estimated: a provider reports one total, never a breakdown. */
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
  /** Whose prompt was measured — a group has one per member. */
  agentId?: string;
  agentName?: string;
  model?: string;
}

/** What compaction did, or why it did nothing. */
export interface CompactionResultView {
  ok: boolean;
  reason?: string;
  replaced?: number;
  kept?: number;
}

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
 * The API exposed on `window.wispcrew`. Every method is asynchronous and
 * rejects with a plain `Error` on failure.
 */
export interface WispBridge {
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

  /**
   * Give a paired node its own provider settings and key.
   *
   * A node holds only the credentials it was given — keys are never copied
   * between machines — so each one is configured directly. The key travels
   * over that node's pinned TLS link and is encrypted there with its own
   * machine-local key file; this machine never stores it.
   *
   * Without this a remote agent had no way to reach a model, which made
   * remote agents look supported and be unusable.
   */
  configureNode(
    nodeId: string,
    settings: { presetId?: string; model?: string; baseUrl?: string; apiKey?: string },
  ): Promise<{ ok: boolean; error?: string }>;

  /**
   * Which providers a paired machine can actually use.
   *
   * `getPresets` answers for whichever engine receives it, so an agent that
   * lives elsewhere was offered THIS machine's providers — a ChatGPT
   * subscription model could be chosen for a VPS holding only Ollama and an
   * NVIDIA key. Valid-looking, saveable, and unusable.
   *
   * Returns `null` when that machine is unreachable, so a caller can say so
   * rather than quietly falling back to the wrong list.
   */
  presetsForNode(nodeId: string): Promise<PresetView[] | null>;

  /**
   * Every model a provider reports, not only the ones this project curated.
   *
   * The preset lists six chosen by testing; NVIDIA offers 84. Hiding the
   * rest meant a key paid for models the interface would not show, and a
   * curated list goes stale invisibly — the NVIDIA default was retired
   * mid-project.
   *
   * `tested` marks the ones actually seen calling a tool here, which is what
   * matters for an agent.
   */
  listProviderModels(
    presetId: string,
    options?: { refresh?: boolean },
  ): Promise<{ id: string; tested: boolean }[]>;

  /** Forget a node and delete its token. */
  forgetNode(nodeId: string): Promise<NodeSummary[]>;

  /* -- rooms ----------------------------------------------------- */

  /** Every conversation, newest first. */
  listConversations(): Promise<ConversationRecord[]>;

  /** Add an agent to a room. Records who did it. */
  addRoomAgent(conversationId: string, agentId: string): Promise<ConversationRecord | undefined>;

  /** Remove a participant. Their data stays where it is. */
  removeRoomParticipant(
    conversationId: string,
    participantId: string,
  ): Promise<ConversationRecord | undefined>;

  /** How much the room constrains who may speak. */
  /**
   * Give a room its own name.
   *
   * A conversation with several agents is a place, and a place with no name
   * can only be described by whoever happens to be listed first — "Nudge"
   * for a room that is really the deploy review.
   */
  renameConversation(conversationId: string, title: string): Promise<ConversationRecord>;
  setRoomMode(conversationId: string, mode: RoomMode): Promise<ConversationRecord | undefined>;

  /**
   * Set the room's standing instructions — its tone, purpose and cast.
   *
   * Visible to every member and to the user; see `ConversationRecord.greeting`.
   * An empty string clears it.
   */
  setRoomGreeting(
    conversationId: string,
    greeting: string,
  ): Promise<ConversationRecord | undefined>;

  /**
   * Create a room that belongs to nobody, with at least two agents in it.
   *
   * No model and no provider: agents arrive configured, and a room that
   * could reconfigure them would make the same agent answer differently
   * depending on where it was spoken to.
   */
  createRoom(patch: {
    title: string;
    agentIds: string[];
    greeting?: string;
    /**
     * Copy this conversation's history in, so a joining agent can see where
     * things stand. The source is untouched.
     */
    fromConversationId?: string;
  }): Promise<ConversationRecord>;

  /**
   * Delete a room and its transcript.
   *
   * Groups only. A one-to-one chat goes with its agent and has no separate
   * existence to remove — offering it there would be a second, confusing
   * way to do what deleting the agent already does.
   *
   * Needed because a group now survives its founder: without this, deleting
   * every member left a room nobody could remove and nothing could answer.
   */
  deleteRoom(conversationId: string): Promise<ConversationRecord[]>;

  /**
   * How full this conversation's context is.
   *
   * Measured against what a turn would ACTUALLY send — the same system
   * prompt, the same tool definitions, and the history as rebuilt for the
   * model rather than as displayed. Prefers the provider's own reported
   * input tokens over the estimate once a turn has run; `measured` says
   * which, because an estimate presented as a measurement will eventually
   * be trusted for a decision it cannot carry.
   */
  getContextReport(conversationId: string): Promise<ContextReportView>;

  /**
   * Replace the older turns with a summary the agent writes itself.
   *
   * Recent turns are kept exactly as they are. A checkpoint is written
   * first, so History restores the full version — compaction is a
   * destructive edit to somebody's conversation and must never be the
   * only copy.
   *
   * Returns a reason rather than throwing when there is nothing to do:
   * `too short to compact` is an answer, and somebody who pressed the
   * button deserves to be told which it was.
   */
  compactConversation(conversationId: string): Promise<CompactionResultView>;

  /**
   * Send a message to a ROOM rather than an agent.
   *
   * Who acts is decided by the floor rules: tagged agents speak, `@all`
   * reaches everyone, and an untagged message continues with whoever you
   * last addressed.
   */
  sendToRoom(conversationId: string, text: string, attachmentPaths?: string[]): Promise<void>;

  /* -- notification channels ------------------------------------------ */

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
    wispcrew: WispBridge;
  }
}
