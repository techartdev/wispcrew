/**
 * Anthropic Messages API provider (Claude models, incl. tool use).
 */
import type {
  ChatProvider,
  ChatRequest,
  ProviderChunk,
  ProviderConfig,
} from '@wispcrew/shared';
import { usageFromAnthropicHeaders, type UsageSnapshot } from './usage-limits.js';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  /** Present on `image` blocks (base64 source). */
  source?: { type: 'base64'; media_type: string; data: string };
}

interface AnthropicEvent {
  type: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  delta?: { type?: string; text?: string; stop_reason?: string };
  content_block?: AnthropicContentBlock;
  index?: number;
  error?: { message?: string };
}

/** Relative wording for a reset time, e.g. "in 3 hours". */
function describeReset(at: number): string {
  const minutes = Math.max(1, Math.round((at - Date.now()) / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return `in ${Math.round(hours / 24)} days`;
}

export interface AnthropicConfig extends ProviderConfig {
  /** Called with any quota information the response reports. */
  onUsage?: (usage: UsageSnapshot) => void;
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = 'anthropic' as const;
  readonly label: string;

  constructor(private readonly config: AnthropicConfig) {
    this.label = config.label || config.id;
  }

  validate(): { ok: true } | { ok: false; error: string } {
    if (!this.config.apiKey) {
      return {
        ok: false,
        error:
          'Anthropic needs an API key, or a Claude sign-in. Open Settings to add one.',
      };
    }
    if (!this.config.model) return { ok: false, error: 'No model is set. Choose one in Settings.' };
    return { ok: true };
  }

  /**
   * Authentication headers for one request.
   *
   * Anthropic accepts two different credentials on this endpoint and they are
   * **not** interchangeable:
   *
   *  - An API key (`sk-ant-api…`) goes in `x-api-key`.
   *  - A subscription OAuth access token (`sk-ant-oat…`) goes in
   *    `Authorization: Bearer`, and the request must also carry the OAuth
   *    beta header plus the Claude Code identity headers. Sent as `x-api-key`
   *    an OAuth token is simply rejected.
   *
   * The token's own prefix says which it is, so callers never have to
   * declare the mode and cannot get it wrong.
   */
  private authHeaders(): Record<string, string> {
    const credential = this.config.apiKey ?? '';
    const base: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (credential.startsWith('sk-ant-oat')) {
      return {
        ...base,
        authorization: `Bearer ${credential}`,
        'anthropic-beta': 'oauth-2025-04-20',
        // Identity headers the subscription endpoint expects from a
        // Claude Code-style client.
        'user-agent': 'claude-cli/1.0.0 (external)',
        'x-app': 'cli',
      };
    }
    return { ...base, 'x-api-key': credential };
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderChunk> {
    const base = this.config.baseUrl.replace(/\/+$/, '') || 'https://api.anthropic.com';
    const url = `${base}/v1/messages`;

    const systemParts: string[] = [];
    const messages = [];
    for (const m of request.messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
        continue;
      }
      if (m.role === 'tool') {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId,
              content: m.content,
            },
          ],
        });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: AnthropicContentBlock[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args ?? {} });
        }
        messages.push({ role: 'assistant', content });
        continue;
      }
      // Images use Anthropic's base64 source blocks. Anthropic accepts only
      // png/jpeg/webp/gif, so anything else is dropped here rather than
      // triggering an API error the user cannot act on.
      const images = (m.attachments ?? []).filter(
        (a) => a.kind === 'image' && a.data && /^image\/(png|jpeg|webp|gif)$/.test(a.mimeType),
      );
      if (m.role === 'user' && images.length > 0) {
        const content: AnthropicContentBlock[] = images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data as string },
        }));
        if (m.content) content.push({ type: 'text', text: m.content });
        messages.push({ role: 'user', content });
        continue;
      }

      // plain user/assistant text
      messages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    if (request.toolDefs?.length) {
      body.tools = request.toolDefs.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    if (request.stream !== false) body.stream = true;
    Object.assign(body, this.config.extra ?? {});

    const res = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    // Quota information rides on both success and failure responses, so read
    // it before any early return — a 429 is precisely when it matters.
    const usage = usageFromAnthropicHeaders(res.headers, res.status);
    if (usage) this.config.onUsage?.(usage);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // A 429 here means the plan's quota is spent, not that anything is
      // misconfigured — so say that plainly rather than showing a status
      // code. Anthropic sends no reset time on the subscription path
      // (verified: the only hint is `x-should-retry`), so do not imply we
      // know when it lifts.
      if (res.status === 429) {
        const when = usage?.resetsAt
          ? ` It resets ${describeReset(usage.resetsAt)}.`
          : ' Anthropic does not say when it resets — try again later, or switch to an API key or another provider in Settings.';
        throw new Error(`Your Claude plan's usage limit is currently reached.${when}`);
      }
      throw new Error(`Anthropic returned HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    if (request.stream === false) {
      const json = (await res.json()) as {
        content?: AnthropicContentBlock[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      yield this.doneFromContent(json.content ?? [], json.usage);
      return;
    }

    if (!res.body) throw new Error('response has no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // pending tool-use blocks by index
    const toolBlocks = new Map<number, { id: string; name: string; input: string }>();
    let pendingToolIndex: number | null = null;
    let pendingToolId = '';
    let pendingToolName = '';

    const emitPendingTool = (): ProviderChunk[] => {
      const out: ProviderChunk[] = [];
      if (pendingToolIndex !== null) {
        const key = pendingToolIndex;
        const acc = toolBlocks.get(key) ?? { id: pendingToolId, name: pendingToolName, input: '' };
        toolBlocks.set(key, acc);
        pendingToolIndex = null;
        pendingToolId = '';
        pendingToolName = '';
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
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev: AnthropicEvent;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.error?.message) {
          yield { kind: 'error', message: ev.error.message };
          continue;
        }
        switch (ev.type) {
          case 'content_block_start': {
            const cb = ev.content_block;
            if (cb?.type === 'tool_use' && ev.index !== undefined && cb.id && cb.name) {
              pendingToolIndex = ev.index;
              pendingToolId = cb.id;
              pendingToolName = cb.name;
              toolBlocks.set(ev.index, { id: cb.id, name: cb.name, input: '' });
            }
            break;
          }
          case 'content_block_delta': {
            const d = ev.delta;
            if (d?.type === 'text_delta' && d.text) yield { kind: 'text', text: d.text };
            if (d?.type === 'input_json_delta' && ev.index !== undefined && d.text) {
              const acc = toolBlocks.get(ev.index);
              if (acc) acc.input += d.text;
            }
            break;
          }
          case 'content_block_stop': {
            for (const c of emitPendingTool()) yield c;
            break;
          }
          default:
            break;
        }
      }
    }
    for (const c of emitPendingTool()) yield c;

    const content: AnthropicContentBlock[] = [];
    for (const [idx, acc] of toolBlocks) {
      content.push({ type: 'tool_use', id: acc.id, name: acc.name, input: undefined });
      content[idx] = content[idx] ?? { type: 'tool_use', id: acc.id, name: acc.name, input: {} };
      try {
        content[idx]!.input = JSON.parse(acc.input || '{}');
      } catch {
        content[idx]!.input = {};
      }
    }
    yield this.doneFromContent(content);
  }

  private doneFromContent(content: AnthropicContentBlock[], usage?: unknown): ProviderChunk {
    const toolCalls = content
      .filter((b) => b.type === 'tool_use' && b.id && b.name)
      .map((b) => ({
        id: b.id as string,
        name: b.name as string,
        args: (b.input ?? {}) as Record<string, unknown>,
      }));
    const text = content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('');
    return {
      kind: 'done',
      message: { role: 'assistant', content: text, toolCalls: toolCalls.length ? toolCalls : undefined },
      usage: { raw: usage },
    };
  }
}
