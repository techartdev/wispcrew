/**
 * OpenAI Responses API provider (`POST /v1/responses`).
 *
 * Why this exists as a separate adapter rather than a flag on the
 * chat-completions one:
 *
 * OpenAI's reasoning models (gpt-5.x, o-series) **reject function tools on
 * `/v1/chat/completions`** unless you also send `reasoning_effort: "none"`:
 *
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-luna
 *    in /v1/chat/completions. To use function tools, use /v1/responses or set
 *    reasoning_effort to 'none'."
 *
 * Setting effort to "none" is not a harmless compatibility shim — it turns
 * the reasoning off. Measured on the classic rising-tide ladder puzzle:
 * `reasoning_effort:"none"` answered **7** (wrong), the Responses API with
 * default reasoning answered **10** (right). An agent that runs shell
 * commands on your machine should not be silently downgraded to its weakest
 * mode, so for these models we speak the endpoint they actually want.
 *
 * Chat-completions remains the adapter for everyone else — DeepSeek, Ollama,
 * LM Studio, Groq, OpenRouter and the long tail of OpenAI-compatible servers
 * all speak it, and none of them implement `/v1/responses`.
 *
 * Wire notes (verified against the live API, not the docs):
 *  - Tools are **flat**: `{type:"function", name, description, parameters}` —
 *    not nested under `function` as in chat-completions.
 *  - A tool call comes back as an output item
 *    `{type:"function_call", call_id, name, arguments}` where `arguments` is
 *    a JSON *string*.
 *  - A tool result is sent back as an input item
 *    `{type:"function_call_output", call_id, output}`.
 *  - Streaming deltas arrive as `response.output_text.delta` SSE events.
 */
import type {
  ChatProvider,
  ChatRequest,
  ProviderChunk,
  ProviderConfig,
  ToolCall,
} from '@ghostbot/shared';

/** One item in the `input` array. */
type InputItem = Record<string, unknown>;

interface ResponsesOutputItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponsesBody {
  output?: ResponsesOutputItem[];
  usage?: unknown;
  error?: { message?: string };
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item?: ResponsesOutputItem;
  response?: ResponsesBody;
  error?: { message?: string };
}

export class OpenAIResponsesProvider implements ChatProvider {
  readonly kind = 'openai-compatible' as const;
  readonly label: string;

  constructor(private readonly config: ProviderConfig) {
    this.label = config.label || config.id;
  }

  validate(): { ok: true } | { ok: false; error: string } {
    if (!this.config.apiKey) {
      return { ok: false, error: 'OpenAI needs an API key. Open Settings and paste one to get started.' };
    }
    if (!this.config.model) return { ok: false, error: 'No model is set. Choose one in Settings.' };
    return { ok: true };
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderChunk> {
    const base = (this.config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = `${base}/responses`;
    const useStream = request.stream !== false;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ ...this.toWire(request), stream: useStream }),
      signal: request.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI Responses API returned HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    if (!useStream) {
      const json = (await res.json()) as ResponsesBody;
      yield this.doneFrom(json);
      return;
    }
    yield* this.parseStream(res);
  }

  private toWire(request: ChatRequest): Record<string, unknown> {
    const input: InputItem[] = [];

    for (const m of request.messages) {
      if (m.role === 'system') {
        // Kept as a normal input item; `instructions` is reserved for the
        // caller-level system prompt we pass separately below.
        input.push({ role: 'system', content: m.content });
        continue;
      }

      if (m.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: m.toolCallId,
          output: m.content,
        });
        continue;
      }

      if (m.role === 'assistant' && m.toolCalls?.length) {
        if (m.content) input.push({ role: 'assistant', content: m.content });
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

      // Images travel as `input_image` parts with a data URL.
      const images = (m.attachments ?? []).filter((a) => a.kind === 'image' && a.data);
      if (m.role === 'user' && images.length > 0) {
        input.push({
          role: 'user',
          content: [
            ...(m.content ? [{ type: 'input_text', text: m.content }] : []),
            ...images.map((img) => ({
              type: 'input_image',
              image_url: `data:${img.mimeType};base64,${img.data}`,
            })),
          ],
        });
        continue;
      }

      input.push({ role: m.role, content: m.content });
    }

    return {
      model: this.config.model,
      input,
      ...(request.system ? { instructions: request.system } : {}),
      // Flat tool shape — unlike chat-completions, there is no `function` nesting.
      ...(request.toolDefs?.length
        ? {
            tools: request.toolDefs.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : {}),
      ...(request.maxTokens ? { max_output_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(this.config.extra ?? {}),
    };
  }

  /** Collect text + tool calls from a complete (non-streaming) response. */
  private doneFrom(json: ResponsesBody): ProviderChunk {
    if (json.error?.message) return { kind: 'error', message: json.error.message };

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const item of json.output ?? []) {
      if (item.type === 'function_call') {
        toolCalls.push(this.toolCallFrom(item));
      } else if (item.content) {
        for (const part of item.content) {
          if (part.text) text += part.text;
        }
      }
    }
    return {
      kind: 'done',
      message: {
        role: 'assistant',
        content: text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      usage: { raw: json.usage },
    };
  }

  private toolCallFrom(item: ResponsesOutputItem): ToolCall {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(item.arguments || '{}') as Record<string, unknown>;
    } catch {
      args = {};
    }
    // `call_id` is what a later function_call_output must reference; `id` is
    // the item id and is NOT accepted in its place.
    return { id: String(item.call_id ?? item.id ?? ''), name: String(item.name ?? ''), args };
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
          // Tool calls are only complete (arguments fully accumulated) here.
          if (ev.item?.type === 'function_call') {
            const call = this.toolCallFrom(ev.item);
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
