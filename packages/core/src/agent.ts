/**
 * GhostBot agent core — the provider-agnostic agent loop.
 *
 * Flow per user message:
 *   1. append user message to history
 *   2. call provider with tools; collect text + tool calls
 *   3. if tool calls: approve (policy + user), execute, append results, repeat
 *   4. else: emit final assistant message, done
 */
import {
  type AgentEvent,
  type ApprovalRequest,
  type Attachment,
  type ChatMessage,
  type ChatProvider,
  type ProviderChunk,
  type ToolCall,
  type ToolContext,
  type TokenUsage,
} from '@ghostbot/shared';
import { ToolRegistry } from '@ghostbot/tools';
import { defaultSystemPrompt } from './prompt.js';

export interface AgentOptions {
  provider: ChatProvider;
  tools?: ToolRegistry;
  systemPrompt?: string;
  workspaceRoot?: string;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  defaultTimeoutMs?: number;
  env?: Record<string, string | undefined>;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Approval policy hook. Return true to auto-approve, false to auto-deny,
   * or undefined to ask the user (the default for shell/write).
   */
  approvalPolicy?: (request: ApprovalRequest) => boolean | undefined;
  /** Resolver used to ask the user (UI wires this). Defaults to auto-ask. */
  onApprovalRequired?: (request: ApprovalRequest) => Promise<boolean>;
  /** Abort controller; call agent.abort() to cancel. */
  signal?: AbortSignal;
}

const SAFE_TOOLS = new Set(['read_file', 'list_dir', 'web_fetch', 'web_search']);

