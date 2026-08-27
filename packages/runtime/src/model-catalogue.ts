/**
 * model-catalogue.ts — what this machine's provider can actually run.
 *
 * The preset carries six models chosen by testing; NVIDIA alone offers 84.
 * The dropdown was therefore hiding most of what a key already paid for,
 * and its default was a model retired mid-project.
 *
 * Lives in the runtime so the CLI can answer it too — a headless machine
 * has the same question and no Settings panel to ask it in.
 */
import { fetchModels, getPreset, type CatalogueEntry } from '@wispcrew/llm';
import { host } from './host.js';
import { providerSecretKey } from './provider-keys.js';
import { readSecrets } from './secrets-store.js';

/**
 * Cached per preset for the session.
 *
 * Opening Settings should not spend a network round trip every time, and a
 * provider's catalogue does not change while the window is open.
 */
const cache = new Map<string, CatalogueEntry[]>();

export async function listProviderModels(
  presetId: string,
  options: { refresh?: boolean } = {},
): Promise<CatalogueEntry[]> {
  if (!options.refresh) {
    const hit = cache.get(presetId);
    if (hit) return hit;
  }

  const preset = getPreset(presetId);
  if (!preset) return [];

  const dataDir = host().dataDir;
  const secrets = readSecrets(dataDir);
  const apiKey =
    secrets[providerSecretKey(presetId)] ??
    secrets.WISPCREW_API_KEY ??
    process.env.WISPCREW_API_KEY;

  const models = await fetchModels({
    baseUrl: preset.baseUrl ?? '',
    apiKey,
    curated: preset.models ?? [],
  });

  cache.set(presetId, models);
  return models;
}

/** Forget the cache, so a new key is reflected without a restart. */
export function clearModelCache(): void {
  cache.clear();
}
