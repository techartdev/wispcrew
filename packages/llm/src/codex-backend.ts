/**
 * codex-backend.ts — OpenAI models through a ChatGPT subscription.
 *
 * Codex CLI does not call `api.openai.com` when signed in with ChatGPT. It
 * calls a separate backend that bills against the subscription instead of
 * API credits. This adapter speaks that endpoint.
 *
 * ## What was established by probing, not documentation
 *
 * None of this is documented for third-party use, so every detail below was
 * determined by experiment against the live service:
 *
 *  - **`api.openai.com/v1/responses` rejects the token with 401.** A ChatGPT
 *    access token is not an API key and the public API will not take it. The
 *    subscription endpoint is `chatgpt.com/backend-api/codex/responses`.
 *  - **`instructions` and `store: false` are required.** Omitting either
 *    yields a bare HTTP 400 with an empty body — no error message at all, so
 *    the failure is silent and extremely hard to diagnose. They are always
 *    sent.
 *  - **`chatgpt-account-id` must accompany the token.** It is carried in the
 *    credentials file and also inside the token's own claims.
 *  - **Input must be structured** (`{type:'message', role, content:[{type:
 *    'input_text', text}]}`); a plain string is rejected.
 *
 * Verified working: a streamed turn returned real model output using only a
 * ChatGPT Plus sign-in.
 *
 * ## Read this before enabling it
 *
 * OpenAI documents "Sign in with ChatGPT" for its *own* surfaces — the
 * ChatGPT app, Codex CLI, IDE extensions. Whether a third-party application
 * may bill inference against a user's subscription this way is **not**
 * documented, and this endpoint is private and unversioned: it can change or
 * start refusing unfamiliar clients at any time. An API key remains the
 * supported path, and this is opt-in.
 */
import type {
  ChatProvider,
  ChatRequest,
  ProviderChunk,
  ProviderConfig,
  ToolCall,
} from '@ghostbot/shared';
import { usageFromCodexHeaders, type UsageSnapshot } from './usage-limits.js';

/** The subscription-billed endpoint Codex CLI uses. */
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

/** Sent so the backend sees a recognisable client rather than an unknown one. */
const CODEX_HEADERS: Record<string, string> = {
  'OpenAI-Beta': 'responses=experimental',
  originator: 'codex_cli_rs',
};

/**
 * A fallback system prompt.
 *
 * `instructions` is mandatory — omitting it produces an empty HTTP 400 — so
 * a request that carries no system prompt still needs something here.
 */
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

export interface CodexConfig extends ProviderConfig {
  /** The ChatGPT account id that accompanies the token. */
  accountId?: string;
  /**
   * Called with the quota reported by each response.
   *
   * There is no usage endpoint — the headers of a real request are the only
   * source — so usage is observed as a side effect of using the provider.
   */
  onUsage?: (usage: UsageSnapshot) => void;
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: { usage?: unknown; error?: { message?: string } };
  error?: { message?: string };
}

export class CodexSubscriptionProvider implements ChatProvider {
  readonly kind = 'openai-compatible' as const;
  readonly label: string;

  constructor(private readonly config: CodexConfig) {
    this.label = config.label || 'ChatGPT subscription';
  }

