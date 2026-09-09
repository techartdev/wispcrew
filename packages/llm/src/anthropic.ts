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
import { reasoningFor, THINKING_BUDGETS } from '@wispcrew/shared';
import { fetchWithRetry, type RetryOptions } from './retry.js';

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
  /** Prompt-caching marker. */
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicEvent {
  type: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  /**
   * `text_delta` carries `text`; `input_json_delta` carries `partial_json`.
   *
   * They are different field names for the same idea, and the tool-argument
   * accumulator read `text` for both — so it never accumulated anything and
   * every tool call arrived with `{}`. Reported by an agent that diagnosed
   * it precisely: "read_file says paths[1] must be of type string. Received
   * undefined… the only call that works is list_dir with no arguments."
   *
   * It survived because Claude inference itself never worked until the
   * system-block fix an hour before this, so no Anthropic tool call had
   * ever been streamed. The bug was written, shipped, and unreachable.
   */
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
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
  /**
   * Notified before each backoff wait, so a pause can be explained.
   *
   * Same shape the OpenAI-compatible adapter takes; without it a retry is
   * indistinguishable from a hang.
   */
  onRetry?: RetryOptions['onRetry'];
}

/**
 * Anthropic's own sentence about what went wrong.
 *
 * Its errors are `{"type":"error","error":{"type":..., "message":...}}`.
 * Quoting the message is what lets a reader tell a per-minute rate limit
 * from a spent plan, which a status code alone cannot.
 */
/**
 * Quote Anthropic only when it said something.
 *
 * Its 429 body carries `"message":"Error"` — a word that adds nothing and
 * makes a clear sentence look like a stack trace. A useless message is worse
 * than none, so it is dropped.
 */
function describeSaid(said: string | undefined): string {
  if (!said) return '';
  const useless = /^(error|unknown|bad request)\.?$/i.test(said.trim());
  return useless ? '' : ` (${said})`;
}

