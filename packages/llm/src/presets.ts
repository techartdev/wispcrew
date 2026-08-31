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
    /*
     * `meta/llama-3.3-70b-instruct` was the default and was RETIRED
     * mid-project — NVIDIA answered 410 Gone, so a fresh install picked a
     * model that could never work. A curated list goes stale invisibly,
     * which is why the full catalogue is now fetched live from the provider
     * and these are only the ones marked as tested.
     */
    /*
     * BEING LISTED IS NOT BEING SERVABLE, and assuming otherwise cost a
     * session. `nvidia/nemotron-3.5-lightning-30b-a3b` appears in
     * `/v1/models`, was made the default here, and returns 404 to a real
     * chat call — so every local turn failed while the same key worked
     * elsewhere. The catalogue also carries embedding and vision models
     * that can never chat.
     *
     * Each entry below answered a real `/chat/completions` request:
     *   nemotron-3.5-lightning-30b-a3b  404  listed, not servable
     *   meta/llama-3.1-70b-instruct     410  retired
     *   nemotron-3-super-120b-a12b      ok
     *   nemotron-3-nano-30b-a3b         ok
     */
    /*
     * `nano` is the default because it is the one that RELIABLY answers.
     *
     * Same six identical requests: `super-120b` returned 404 four times,
     * `nano-30b` answered five of five. A free tier reuses 404 for "no
     * capacity", so a bigger model that is busy half the time is a worse
     * default than a smaller one that responds.
     */
    defaultModel: 'nvidia/nemotron-3-nano-30b-a3b',
    models: [
      'nvidia/nemotron-3-nano-30b-a3b',
      'nvidia/nemotron-3-super-120b-a12b',
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
  /*
   * Trimmed, because invisible whitespace is a real failure mode.
   *
   * A model name reached a stored profile as
   * `"nvidia/nemotron-3-nano-30b-a3b\r"` — a carriage return picked up from
   * a shell script written on Windows. Every request then 404'd, and the
   * error named a model that looked exactly right on screen, because a `\r`
   * renders as nothing. The same happens to anyone pasting a name with a
   * trailing space.
   *
   * Trimmed on USE rather than only on save, so a profile that already
   * holds a damaged value heals itself without a migration.
   */
  const clean = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  return {
    id: preset.id,
    label: preset.label,
    kind: preset.kind,
    baseUrl: clean(overrides.baseUrl) ?? preset.baseUrl,
    apiKey: overrides.apiKey,
    model: clean(overrides.model) ?? preset.defaultModel,
  };
}
