/**
 * Provider presets — one-click configurations for popular LLM backends.
 */
import type { ProviderConfig } from '@wispcrew/shared';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: 'openai-compatible' | 'anthropic' | 'chatgpt-subscription';
  /**
   * True when this preset signs in with a subscription instead of taking an
   * API key. The UI shows a sign-in button and the risk warning rather than
   * a key field.
   */
  subscription?: boolean;
  baseUrl: string;
  /** Default model when none chosen. */
  defaultModel: string;
  /** Common model options. */
  models: string[];
  /** Set to true when the endpoint is local and usually keyless. */
  local?: boolean;
  /** Human hint for the API key field. */
  keyHint: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyHint: 'DeepSeek API key (platform.deepseek.com)',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    // Model lists go stale fast. The Model field is a free-text combo box, so
    // anything newer than this list can be typed in without a code change.
    defaultModel: 'gpt-5.6-luna',
    models: [
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
    ],
    keyHint: 'OpenAI API key (platform.openai.com)',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    // Verified against /v1/models. The Model field is a free-text combo box,
    // so anything newer can be typed in without a code change.
    defaultModel: 'claude-opus-5',
    models: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
    keyHint: 'Anthropic API key (console.anthropic.com)',
  },
  // Subscription sign-ins. Listed after the API-key providers because those
  // are the supported path; these carry a risk the UI spells out.
  {
    id: 'chatgpt-subscription',
    label: 'ChatGPT subscription',
    kind: 'chatgpt-subscription',
    subscription: true,
    baseUrl: '',
    defaultModel: 'gpt-5.6-luna',
    models: ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4-mini'],
    keyHint: 'Sign in with your ChatGPT account — no API key needed',
  },
  {
    id: 'claude-subscription',
    label: 'Claude subscription',
    kind: 'anthropic',
    subscription: true,
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-5',
    models: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
    keyHint: 'Sign in with your Claude Pro/Max account — no API key needed',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    models: ['llama3.2', 'llama3.1', 'qwen2.5', 'deepseek-r1', 'mistral'],
    local: true,
    keyHint: 'Leave empty — Ollama runs locally',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    models: ['local-model'],
    local: true,
    keyHint: 'Leave empty — LM Studio runs locally',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    /*
     * Model list is deliberately short and was chosen by testing, not by
     * copying the 100+ entry catalogue.
     *
     * WispCrew is an agent: a model that cannot call tools is close to
     * useless here, and several NVIDIA-hosted models advertise tool support
     * they do not deliver. `llama-3.3-nemotron-super-49b` emitted a raw `<T`
     * into its reply instead of a tool call, and one catalogue entry answered
     * HTTP 410 Gone. The models below returned real `tool_calls` when asked.
     *
     * The Model field is a free-text combo box, so anything else in the
     * catalogue can still be typed in.
     */
    defaultModel: 'meta/llama-3.3-70b-instruct',
    models: [
      'meta/llama-3.3-70b-instruct',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'nvidia/nemotron-3-super-120b-a12b',
      'meta/llama-3.1-70b-instruct',
      'meta/llama-3.1-8b-instruct',
      'mistralai/mistral-large-2-instruct',
    ],
    keyHint: 'NVIDIA API key from build.nvidia.com (free tier available)',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-2.5-32b'],
    keyHint: 'Groq API key (console.groq.com)',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    models: ['deepseek/deepseek-chat', 'anthropic/claude-sonnet-4.5', 'openai/gpt-4o'],
    keyHint: 'OpenRouter API key (openrouter.ai/keys)',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: 'model',
    models: [],
    /*
     * Deliberately NOT flagged `local`.
     *
     * A custom endpoint may be a local server or a remote one — the user
     * decides by editing the Base URL. Claiming it is local made it show as
     * "configured" with no credential at all, which is only true for the
     * localhost default. Whether a key is required is judged from the actual
     * URL at request time (`endpointAllowsNoKey`), not from this flag.
     */
    keyHint: 'API key if your endpoint requires one',
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/**
 * Does this endpoint legitimately run without an API key?
 *
 * Ollama, LM Studio and other self-hosted servers are keyless by design, so
 * demanding a key would block a perfectly valid setup. Everything else needs
 * one, and saying so up front is far better than letting the request go out
 * and reporting the resulting 401 as "your key was rejected" — which is
 * actively misleading when the user never entered a key.
 */
export function endpointAllowsNoKey(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)(:|\/|$)/i.test(
    baseUrl,
  );
}

/** Build a ProviderConfig from a preset + overrides. */
export function configFromPreset(
  presetId: string,
  overrides: Partial<Pick<ProviderConfig, 'apiKey' | 'model' | 'baseUrl'>> = {},
): ProviderConfig {
  const preset = getPreset(presetId) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]!;
  return {
    id: preset.id,
    label: preset.label,
    kind: preset.kind,
    baseUrl: overrides.baseUrl ?? preset.baseUrl,
    apiKey: overrides.apiKey,
    model: overrides.model ?? preset.defaultModel,
  };
}
