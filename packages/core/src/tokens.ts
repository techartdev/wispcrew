/**
 * tokens.ts — how much of the model's context a conversation is using.
 *
 * The whole transcript is rebuilt and sent on every turn. That is correct —
 * an agent that forgets is not what this product is for — but it means a
 * conversation grows until the provider refuses it, and until now nothing
 * counted, warned, or trimmed. The first failure would arrive as a wall of
 * provider JSON on a turn that had worked an hour earlier.
 *
 * ## Estimated, and it says so
 *
 * There is no tokenizer here. Every provider uses a different one, they
 * change between model versions, and vendoring one would add a large native
 * or wasm dependency to an application whose rule is that dependencies are a
 * security decision (hard rule 9). So this counts characters with a
 * correction for how text actually tokenises, and every number it produces
 * is labelled an estimate.
 *
 * The estimate is good enough for the job it has: showing how full the
 * context is, which way it is heading, and which part of it is large. It is
 * NOT good enough to decide "this request will be rejected", which is why
 * the measured number is preferred wherever a provider has reported one —
 * see `ContextReport.measured`.
 *
 * ## Why not simply chars / 4
 *
 * That is the usual rule of thumb and it is wrong in the direction that
 * matters here. English prose runs near 4 characters per token; code, JSON
 * and file paths — most of what an agent's transcript contains — run closer
 * to 3, because punctuation and identifiers split. Under-counting is the
 * dangerous error: it reports room that is not there. So the ratio is
 * chosen per chunk from what the text looks like, and rounds against us.
 */

/** Rough characters-per-token for ordinary prose. */
const PROSE_RATIO = 4;

/**
 * And for code, JSON, paths and logs, which split far more finely.
 *
 * Deliberately the pessimistic end. Reporting less headroom than there
 * really is costs a needless compaction; reporting more costs a failed turn
 * in the middle of somebody's work.
 */
const DENSE_RATIO = 3;

/**
 * Fixed cost of a message beyond its text: the role, the delimiters, and
 * whatever framing the provider adds. Small, but a long conversation of
 * short messages is mostly framing.
 */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * Does this text tokenise like prose, or like code?
 *
 * A cheap proxy: prose is mostly letters and spaces. Punctuation, braces
 * and slashes above a threshold mean the finer ratio applies.
 */
function looksDense(text: string): boolean {
  if (!text) return false;

  let symbols = 0;
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  for (const ch of sample) {
    if (!/[a-zA-Z0-9\s]/.test(ch)) symbols++;
  }
  return symbols / sample.length > 0.12;
}

/** Estimated tokens for one piece of text. Never negative, never NaN. */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  const ratio = looksDense(text) ? DENSE_RATIO : PROSE_RATIO;
  return Math.ceil(text.length / ratio);
}

/** Estimated tokens for a list of messages, including their framing. */
export function estimateMessageTokens(
  messages: { content?: string; toolCalls?: unknown }[],
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + PER_MESSAGE_OVERHEAD;
    // A tool call travels as JSON the model is charged for, so it counts.
    if (m.toolCalls) total += estimateTokens(JSON.stringify(m.toolCalls));
  }
  return total;
}

/** Estimated tokens for the tool definitions sent with every request. */
export function estimateToolTokens(tools: { name: string; description?: string }[]): number {
  // The whole definition goes on the wire — name, description and the JSON
  // schema of its parameters — so the serialised form is what to measure.
  return estimateTokens(JSON.stringify(tools));
}

/**
 * How large a context this model has, or `undefined` when we do not know.
 *
 * Matched on substrings of the model name rather than exact ids, because
 * providers ship variants constantly (`-preview`, `-0125`, a date suffix)
 * and an exact table would be wrong within weeks.
 *
 * **Unknown is a real answer.** A model this build has never heard of gets
 * no denominator, and the UI shows what is used without a percentage. That
 * is the same rule the subscription code follows for Anthropic usage:
 * inventing a plausible number is worse than admitting ignorance, because a
 * wrong limit produces either false alarm or false confidence, and both are
 * acted on.
 *
 * The user can set the real figure per agent when they know it.
 */