/**
 * What Anthropic requires a subscription request to say about itself.
 *
 * Sent as the first system block for an `sk-ant-oat` token. Exact text
 * matters: anything else, or the same words concatenated into a larger
 * string, is refused with a 429 that claims to be a rate limit.
 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function extractAnthropicMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } };
    const message = parsed.error?.message?.trim();
    if (message) return message;
    return parsed.error?.type?.trim() || undefined;
  } catch {
    // Not JSON. A short body is still better evidence than silence.
    const trimmed = body.trim();
    return trimmed && trimmed.length <= 200 ? trimmed : undefined;
  }
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
  /** True when authenticating with a subscription token rather than a key. */
  private usesSubscription(): boolean {
    return (this.config.apiKey ?? '').startsWith('sk-ant-oat');
  }

  private authHeaders(): Record<string, string> {
    const credential = this.config.apiKey ?? '';
    const base: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (this.usesSubscription()) {
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

    /*
     * The system prompt arrives as `request.system`, not as a message.
     *
     * Reading only `request.messages` for a `system` role — which the agent
     * loop never emits — meant Claude ran with no identity, room roster or
     * instructions at all. The subscription path still sent its hardcoded
     * identity block, which is why inference worked while the agent's actual
     * prompt was silently absent. Reported as "Claude did not know it could
     * tag the other agents, but the GPT agent did": the GPT subscription
     * backend reads `request.system`, the Anthropic one did not.
     */
    if (request.system) systemParts.push(request.system);

    const messages = [];
    for (const m of request.messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
        continue;
      }
      if (m.role === 'tool') {
        /*
         * All of a step's results go in ONE user message.
         *
         * Anthropic requires every `tool_use` block to be answered by a
         * `tool_result` in the message IMMEDIATELY after. A step with two
         * tool calls produces two `tool` messages, and giving each its own
         * user message left the second one a message too late:
         *
         *   assistant: tool_use(A), tool_use(B)
         *   user:      tool_result(A)      <- only A is "immediately after"
         *   user:      tool_result(B)
         *
         * which the API rejects outright with "tool_use ids were found
         * without tool_result blocks immediately after". The turn dies, and
         * the message blames the model or the attachments.
         *
         * Appending to the previous user message when it is already a
         * tool_result block keeps the mapping one-to-one with the step.
         */
        const block: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content,
        };
        const prev = messages[messages.length - 1];
        const prevIsToolResult =
          prev?.role === 'user' &&
          Array.isArray(prev.content) &&
          prev.content.length > 0 &&
          prev.content.every((b: AnthropicContentBlock) => b.type === 'tool_result');

        if (prevIsToolResult) (prev.content as AnthropicContentBlock[]).push(block);
        else messages.push({ role: 'user', content: [block] });
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

    /*
     * Prompt caching: mark the end of the stable prefix.
     *
     * Anthropic caches nothing unless a block carries `cache_control`. The
     * agent loop re-sends the whole conversation every step — a 92k-token
     * history, mostly tool results, re-billed in full — and WispCrew sent no
     * marker at all, so the entire prefix was paid for at write price every
     * single time.
     *
     * One breakpoint on the LAST block of the last message turns the whole
     * stable prefix (system, tools, every earlier turn) into a cache read,
     * which Anthropic bills at roughly a tenth of a write. Each new step
     * appends a message and moves the breakpoint onto it, so the prefix that
     * did not change stays cached.
     *
     * Ignored rather than rejected when the prefix is below Anthropic's
     * minimum cacheable length, so there is no downside to always asking.
     */
    if (messages.length > 0) {
      const last = messages[messages.length - 1]!;
      if (Array.isArray(last.content) && last.content.length > 0) {
        last.content[last.content.length - 1]!.cache_control = { type: 'ephemeral' };
      } else if (typeof last.content === 'string' && last.content.length > 0) {
        last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
      }
    }

    /*
     * Extended thinking, which Anthropic expresses as a BUDGET rather than
     * an effort enum: `thinking: { type: 'enabled', budget_tokens: N }`.
     *
     * The `low`/`medium`/`high` a user picked is mapped to a number here,
     * and the Configure panel says as much — "high" secretly meaning a token
     * count is not something to leave somebody to discover from a bill.
     */
    const budget =
      request.reasoningEffort && reasoningFor('anthropic', this.config.model).style === 'budget'
        ? THINKING_BUDGETS[request.reasoningEffort]
        : undefined;

    const body: Record<string, unknown> = {
      model: this.config.model,
      /*
       * The budget must leave room for the answer: Anthropic rejects a
       * request whose `budget_tokens` is not comfortably below `max_tokens`,
       * and a caller's 4096 default would not fit a 32k budget at all.
       */
      max_tokens: Math.max(request.maxTokens ?? 4096, budget ? budget + 4096 : 0),
      messages,
      /*
       * A subscription token must identify as Claude Code, as the FIRST
       * system block, or Anthropic refuses the request.
       *
       * This is why Claude inference never worked. The refusal is HTTP 429
       * with `{"type":"rate_limit_error","message":"Error"}` and
       * `x-should-retry: true` — indistinguishable from a real rate limit,
       * and read as one for weeks, including in this repo's own notes.
       *
       * Measured against the live API on a subscription account, in one
       * run:
       *
       *   identity only, as a string ............ 200
       *   identity + our prompt, ONE STRING ..... 429
       *   identity + our prompt, as BLOCKS ...... 200
       *   our prompt first, identity second ..... 429
       *   our prompt alone ...................... 429
       *
       * So it is not enough for the text to be present: the system must be
       * an ARRAY whose first block is exactly that sentence. Concatenating
       * into one string fails — which is the trap, because the obvious fix
       * produces the same 429 it was already being mistaken for.
       *
       * An API key needs none of this and is left alone.
       */
      ...(this.usesSubscription()
        ? {
            // The last block carries the cache marker, so the identity AND the
            // standing prompt are cached together and never re-billed.
            system: [
              { type: 'text', text: CLAUDE_CODE_IDENTITY },
              ...(systemParts.length ? [{ type: 'text', text: systemParts.join('\n\n') }] : []),
            ].map((block, i, all) =>
              i === all.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block,
            ),
          }
        : systemParts.length
          ? {
              system: [{ type: 'text', text: systemParts.join('\n\n'), cache_control: { type: 'ephemeral' } }],
            }
          : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
    };
    if (request.toolDefs?.length) {
      const tools = request.toolDefs.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      // Cached alongside the system prompt: the tool set is identical every
      // step, so re-billing its schema is pure waste. The marker is added
      // after the map so the source of the schema stays typed as a schema.
      (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
      body.tools = tools;
    }
    if (request.stream !== false) body.stream = true;
    Object.assign(body, this.config.extra ?? {});

    /*
     * Retried, which for a long time it was not.
     *
     * `retry.ts` was written for this and the OpenAI-compatible adapter used
     * it; this one called bare `fetch`, so every transient Anthropic failure
     * killed the turn outright. The one that exposed it was **529
     * Overloaded** — Anthropic's own status for "capacity full right now",
     * absent from `RETRYABLE` because the list looked like a complete 5xx
     * set and 529 is not a registered code.
     *
     * The 429-with-`x-should-retry` case below is left exactly as it was: it
     * distinguishes a spent plan from a busy one, and that reasoning is
     * about the MESSAGE, not the attempt. What changes is that a genuinely
     * transient status is now retried with backoff before any of it is
     * reached.
     */
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(body),
      },
      { signal: request.signal, onRetry: this.config.onRetry },
    );

    // Quota information rides on both success and failure responses, so read
    // it before any early return — a 429 is precisely when it matters.
    const usage = usageFromAnthropicHeaders(res.headers, res.status);
    if (usage) this.config.onUsage?.(usage);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      /*
       * A 429 is not proof that the plan's quota is spent.
       *
       * This asserted exactly that for every 429 and discarded the body,
       * which produced "Your Claude plan's usage limit is currently
       * reached" for somebody who had just signed in and had usage
       * available. Anthropic answers 429 for a short-term REQUEST rate
       * limit as well, and the two are hours apart in what they mean to a
       * user: one says wait a moment, the other says stop for the day.
       *
       * The body says which. `error.type` is `rate_limit_error` for the
       * transient case, and the message names the quota for the other. So
       * the distinction is read rather than assumed, and Anthropic's own
       * words are quoted either way — the same rule as never inventing a
       * usage number for a provider that reports none.
       */
      if (res.status === 429) {
        const said = extractAnthropicMessage(text);
        const retryAfter = res.headers.get('retry-after');

        /*
         * `x-should-retry` settles it, and it was the evidence being thrown
         * away.
         *
         * Captured from a real subscription account that had just signed in
         * and had usage available:
         *
         *   HTTP 429
         *   x-should-retry: true
         *   {"type":"error","error":{"type":"rate_limit_error",
         *    "message":"Error"}}
         *
         * A spent plan does not tell you to retry. So a `true` here means
         * the per-minute limiter whatever the prose says — and note the
         * message is literally "Error", which is why the header and the
         * type carry the meaning and the message carries none.
         */
        const shouldRetry = res.headers.get('x-should-retry') === 'true';
        const looksLikeQuota =
          !shouldRetry && /usage limit|quota|credit balance|spend/i.test(said ?? '');

        if (!looksLikeQuota) {
          const wait = retryAfter ? ` Try again in ${retryAfter}s.` : ' Try again in a moment.';
          throw new Error(`Anthropic is rate-limiting this request.${wait}${describeSaid(said)}`);
        }

        const when = usage?.resetsAt
          ? ` It resets ${describeReset(usage.resetsAt)}.`
          : retryAfter
            ? ` Anthropic suggests retrying in ${retryAfter}s.`
            : ' Anthropic does not say when it resets — try again later, or switch to an API key or another provider in Settings.';

        throw new Error(
          `Your Claude plan's usage limit is currently reached.${when}` +
            (said ? ` (${said})` : ''),
        );
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
            /*
             * The fragment is in `partial_json`, not `text`.
             *
             * Reading `text` here meant the accumulator stayed empty and
             * every tool call reached the tool layer as `{}` — "there is no
             * agent called undefined", "paths[1] must be of type string".
             * `text` is accepted as well because it costs nothing and a
             * transport that ever used it should not silently drop work.
             */
            if (d?.type === 'input_json_delta' && ev.index !== undefined) {
              const fragment = d.partial_json ?? d.text;
              const acc = toolBlocks.get(ev.index);
              if (acc && fragment) acc.input += fragment;
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

    /*
     * One block per tool, in the order Anthropic streamed them.
     *
     * This used to `push` a block AND assign at `content[idx]`, where `idx`
     * is Anthropic's content-block index. With a single tool at index 0
     * those were the same slot and it worked by accident. They stop being
     * the same slot the moment anything precedes the tool — and a
     * subscription turn now begins with a `thinking` block, so the tool sat
     * at index 1 and was emitted TWICE: once from the push with
     * `input: undefined`, once from the assignment with the parsed input.
     *
     * The map is already keyed by index and iterates in insertion order, so
     * the position is carried by the iteration and does not need to be
     * re-derived.
     */
    const content: AnthropicContentBlock[] = [];
    for (const acc of toolBlocks.values()) {
      let input: unknown = {};
      try {
        input = JSON.parse(acc.input || '{}');
      } catch {
        // A truncated stream leaves half a JSON object. An empty argument
        // set is wrong, but it is not a crash, and the tool reports what it
        // was missing.
        input = {};
      }
      content.push({ type: 'tool_use', id: acc.id, name: acc.name, input });
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