export class Agent {
  readonly history: ChatMessage[] = [];
  readonly provider: ChatProvider;
  readonly tools: ToolRegistry;
  readonly workspaceRoot: string;
  private readonly systemPrompt: string;
  private readonly maxSteps: number;
  private readonly maxTokens: number | undefined;
  private readonly temperature: number | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly env: Record<string, string | undefined> | undefined;
  private onEvent: (event: AgentEvent) => void;
  private readonly approvalPolicy: (request: ApprovalRequest) => boolean | undefined;
  private onApprovalRequired: (request: ApprovalRequest) => Promise<boolean>;
  private abortController: AbortController | null = null;
  private turnCounter = 0;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.tools = options.tools ?? new ToolRegistry();
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt({ modelHint: options.provider.label });
    this.maxSteps = options.maxSteps ?? 12;
    this.maxTokens = options.maxTokens;
    this.temperature = options.temperature;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.env = options.env;
    this.onEvent = options.onEvent ?? (() => {});
    this.approvalPolicy = options.approvalPolicy ?? ((req) => (SAFE_TOOLS.has(req.toolName) ? true : undefined));
    this.onApprovalRequired =
      options.onApprovalRequired ??
      (async (req) => {
        // No UI wired: allow only safe tools, deny everything else.
        return SAFE_TOOLS.has(req.toolName);
      });
    if (options.signal) {
      options.signal.addEventListener('abort', () => this.abort(), { once: true });
    }
  }

  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Replace the event sink. Long-lived agents (one per conversation) are
   * reused across turns while the UI stream they feed changes each turn,
   * so the sink must be rebindable after construction.
   */
  setEventSink(onEvent: (event: AgentEvent) => void): void {
    this.onEvent = onEvent;
  }

  /** Replace the approval resolver (rebindable for the same reason). */
  setApprovalResolver(onApprovalRequired: (request: ApprovalRequest) => Promise<boolean>): void {
    this.onApprovalRequired = onApprovalRequired;
  }

  /** Drop all conversation history (New Chat / clear conversation). */
  resetHistory(): void {
    this.history.length = 0;
  }

  /**
   * Run a full agent turn for the user message. Returns the assistant's
   * final answer message (or the last message if the loop ended early).
   *
   * `attachments` are carried on the user message so providers that support
   * vision can send images as structured content. They are attached only to
   * this turn's message; later turns see the same history without re-sending
   * the image payload.
   */
  async run(userMessage: string, attachments?: Attachment[]): Promise<ChatMessage> {
    this.history.push({
      role: 'user',
      content: userMessage,
      ...(attachments?.length ? { attachments } : {}),
    });
    const turnId = `turn_${++this.turnCounter}`;
    const controller = new AbortController();
    this.abortController = controller;

    let lastMessage: ChatMessage = { role: 'assistant', content: '' };

    try {
      for (let step = 0; step < this.maxSteps; step++) {
        this.onEvent({ type: 'turn_start', turnId, step });

        const request = {
          system: this.systemPrompt,
          messages: this.history,
          toolDefs: this.tools.definitions(),
          maxTokens: this.maxTokens,
          temperature: this.temperature,
          stream: true,
          signal: controller.signal,
        };

        let text = '';
        const toolCalls: ChatMessage['toolCalls'] = [];
        let usage: TokenUsage | undefined;

        try {
          for await (const chunk of this.provider.chat(request)) {
            this.handleChunk(chunk, (e) => {
              this.onEvent(e);
            });
            switch (chunk.kind) {
              case 'text':
                text += chunk.text;
                break;
              case 'tool_call':
                toolCalls.push(chunk.call);
                break;
              case 'done':
                usage = chunk.usage;
                // Some providers only deliver the final content on the done
                // chunk (no text deltas); fall back to it when nothing streamed.
                if (!text && chunk.message.content) {
                  text = chunk.message.content;
                  this.onEvent({ type: 'delta', text });
                }
                if (chunk.message.toolCalls?.length) {
                  for (const tc of chunk.message.toolCalls) {
                    if (!toolCalls.some((c) => c.id === tc.id)) toolCalls.push(tc);
                  }
                }
                break;
              case 'error':
                throw new Error(chunk.message);
            }
          }
        } catch (err) {
          if (controller.signal.aborted) {
            // Keep whatever the model produced before the interrupt so the
            // conversation the model sees matches what the UI displayed.
            // No tool results are owed here: the assistant message carrying
            // the calls has not been pushed to history yet.
            if (text) this.history.push({ role: 'assistant', content: text });
            this.onEvent({ type: 'error', message: 'Turn aborted by user.', fatal: false });
            return { role: 'assistant', content: text || '(aborted)' };
          }
          throw err;
        }

        lastMessage = { role: 'assistant', content: text, toolCalls: toolCalls.length ? toolCalls : undefined };
        this.onEvent({ type: 'model_message', message: lastMessage });

        if (!toolCalls.length) {
          this.history.push(lastMessage);
          this.onEvent({ type: 'turn_end', turnId, usage });
          return lastMessage;
        }

        // Execute tool calls
        this.history.push(lastMessage);
        const toolCtx: ToolContext = {
          workspaceRoot: this.workspaceRoot,
          defaultTimeoutMs: this.defaultTimeoutMs,
          env: this.env,
          requestApproval: async (req) => {
            const policy = this.approvalPolicy(req);
            if (policy !== undefined) return policy;
            const requestId = `req_${Math.random().toString(36).slice(2)}`;
            this.onEvent({ type: 'approval_required', call: { id: '', name: req.toolName, args: {} }, summary: req.summary, requestId });
            const approved = await this.onApprovalRequired(req);
            this.onEvent({ type: 'approval_resolved', requestId, approved });
            return approved;
          },
        };

        let aborted = false;
        for (const call of toolCalls) {
          if (controller.signal.aborted) {
            aborted = true;
            break;
          }
          this.onEvent({ type: 'tool_call_start', call });
          const result = await this.tools.execute(call.name, call.args, toolCtx);
          result.id = call.id;
          result.name = call.name;
          this.onEvent({ type: 'tool_call_result', result });
          this.history.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
          });
        }

        if (aborted) {
          // The assistant message carrying these tool calls is already in
          // history. Providers reject a conversation where a tool call has
          // no matching tool result, so synthesize results for the calls we
          // skipped before returning; otherwise the next turn would fail.
          this.settleUnansweredToolCalls(toolCalls);
          this.onEvent({ type: 'error', message: 'Turn aborted by user.', fatal: false });
          return { role: 'assistant', content: text || '(aborted)' };
        }
      }

      const last = this.history.at(-1);
      const message: ChatMessage = last?.role === 'assistant'
        ? last
        : { role: 'assistant', content: 'Reached the maximum number of tool steps without a final answer.' };
      this.onEvent({ type: 'turn_end', turnId });
      return message;
    } catch (err) {
      const message = (err as Error).message;
      this.onEvent({ type: 'error', message, fatal: true });
      throw err;
    } finally {
      this.abortController = null;
    }
  }

  private handleChunk(chunk: ProviderChunk, emit: (e: AgentEvent) => void): void {
    if (chunk.kind === 'text') emit({ type: 'delta', text: chunk.text });
  }

  /**
   * Append synthetic tool results for any of `toolCalls` that have no
   * matching `role:"tool"` message in history.
   *
   * Chat APIs require every assistant tool call to be answered by a tool
   * message with the same id; an interrupted turn would otherwise leave the
   * conversation permanently unusable for subsequent requests.
   */
  private settleUnansweredToolCalls(toolCalls: ToolCall[]): void {
    const answered = new Set(
      this.history.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string),
    );
    for (const call of toolCalls) {
      if (answered.has(call.id)) continue;
      this.history.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: 'Tool call cancelled: the user interrupted this turn.',
      });
    }
  }
}