const WINDOWS: { match: RegExp; tokens: number }[] = [
  // OpenAI
  { match: /^gpt-5/, tokens: 400_000 },
  { match: /^gpt-4\.1/, tokens: 1_000_000 },
  { match: /^gpt-4o/, tokens: 128_000 },
  { match: /^o[1-9]/, tokens: 200_000 },

  // Anthropic
  { match: /^claude-(opus|sonnet)-[5-9]/, tokens: 200_000 },
  { match: /^claude-haiku/, tokens: 200_000 },
  { match: /^claude-/, tokens: 200_000 },

  // DeepSeek
  { match: /^deepseek-(chat|reasoner)/, tokens: 128_000 },

  // Meta Llama, as served by most hosts
  { match: /llama-3\.[123]/, tokens: 128_000 },

  // NVIDIA NIM's own families
  { match: /nemotron/, tokens: 128_000 },

  // Google
  { match: /gemini-[12]\.[05]-pro/, tokens: 2_000_000 },
  { match: /gemini/, tokens: 1_000_000 },

  // Mistral
  { match: /mistral|mixtral/, tokens: 128_000 },

  // Qwen
  { match: /qwen/, tokens: 128_000 },
];

export function contextWindowFor(model: string | undefined): number | undefined {
  if (!model) return undefined;
  // Providers prefix with a vendor path (`nvidia/nemotron-…`); match on the
  // part that names the model.
  const name = model.trim().toLowerCase().split('/').pop() ?? '';
  return WINDOWS.find((w) => w.match.test(name))?.tokens;
}

/** What a conversation is costing, and how much room is left. */
export interface ContextReport {
  /** Total tokens the next request would carry. */
  used: number;
  /**
   * True when `used` came from the provider rather than this estimator.
   *
   * The distinction is shown to the user, because it is the difference
   * between "76%" and "about 76%", and because an estimate that is quietly
   * presented as a measurement will eventually be trusted for a decision it
   * cannot support.
   */
  measured: boolean;
  /** The model's context window, when this build knows it. */
  limit?: number;
  /** Fraction used, 0–1. Absent when the limit is unknown. */
  fraction?: number;

  /* The breakdown. Always estimated, even when `used` is measured: a
   * provider reports one total and never says which part was the tools. */
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
}

/**
 * Assemble a report from the parts of a request.
 *
 * `measuredInput` is the provider's own `inputTokens` from the last turn.
 * When present it replaces the estimated total — it is the same
 * conversation plus one more exchange, so it is far closer than any
 * character count — while the breakdown stays estimated and is scaled to
 * agree with it, so the parts always sum to the whole a person can see.
 */
export function buildContextReport(input: {
  systemPrompt?: string;
  tools?: { name: string; description?: string }[];
  messages?: { content?: string; toolCalls?: unknown }[];
  model?: string;
  /** The provider's reported input tokens for the most recent turn. */
  measuredInput?: number;
  /** An explicit window from the agent's configuration, if set. */
  limitOverride?: number;
}): ContextReport {
  const systemTokens = estimateTokens(input.systemPrompt);
  const toolTokens = estimateToolTokens(input.tools ?? []);
  const messageTokens = estimateMessageTokens(input.messages ?? []);

  const estimated = systemTokens + toolTokens + messageTokens;
  const measured = typeof input.measuredInput === 'number' && input.measuredInput > 0;
  const used = measured ? (input.measuredInput as number) : estimated;

  const limit = input.limitOverride ?? contextWindowFor(input.model);

  /*
   * Scale the breakdown to the measured total.
   *
   * Otherwise the three parts visibly fail to add up to the number beside
   * them, which reads as a bug in the meter rather than as the estimate it
   * is. Skipped when there is nothing to scale from.
   */
  const scale = measured && estimated > 0 ? used / estimated : 1;

  return {
    used,
    measured,
    limit,
    fraction: limit ? Math.min(used / limit, 1) : undefined,
    systemTokens: Math.round(systemTokens * scale),
    toolTokens: Math.round(toolTokens * scale),
    messageTokens: Math.round(messageTokens * scale),
  };
}
