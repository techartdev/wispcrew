/**
 * GhostBot — durable domain types.
 *
 * These describe the things a user creates and keeps: named agents, their
 * conversations, scheduled routines, and reusable skills. They are storage
 * and transport types, deliberately free of any UI framework or Electron
 * dependency so the desktop app, the CLI, and any future frontend share one
 * vocabulary.
 *
 * Design notes:
 *  - Every durable record carries a stable `id` plus `createdAt`/`updatedAt`
 *    epoch millis, so persistence layers can sort and merge without guessing.
 *  - Nothing here embeds a secret. API keys live only in the secrets store;
 *    an agent references a provider by preset id and resolves the key at run
 *    time.
 *  - Records are intentionally plain JSON: they round-trip through a settings
 *    file, an IPC boundary, or an export without custom serializers.
 */

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

/**
 * A durable, named agent ("teammate") the user creates and returns to.
 *
 * This is the unit of identity in the UI: it owns a conversation, a persona,
 * a workspace, and its own tool permissions. Unlike a disposable chat, an
 * agent persists across restarts and keeps its history.
 */
export interface AgentRecord {
  id: string;
  /** User-facing name, e.g. "Refactor Bot". */
  name: string;
  /**
   * Durable behavioural instructions — the agent's system prompt. Distinct
   * from a single message: this applies to every turn.
   */
  description?: string;
  /** Built-in persona id applied when `description` is empty. */
  persona?: string;
  /** Deterministic avatar styling derived from the id when unset. */
  avatarShape?: string;
  avatarColor?: string;
  /** Provider preset id (e.g. "openai"); the key is resolved separately. */
  presetId?: string;
  /** Model override; falls back to the preset default. */
  model?: string;
  /**
   * Endpoint override for this agent.
   *
   * Only meaningful for a self-hosted or proxied endpoint. When unset, the
   * agent uses its preset's own host — deliberately *not* the global Base
   * URL, which belongs to whichever preset it was entered for.
   */
  baseUrl?: string;
  /**
   * Which machine runs this agent.
   *
   * Unset means the local engine, which is what every existing agent gets
   * and what a user who never pairs anything keeps. A node id points at a
   * paired machine, so the agent's turns, tools and files all happen there.
   *
   * This is the agent's *home*, not a routing hint: its transcript lives on
   * that node, and moving an agent between nodes is an explicit export, not
   * a live handoff. Two engines writing one profile lose data, so an agent
   * belongs to exactly one.
   */
  nodeId?: string;
  /**
   * Channels this agent may use, overriding the global default.
   *
   * Undefined means "whatever the user enabled globally". An empty array
   * means this agent stays silent — a legitimate choice for one that only
   * ever runs while being watched.
   */
  channels?: ChannelId[];
  /** Directory this agent's file/shell tools are confined to. */
  workspaceRoot?: string;
  /** Per-agent tool policy; falls back to the global default. */
  approvalPolicy?: ApprovalPolicy;
  /** Tool names this agent may not use at all. */
  disabledTools?: string[];
  /** Sort/display state. */
  pinned?: boolean;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * How tool calls are gated for an agent.
 *
 * `ask` is the safe default: read-only tools run freely, anything that writes
 * or executes requires explicit user approval. `auto` should be opt-in per
 * agent — it lets the model run shell commands unattended.
 */
export type ApprovalPolicy = 'ask' | 'auto' | 'readonly';

/* ------------------------------------------------------------------ */
/* Transcript                                                          */
/* ------------------------------------------------------------------ */

/**
 * One rendered item in an agent's conversation.
 *
 * This is the UI's view of history, which is deliberately richer than the
 * `ChatMessage[]` the model sees: it includes tool cards, notices, and
 * approval prompts that never go to the provider.
 */
export type TranscriptEntry =
  | {
      kind: 'message';
      id: string;
      role: 'user' | 'assistant';
      content: string;
      /** True while tokens are still streaming into this entry. */
      isStreaming?: boolean;
      createdAt: number;
      /** Populated on assistant entries once the turn reports usage. */
      usage?: import('./index.js').TokenUsage;
      /**
       * Files attached to a user message, for display. Image `data` is
       * stripped before storage — the transcript keeps names and metadata,
       * not megabytes of base64.
       */
      attachments?: Array<{
        name: string;
        mimeType: string;
        size: number;
        kind: 'image' | 'text' | 'binary';
      }>;
    }
  | {
      kind: 'tool-call';
      id: string;
      toolName: string;
      args?: Record<string, unknown>;
      status: 'running' | 'completed' | 'failed' | 'denied';
      /** Truncated result text for display. */
      content?: string;
      createdAt: number;
    }
  | {
      kind: 'approval';
      id: string;
      requestId: string;
      toolName: string;
      summary: string;
      detail?: string;
      status: 'pending' | 'approved' | 'denied';
      createdAt: number;
    }
  | {
      kind: 'notice';
      id: string;
      /** `error` renders prominently; `info` is muted. */
      level: 'info' | 'error';
      text: string;
      createdAt: number;
    };

/** Run state of an agent, surfaced as a status dot in the roster. */
export type AgentRunState = 'idle' | 'thinking' | 'awaiting-approval' | 'error';

/* ------------------------------------------------------------------ */
/* Routines (scheduled + triggered automation)                         */
/* ------------------------------------------------------------------ */

/**
 * A recurring task owned by one agent.
 *
 * Routines are how an agent does useful work without a human present. The
 * schedule is a 5-field cron expression evaluated in `timezone`; `prompt` is
 * delivered as if the user had typed it.
 */
export interface RoutineRecord {
  id: string;
  agentId: string;
  name: string;
  /** 5-field cron: minute hour day-of-month month day-of-week. */
  cron: string;
  /** IANA timezone, e.g. "Europe/Sofia". Defaults to the system zone. */
  timezone?: string;
  /**
   * A single wake-up at this moment, instead of a recurring schedule.
   *
   * Set for a follow-up an agent scheduled for itself ("check the build
   * in ten minutes"). Encoding that as a cron expression matching one
   * minute would be a lie the scheduler could not detect — it would match
   * again next year — so it is explicit, and the scheduler disables the
   * routine once it has run.
   */
  runAt?: number;
  /** True when the agent asked for this itself, for the UI to distinguish. */
  selfScheduled?: boolean;
  /** The message handed to the agent when the routine fires. */
  prompt: string;
  enabled: boolean;
  /** Bounded history of recent executions (most recent first). */
  runs?: RoutineRun[];
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'ok' | 'error' | 'skipped';
  /** Short summary or error message for the run list. */
  summary?: string;
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

/**
 * A reusable, named instruction set the user can invoke with `/name`.
 *
 * Skills are plain Markdown so they are trivially editable, diffable, and
 * shareable — no proprietary format. When invoked, the body is prepended to
 * the turn as additional guidance.
 */
export interface SkillRecord {
  id: string;
  /** Invocation token (no spaces), e.g. "changelog". */
  name: string;
  description?: string;
  /** Markdown body injected when the skill is used. */
  body: string;
  /** Agent ids allowed to use it; empty/undefined = all agents. */
  agentIds?: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

/** A configured MCP stdio server (mirrors the desktop settings shape). */
export interface McpServerRecord {
  name: string;
  label?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

/** Live connection state reported to the UI. */
export interface McpServerStatus {
  name: string;
  label: string;
  state: 'connected' | 'error' | 'disabled';
  toolNames: string[];
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Tool grants                                                         */
/* ------------------------------------------------------------------ */

/**
 * A standing "always allow" permission for one agent + one tool.
 *
 * Persisted so the decision survives a restart, and surfaced in Settings so
 * the user can see and revoke it — a permission that cannot be reviewed is
 * worse than one that is asked for every time.
 */
export interface ToolGrant {
  agentId: string;
  toolName: string;
  /** Epoch ms, shown in the UI so a stale grant is recognisable. */
  grantedAt: number;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/** Global application settings (per-agent overrides win where present). */
/**
 * Where agents may reach the user, and how.
 *
 * An agent that works unattended is only useful if it can say so. `app` is
 * always available and needs no configuration; the others are opt-in,
 * because one raises OS notifications and the other sends a message off the
 * machine entirely.
 */
export interface ChannelSettings {
  /** Channels enabled by default for every agent. */
  enabled?: ChannelId[];
  telegram?: {
    /** True once a bot token is stored. The token itself lives encrypted. */
    configured?: boolean;
    /** The user's own chat with their bot. */
    chatId?: string;
  };
}

/** Somewhere a message can be delivered. */
export type ChannelId = 'app' | 'desktop' | 'telegram';

export interface GlobalSettings {
  presetId?: string;
  model?: string;
  baseUrl?: string;
  /** Delivery channels available to agents. */
  channels?: ChannelSettings;
  /** Default persona for newly created agents. */
  persona?: string;
  workspaceRoot?: string;
  approvalPolicy?: ApprovalPolicy;
  theme?: 'system' | 'light' | 'dark';
  mcpServers?: McpServerRecord[];
  /** Prefixed tool names (`<server>__<tool>`) switched off by the user. */
  mcpDisabledTools?: string[];
  /** Set once the first-run setup has been completed. */
  onboarded?: boolean;
}
