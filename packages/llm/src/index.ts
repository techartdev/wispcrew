export * from './openai-compatible.js';
export * from './openai-responses.js';
export * from './anthropic.js';
export * from './presets.js';
export * from './errors.js';
export * from './subscription-auth.js';
export * from './oauth-flow.js';
export * from './codex-backend.js';
import type { ChatProvider, ProviderConfig } from '@ghostbot/shared';
import { OpenAICompatibleProvider, isOpenAiReasoningModel } from './openai-compatible.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import { AnthropicProvider } from './anthropic.js';

/**
 * Build a provider instance from config.
 *
 * OpenAI's reasoning models (gpt-5.x, o-series) are routed to the Responses
 * API, because `/v1/chat/completions` refuses function tools for them unless
 * reasoning is switched off â€” and switching reasoning off measurably degrades
 * answers. Every other OpenAI-compatible endpoint (DeepSeek, Ollama, Groq,
 * LM Studio, OpenRouter, â€¦) keeps using chat-completions, which is the only
 * thing they implement.
 */
export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai-compatible':
    default:
      return isOpenAiReasoningModel(config)
        ? new OpenAIResponsesProvider(config)
        : new OpenAICompatibleProvider(config);
  }
}
