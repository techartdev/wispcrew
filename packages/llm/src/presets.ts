/**
 * Provider presets — one-click configurations for popular LLM backends.
 */
import type { ProviderConfig } from '@ghostbot/shared';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: 'openai-compatible' | 'anthropic';
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
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
    keyHint: 'Anthropic API key (console.anthropic.com)',
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
    local: true,
    keyHint: 'API key if your endpoint requires one',
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
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
