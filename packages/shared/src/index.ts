/**
 * GhostBot — shared protocol types.
 *
 * These types define the contract between the LLM provider layer, the agent
 * core, the tool registry, and the UI. They are intentionally provider-agnostic:
 * providers translate to/from their own wire formats.
 */

/** Role of a message participant. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A tool-call request emitted by the model. */
export interface ToolCall {
  /** Stable id of this call within the turn (echoed in the tool result). */
  id: string;
  /** Tool name, e.g. "shell", "read_file". */
  name: string;
  /** JSON-serializable arguments object. */
  args: Record<string, unknown>;
}

/** Result of executing a tool call. */
export interface ToolResult {
  /** Matches the originating ToolCall.id. */
  id: string;
  name: string;
  ok: boolean;
  /** Short machine-readable error code when !ok (e.g. "timeout", "denied"). */
  errorCode?: string;
  /** Text payload for the model. */
  content: string;
  /** Optional structured payload (e.g. file list) for the UI. */
  data?: unknown;
  /** Approximate cost/meta info, if the tool tracks it. */
  meta?: Record<string, unknown>;
}

/**
 * A file the user attached to a message.
 *
 * Images are sent to the model as vision content when the provider supports
 * it; text-like files are inlined into the prompt. Binary formats we cannot
 * interpret are described by name and size only, so the model knows the file
 * exists without being fed megabytes of noise.
 */
export interface Attachment {
  /** Display name (the original basename). */
  name: string;
  /** MIME type, best-effort from the extension. */
  mimeType: string;
  /** Size in bytes of the original file. */
  size: number;
  /** How the content should be presented to the model. */
  kind: 'image' | 'text' | 'binary';
  /** For `image`: base64 (no data: prefix). For `text`: the decoded text. */
  data?: string;
  /** Absolute source path, when it came from disk (never sent to the model). */
  path?: string;
}

/** A chat message in the agent loop. */
export interface ChatMessage {
  role: MessageRole;
  /** For role "tool", the id of the tool call being answered. */
  toolCallId?: string;
  /** For role "tool", the tool name. */
  toolName?: string;
  content: string;
  /** Tool calls made by the assistant at this step. */
  toolCalls?: ToolCall[];
  /** Optional display name / sender for the UI. */
  name?: string;
  /** Files attached to a user message. */
  attachments?: Attachment[];
}

/** Streamed events emitted by the agent loop for the UI / CLI. */
export type AgentEvent =
  | { type: 'turn_start'; turnId: string; step: number }
  | { type: 'model_message'; message: ChatMessage }
  | { type: 'tool_call_start'; call: ToolCall }
  | { type: 'tool_call_result'; result: ToolResult }
  | { type: 'approval_required'; call: ToolCall; summary: string; requestId: string }
  | { type: 'approval_resolved'; requestId: string; approved: boolean }
  | { type: 'delta'; text: string }
  | { type: 'turn_end'; turnId: string; usage?: TokenUsage }
  | { type: 'error'; message: string; fatal: boolean };

/** Token/usage accounting, normalized across providers. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Optional monetary cost estimate in USD. */
  costUsd?: number;
  raw?: unknown;
}

/* ------------------------------------------------------------------ */
/* Provider layer                                                      */
/* ------------------------------------------------------------------ */

/**
 * Kind of chat API a provider speaks.
 *
 * `chatgpt-subscription` is its own kind rather than a flag on
 * `openai-compatible`: it targets a different host with a different request
 * shape and a different credential type, and sending one to the other's
 * endpoint fails with an unhelpful error.
 */
export type ProviderKind = 'openai-compatible' | 'anthropic' | 'chatgpt-subscription';

/**
 * A model chat request in provider-neutral form.
 * `toolDefs` are JSON-Schema-like tool descriptors (see ToolDefinition).
 */
export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  toolDefs?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /** Passed through to providers that support it. */
  stream?: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/** A single streamed chunk or complete result from the provider. */
export type ProviderChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'tool_call_done'; id: string }
  | { kind: 'done'; message: ChatMessage; usage?: TokenUsage }
  | { kind: 'error'; message: string };

/** What a provider must implement. */
export interface ChatProvider {
  readonly kind: ProviderKind;
  /** Human-readable provider name for the UI. */
  readonly label: string;
  /** Send a chat request; yields chunks (streaming or a single done chunk). */
  chat(request: ChatRequest): AsyncIterable<ProviderChunk>;
  /** Validate that config is usable (e.g. key present). */
  validate(): { ok: true } | { ok: false; error: string };
}

/** Static configuration for a provider instance. */
export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Base URL of the API (e.g. https://api.deepseek.com). */
  baseUrl: string;
  /** API key; may be empty for local endpoints (Ollama). */
  apiKey?: string;
  /** Model id, e.g. deepseek-chat, gpt-4o, claude-sonnet-4-5, llama3.2. */
  model: string;
  /** Extra per-request options the user may override. */
  extra?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/** JSON-Schema subset used for tool parameters. */
export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  additionalProperties?: boolean;
  [k: string]: unknown;
}

/** Tool descriptor handed to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** Runtime context available to a tool execution. */
export interface ToolContext {
  /** Resolve an approval request; throws or returns false when denied. */
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  /** Root directory the agent is allowed to touch ("" = cwd). */
  workspaceRoot: string;
  /** Timeout in ms applied by tools that support it. */
  defaultTimeoutMs: number;
  /** Extra per-tool options from the agent config. */
  env?: Record<string, string | undefined>;
}

export interface ApprovalRequest {
  toolName: string;
  summary: string;
  detail?: string;
  /** Optional structured payload for a richer UI prompt. */
  payload?: Record<string, unknown>;
}

/** A tool implementation. */
export interface Tool<Args extends object = Record<string, unknown>> {
  definition: ToolDefinition;
  run(args: Args, ctx: ToolContext): Promise<ToolResult>;
}

/* ------------------------------------------------------------------ */
/* Durable domain + UI bridge                                          */
/* ------------------------------------------------------------------ */

export * from './domain.js';
export * from './bridge.js';
