/**
 * OpenAI-compatible chat provider (DeepSeek, OpenAI, Ollama, LM Studio,
 * Groq, OpenRouter, Together, vLLM, ... anything that speaks
 * POST /chat/completions with function/tool calling).
 */
import type {
  ChatProvider,
  ChatRequest,
  ProviderChunk,
  ProviderConfig,
  ToolDefinition,
} from '@ghostbot/shared';

/**
 * True for an OpenAI **reasoning** model served from OpenAI's own endpoint.
 *
 * Matched by model-name prefix rather than a fixed list so a newly released
 * gpt-5.7 works on day one. The host check matters: DeepSeek, Groq, Ollama
 * and friends borrow OpenAI-style model names but do not implement OpenAI's
 * newer request fields or the `/v1/responses` endpoint.
 */
export function isOpenAiReasoningModel(config: ProviderConfig): boolean {
  const host = config.baseUrl ?? '';
  if (!/(^|\/\/|\.)openai\.com/.test(host)) return false;
  return /^(gpt-[5-9]|o[1-9])/.test((config.model ?? '').toLowerCase());
}

interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  id?: string;
  choices?: Array<{
    delta?: { role?: string; content?: string | null; tool_calls?: OpenAiToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly kind = 'openai-compatible' as const;
  readonly label: string;

  constructor(private readonly config: ProviderConfig) {
    this.label = config.label || config.id;
  }

  validate(): { ok: true } | { ok: false; error: string } {
    if (!this.config.baseUrl) return { ok: false, error: 'baseUrl is required' };
    if (!this.config.model) return { ok: false, error: 'model is required' };
    const url = this.config.baseUrl.replace(/\/+$/, '');
    if (url.endsWith('/v1')) return { ok: true };
    return { ok: true }; // nonstandard bases allowed; we always append /chat/completions
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderChunk> {
    const body = this.toWire(request);
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

    const useStream = request.stream !== false;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: useStream }),
      signal: request.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI-compatible endpoint returned HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    if (useStream) {
      yield* this.parseStream(res);
    } else {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>;
        usage?: unknown;
      };
      const msg = json.choices?.[0]?.message;
      yield {
        kind: 'done',
        message: {
          role: 'assistant',
          content: msg?.content ?? '',
          toolCalls: this.fromWireToolCalls(msg?.tool_calls),
        },
        usage: { raw: json.usage },
      };
    }
  }

  private toWire(request: ChatRequest) {
    return {
      model: this.config.model,
      messages: request.messages.map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'tool',
            tool_call_id: m.toolCallId,
            content: m.content,
          };
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
            })),
          };
        }
        // Images ride as OpenAI "content parts". Only user messages carry
        // attachments, and only when at least one is an image — a plain
        // string content is what every compatible endpoint accepts, so we
        // avoid the richer shape unless it is actually needed.
        const images = (m.attachments ?? []).filter((a) => a.kind === 'image' && a.data);
        if (m.role === 'user' && images.length > 0) {
          return {
            role: 'user',
            content: [
              ...(m.content ? [{ type: 'text', text: m.content }] : []),
              ...images.map((img) => ({
                type: 'image_url',
                image_url: { url: `data:${img.mimeType};base64,${img.data}` },
              })),
            ],
          };
        }
        return { role: m.role, content: m.content };
      }),
      tools: request.toolDefs?.length
        ? request.toolDefs.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined,
      // Newer OpenAI models renamed max_tokens → max_completion_tokens and
      // reject the old field. Only applied against api.openai.com: sending an
      // unknown field to a strict third-party server would fail the request.
      ...(request.maxTokens
        ? isOpenAiReasoningModel(this.config)
          ? { max_completion_tokens: request.maxTokens }
          : { max_tokens: request.maxTokens }
        : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(this.config.extra ?? {}),
    };
  }

  private fromWireToolCalls(raw: unknown[] | undefined) {
    if (!Array.isArray(raw)) return undefined;
    return raw
      .filter((tc): tc is Record<string, unknown> => !!tc && typeof tc === 'object')
      .map((tc) => {
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(typeof fn.arguments === 'string' ? fn.arguments : '{}');
        } catch {
          args = {};
        }
        return {
          id: String(tc.id ?? ''),
          name: String(fn.name ?? ''),
          args,
        };
      });
  }

  private async *parseStream(res: Response): AsyncIterable<ProviderChunk> {
    if (!res.body) throw new Error('response has no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Accumulated tool-call deltas per index
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    const flush = (line: string): ProviderChunk[] => {
      const out: ProviderChunk[] = [];
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return out;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return out;
      let json: OpenAiChunk;
      try {
        json = JSON.parse(payload);
      } catch {
        return out;
      }
      if (json.error?.message) {
        out.push({ kind: 'error', message: json.error.message });
        return out;
      }
      for (const choice of json.choices ?? []) {
        const delta = choice.delta ?? {};
        if (delta.content) out.push({ kind: 'text', text: delta.content });
        for (const tc of delta.tool_calls ?? []) {
          const acc = toolCalls.get(tc.index) ?? { id: tc.id ?? '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolCalls.set(tc.index, acc);
        }
      }
      return out;
    };

    const emitToolCalls = (): ProviderChunk[] => {
      const out: ProviderChunk[] = [];
      const calls = [...toolCalls.entries()].map(([idx, acc]) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(acc.args || '{}');
        } catch {
          args = {};
        }
        return { id: acc.id || `call_${idx}`, name: acc.name || 'unknown', args };
      });
      for (const call of calls) out.push({ kind: 'tool_call', call });
      for (const call of calls) out.push({ kind: 'tool_call_done', id: call.id });
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
        for (const chunk of flush(line)) yield chunk;
      }
    }
    for (const chunk of flush(buffer)) yield chunk;
    const calls = [...toolCalls.entries()].map(([idx, acc]) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(acc.args || '{}');
      } catch {
        args = {};
      }
      return { id: acc.id || `call_${idx}`, name: acc.name || 'unknown', args };
    });
    for (const chunk of emitToolCalls()) yield chunk;
    yield {
      kind: 'done',
      message: { role: 'assistant', content: '', toolCalls: calls.length ? calls : undefined },
    };
  }
}
