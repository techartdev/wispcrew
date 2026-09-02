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
} from '@wispcrew/shared';
import { endpointAllowsNoKey } from './presets.js';
import {
  backoffDelay,
  fetchWithRetry,
  isTransientErrorMessage,
  type RetryOptions,
} from './retry.js';

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

export interface OpenAICompatibleConfig extends ProviderConfig {
  /** Notified before each backoff wait, so the UI can explain the pause. */
  onRetry?: RetryOptions['onRetry'];
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly kind = 'openai-compatible' as const;
  readonly label: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.label = config.label || config.id;
  }

  validate(): { ok: true } | { ok: false; error: string } {
    if (!this.config.baseUrl) return { ok: false, error: 'No Base URL is set. Open Settings to choose a provider.' };
    if (!this.config.model) return { ok: false, error: 'No model is set. Choose one in Settings.' };
    // Catch a missing key here rather than letting the request go out and
    // reporting the 401 as "your API key was rejected" — which is nonsense
    // when the user has not entered one. Local servers are keyless by design.
    if (!this.config.apiKey && !endpointAllowsNoKey(this.config.baseUrl)) {
      return {
        ok: false,
        error: `${this.label} needs an API key. Open Settings and paste one to get started.`,
      };
    }
    return { ok: true };
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderChunk> {
    const body = this.toWire(request);
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

    const useStream = request.stream !== false;
    const maxRetries = 3;

    /*
     * Two kinds of transient failure, handled in two places.
     *
     * `fetchWithRetry` covers the honest case: a 429 or 5xx status. But some
     * providers smuggle a capacity error into a **200 response** — NVIDIA
     * returns `{"error":{"message":"ResourceExhausted: Worker local total
     * request limit reached (16/16)", ...}}` inside the SSE stream, so the
     * HTTP layer sees success. Buffering the first chunk lets that be caught
     * and the whole request retried, instead of killing an agent turn for a
     * condition that clears in seconds.
     */
    for (let attempt = 0; ; attempt++) {
      const res = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, stream: useStream }),
          signal: request.signal,
        },
        { signal: request.signal, onRetry: this.config.onRetry },
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `OpenAI-compatible endpoint returned HTTP ${res.status}: ${text.slice(0, 500)}`,
        );
      }

      if (!useStream) {
        yield* this.nonStreaming(res);
        return;
      }

      // Peek at the stream: if it opens with a transient error, retry rather
      // than surfacing it. Anything else is replayed to the caller intact.
      const chunks = this.parseStream(res);
      const iterator = chunks[Symbol.asyncIterator]();
      const first = await iterator.next();

      if (
        !first.done &&
        first.value.kind === 'error' &&
        isTransientErrorMessage(first.value.message) &&
        attempt < maxRetries
      ) {
        const delayMs = backoffDelay(attempt);
        this.config.onRetry?.({ attempt: attempt + 1, delayMs, status: 503 });
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      if (!first.done) yield first.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    }
  }

  /** Read a complete (non-streamed) response. */
  private async *nonStreaming(res: Response): AsyncIterable<ProviderChunk> {
    {
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
      /*
       * The FLAT spelling, which is what chat-completions takes — the
       * Responses API nests it as `reasoning: { effort }` instead.
       *
       * Sent only where an endpoint is known to accept it. Everything
       * OpenAI-compatible arrives through this adapter, including Ollama,
       * LM Studio and any local server, and a strict one rejects the whole
       * request over an unknown field rather than ignoring it.
       *
       * Note that WispCrew routes OpenAI's own reasoning models to the
       * Responses API, so in practice this path carries the effort only for
       * OpenRouter — which normalises it for whatever model is behind it.
       */
      ...(request.reasoningEffort && this.config.baseUrl?.includes('openrouter.ai')
        ? { reasoning: { effort: request.reasoningEffort } }
        : {}),
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