  validate(): { ok: true } | { ok: false; error: string } {
    if (!this.config.apiKey) {
      return {
        ok: false,
        error: 'Not signed in to ChatGPT. Open Settings to sign in, or use an API key.',
      };
    }
    if (!this.config.accountId) {
      return {
        ok: false,
        error: 'The ChatGPT sign-in is missing its account id — sign in again.',
      };
    }
    if (!this.config.model) return { ok: false, error: 'No model is set. Choose one in Settings.' };
    return { ok: true };
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderChunk> {
    const res = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        'chatgpt-account-id': this.config.accountId ?? '',
        ...CODEX_HEADERS,
      },
      body: JSON.stringify(this.toWire(request)),
      signal: request.signal,
    });

    // Quota headers ride on both success and failure, so read them before
    // any early return — a 429 is exactly when the user needs to know.
    const usage = usageFromCodexHeaders(res.headers);
    if (usage) this.config.onUsage?.(usage);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // This backend returns an empty body on 400, so a bare status would be
      // useless. Name the likely cause instead.
      const detail =
        text.trim() ||
        (res.status === 400
          ? 'the request shape was rejected (this private endpoint can change without notice)'
          : res.status === 401
            ? 'the ChatGPT sign-in was rejected — sign in again'
            : res.status === 429
              ? 'your ChatGPT plan is rate-limited right now'
              : 'no detail provided');
      throw new Error(`ChatGPT subscription endpoint returned HTTP ${res.status}: ${detail}`);
    }

    yield* this.parseStream(res);
  }

  private toWire(request: ChatRequest): Record<string, unknown> {
    // The system prompt becomes `instructions`; any system messages in the
    // history are folded in, since this endpoint has no system role.
    const systemParts: string[] = [];
    if (request.system) systemParts.push(request.system);

    const input: Array<Record<string, unknown>> = [];

    for (const m of request.messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
        continue;
      }
      if (m.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        if (m.content) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: m.content }],
          });
        }
        for (const tc of m.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.args ?? {}),
          });
        }
        continue;
      }

      const isUser = m.role === 'user';
      const textType = isUser ? 'input_text' : 'output_text';
      const images = (m.attachments ?? []).filter((a) => a.kind === 'image' && a.data);
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: textType, text: m.content });
      if (isUser) {
        for (const img of images) {
          content.push({ type: 'input_image', image_url: `data:${img.mimeType};base64,${img.data}` });
        }
      }
      if (content.length === 0) continue;
      input.push({ type: 'message', role: m.role, content });
    }

    return {
      model: this.config.model,
      // Both of these are mandatory; without them the backend answers 400
      // with an empty body.
      instructions: systemParts.join('\n\n') || DEFAULT_INSTRUCTIONS,
      store: false,
      input,
      stream: true,
      ...(request.toolDefs?.length
        ? {
            tools: request.toolDefs.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
            tool_choice: 'auto',
          }
        : {}),
      ...(this.config.extra ?? {}),
    };
  }

  private async *parseStream(res: Response): AsyncIterable<ProviderChunk> {
    if (!res.body) throw new Error('response has no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const toolCalls: ToolCall[] = [];
    let usage: unknown;

    const handle = (payload: string): ProviderChunk[] => {
      const out: ProviderChunk[] = [];
      if (payload === '[DONE]') return out;
      let ev: ResponsesEvent;
      try {
        ev = JSON.parse(payload) as ResponsesEvent;
      } catch {
        return out;
      }
      if (ev.error?.message) {
        out.push({ kind: 'error', message: ev.error.message });
        return out;
      }

      switch (ev.type) {
        case 'response.output_text.delta':
          if (ev.delta) {
            text += ev.delta;
            out.push({ kind: 'text', text: ev.delta });
          }
          break;
        case 'response.output_item.done':
          if (ev.item?.type === 'function_call') {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(ev.item.arguments || '{}') as Record<string, unknown>;
            } catch {
              args = {};
            }
            const call: ToolCall = {
              id: String(ev.item.call_id ?? ev.item.id ?? ''),
              name: String(ev.item.name ?? ''),
              args,
            };
            toolCalls.push(call);
            out.push({ kind: 'tool_call', call });
            out.push({ kind: 'tool_call_done', id: call.id });
          }
          break;
        case 'response.completed':
          usage = ev.response?.usage;
          break;
        case 'response.failed':
        case 'error':
          out.push({ kind: 'error', message: ev.response?.error?.message ?? 'response failed' });
          break;
        default:
          break;
      }
      return out;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        for (const chunk of handle(line.slice(5).trim())) yield chunk;
      }
    }
    if (buffer.startsWith('data:')) {
      for (const chunk of handle(buffer.slice(5).trim())) yield chunk;
    }

    yield {
      kind: 'done',
      message: {
        role: 'assistant',
        content: text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      usage: { raw: usage },
    };
  }
}
