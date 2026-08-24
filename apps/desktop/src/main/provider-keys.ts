/**
 * provider-keys.ts — one API key per provider, not one key for everything.
 *
 * GhostBot lets each agent choose its own provider and model, which only
 * works if several providers can be configured at the same time. A single
 * shared key made that quietly wrong: an agent set to OpenAI would send an
 * OpenAI key to whichever host the *global* settings happened to point at,
 * and the resulting "does not recognise that model" came from a provider the
 * user had not selected — while the error named the one they had.
 *
 * Keys therefore live under `GHOSTBOT_KEY_<preset>` in the encrypted store,
 * alongside the OAuth credentials, and are resolved by preset id.
 */
import { readSecrets, upsertSecrets, removeSecrets } from './secrets-store.js';
import { fileLog } from './filelog.js';

/** The legacy single-key name, kept readable for existing installs. */
export const LEGACY_KEY = 'GHOSTBOT_API_KEY';

/**
 * Secret name for a provider's key.
 *
 * Uppercased and non-alphanumerics collapsed so a preset id like
 * `chatgpt-subscription` cannot produce an ambiguous or malformed name.
 */
export function providerSecretKey(presetId: string): string {
  return `GHOSTBOT_KEY_${presetId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function setProviderKey(userDataDir: string, presetId: string, key: string): void {
  upsertSecrets(userDataDir, [{ key: providerSecretKey(presetId), value: key }]);
  fileLog('[keys] stored key for', presetId);
}

export function clearProviderKey(userDataDir: string, presetId: string): void {
  removeSecrets(userDataDir, [providerSecretKey(presetId)]);
  fileLog('[keys] cleared key for', presetId);
}

export function hasProviderKey(userDataDir: string, presetId: string): boolean {
  const secrets = readSecrets(userDataDir);
  return Boolean(secrets[providerSecretKey(presetId)]);
}

/** Preset ids that currently have a stored key. */
export function configuredProviders(userDataDir: string): string[] {
  const secrets = readSecrets(userDataDir);
  const prefix = 'GHOSTBOT_KEY_';
  return Object.keys(secrets)
    .filter((name) => name.startsWith(prefix) && secrets[name])
    .map((name) => name.slice(prefix.length).toLowerCase());
}

/**
 * Move a legacy shared key to the provider it was actually configured for.
 *
 * Runs once at startup. The key is copied to `GHOSTBOT_KEY_<preset>` and the
 * old entry removed, so a user who set up before per-provider keys existed
 * keeps working without re-entering anything — and without their key being
 * offered to every other provider they later add.
 */
export function migrateLegacyKey(userDataDir: string, activePresetId: string | undefined): void {
  const secrets = readSecrets(userDataDir);
  const legacy = secrets[LEGACY_KEY];
  if (!legacy) return;

  // Without a known provider the key cannot be attributed to one, and
  // guessing would send it somewhere the user never chose. Leave it as the
  // documented last-resort fallback instead.
  if (!activePresetId) return;

  const target = providerSecretKey(activePresetId);
  if (!secrets[target]) {
    upsertSecrets(userDataDir, [{ key: target, value: legacy }]);
    fileLog('[keys] migrated legacy key to', activePresetId);
  }
  removeSecrets(userDataDir, [LEGACY_KEY]);
}
