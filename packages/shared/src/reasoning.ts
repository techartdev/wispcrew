/**
 * reasoning.ts — how hard a model should think, where that means anything.
 *
 * Several providers expose a knob for this and each spells it differently.
 * The temptation is one dropdown everywhere; the result of that is a control
 * that silently does nothing on most of the models a user brings, which is
 * worse than no control at all — hard rule 11, and the reason a dead switch
 * costs you trust in every other switch on the panel.
 *
 * So this says, per provider AND per model, whether the knob exists and what
 * it accepts. Where the answer is "it does not", the UI shows nothing.
 *
 * ## What each vendor actually takes
 *
 * **OpenAI** — `reasoning.effort` on the Responses API, `reasoning_effort` on
 * chat-completions. The documented values are `none`, `minimal`, `low`,
 * `medium`, `high`, `xhigh` and `max`, and the docs are explicit that
 * "supported values are model-dependent". That sentence is why this table is
 * keyed by model family and not merely by provider: offering `xhigh` to a
 * model that rejects it produces a failed turn, not a slower one.
 *
 * **Anthropic** — no enum at all. Extended thinking is
 * `thinking: { type: 'enabled', budget_tokens: N }`, a token budget. The
 * effort names here map onto budgets, and that mapping is stated rather than
 * hidden, because a user who picks "high" is entitled to know it means a
 * number.
 *
 * **NVIDIA NIM** — reasoning is controlled by the system prompt or by
 * `chat_template_kwargs`, and which of the two depends on the model. There is
 * no portable effort field, so none is offered. A dropdown here would be a
 * lie told in a place the user cannot check.
 *
 * **DeepSeek** — `deepseek-reasoner` reasons always and takes no knob;
 * `deepseek-chat` does not reason. Nothing to offer either way.
 *
 * **Local runtimes** (Ollama, LM Studio, llama.cpp) — depends entirely on
 * the model loaded, and nothing in the OpenAI-compatible surface reports it.
 * Not offered rather than guessed.
 */

/** How a provider expresses "think harder". */
export type ReasoningStyle =
  /** An enum sent as `reasoning.effort` / `reasoning_effort`. */
  | 'effort'
  /** A token budget sent as `thinking.budget_tokens`. */
  | 'budget'
  /** No portable control. */
  | 'none';

export interface ReasoningSupport {
  style: ReasoningStyle;
  /** Accepted values, in order, or empty when the style is `none`. */
  levels: string[];
  /**
   * One line for the UI, said plainly.
   *
   * Shown beside the control because "high" means different things on
   * different providers, and on Anthropic it means a number of tokens.
   */
  note?: string;
}

const NONE: ReasoningSupport = { style: 'none', levels: [] };

/**
 * Token budgets the effort names map to on Anthropic.
 *
 * Round numbers rather than tuned ones: the useful distinction is order of
 * magnitude, and pretending to a precision nobody measured would be worse
 * than the honest coarseness.
 */
export const THINKING_BUDGETS: Record<string, number> = {
  low: 4_000,
  medium: 16_000,
  high: 32_000,
};

/** What this provider and model accept, if anything. */
export function reasoningFor(
  presetId: string | undefined,
  model: string | undefined,
): ReasoningSupport {
  const name = (model ?? '').trim().toLowerCase().split('/').pop() ?? '';

  switch (presetId) {
    case 'openai':
    case 'chatgpt-subscription': {
      /*
       * The o-series predates the wider scale and takes the original three.
       * Sending `minimal` or `xhigh` to one is a request error, so they are
       * not offered for it.
       */
      if (/^o[1-9]/.test(name)) {
        return {
          style: 'effort',
          levels: ['low', 'medium', 'high'],
          note: 'o-series models accept these three.',
        };
      }

      if (/^gpt-5/.test(name)) {
        return {
          style: 'effort',
          levels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
          note: 'Higher effort costs more reasoning tokens and takes longer.',
        };
      }

      // gpt-4o and friends do not reason, and sending the field is an error.
      return NONE;
    }

    case 'anthropic':
    case 'claude-subscription': {
      /*
       * Anthropic has no effort enum: this maps to a thinking budget, and
       * says so, because "high" here is a number of tokens rather than a
       * setting the vendor named.
       */
      if (/^claude-(opus|sonnet)/.test(name)) {
        return {
          style: 'budget',
          levels: ['low', 'medium', 'high'],
          note: `Extended thinking, as a token budget: ${THINKING_BUDGETS.low}, ${THINKING_BUDGETS.medium} or ${THINKING_BUDGETS.high}.`,
        };
      }
      return NONE;
    }

    case 'openrouter':
      /*
       * OpenRouter passes a reasoning block through to whichever model is
       * behind it, and normalises the common effort names. What the model
       * does with it is the model's business, which is as much as can
       * honestly be said from here.
       */
      return {
        style: 'effort',
        levels: ['low', 'medium', 'high'],
        note: 'Passed through to the model behind OpenRouter, which may ignore it.',
      };

    /*
     * Everything else: NVIDIA (system prompt or chat_template_kwargs,
     * per model), DeepSeek (reasoner always reasons, chat never does),
     * Groq, Ollama, LM Studio, and any custom endpoint. No portable
     * control, so none is shown.
     */
    default:
      return NONE;
  }
}

/** Is `effort` one this pairing accepts? Used before saving, not after. */
export function acceptsEffort(
  presetId: string | undefined,
  model: string | undefined,
  effort: string | undefined,
): boolean {
  if (!effort) return true; // Unset is always valid: it means "the default".
  return reasoningFor(presetId, model).levels.includes(effort);
}
