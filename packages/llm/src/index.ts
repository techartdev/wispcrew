export * from './openai-compatible.js';
export * from './openai-responses.js';
export * from './anthropic.js';
export * from './presets.js';
export * from './errors.js';
export * from './subscription-auth.js';
export * from './codex-backend.js';
export * from './usage-limits.js';
export * from './retry.js';

/**
 * The two OAuth flows are namespaced rather than re-exported flat.
 *
 * Both define `generatePkce`, `buildAuthorizeUrl`, `exchangeAuthorizationCode`
 * and `refreshCredential`, so a flat `export *` would silently drop one
 * vendor's version. Namespacing also keeps call sites explicit about which
 * provider they are signing into — a mix-up there produces a confusing
 * "invalid client" rather than a type error.
 */
export * as claudeOAuth from './oauth-flow.js';
export * as chatgptOAuth from './chatgpt-oauth.js';
export type { OAuthCredential } from './oauth-flow.js';
export type { ChatGptCredential, PendingLogin } from './chatgpt-oauth.js';
export * from './catalogue.js';

import type { ChatProvider, ProviderConfig } from '@wispcrew/shared';
import { OpenAICompatibleProvider, isOpenAiReasoningModel } from './openai-compatible.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import { AnthropicProvider } from './anthropic.js';
import { CodexSubscriptionProvider, type CodexConfig } from './codex-backend.js';

/**
 * Build a provider instance from config.
 *
 * Three routing decisions, each for a concrete reason:
 *
 *  - A **ChatGPT subscription** config (kind `chatgpt-subscription`) goes to
 *    the Codex backend, which bills the subscription. `api.openai.com`
 *    rejects those tokens outright.
 *  - **OpenAI reasoning models** (gpt-5.x, o-series) go to the Responses API,
 *    because `/v1/chat/completions` refuses function tools for them unless
 *    reasoning is switched off — and switching it off measurably degrades
 *    answers.
 *  - Everything else keeps chat-completions, which is the only thing
 *    DeepSeek, Ollama, Groq, LM Studio and OpenRouter implement.
 */
export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'chatgpt-subscription':
      return new CodexSubscriptionProvider(config as CodexConfig);
    case 'openai-compatible':
    default:
      return isOpenAiReasoningModel(config)
        ? new OpenAIResponsesProvider(config)
        : new OpenAICompatibleProvider(config);
  }
}
