/** Settings persistence for the desktop main process (userData JSON). */
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings } from './types.js';

export function settingsPath(userDataDir: string): string {
  return path.join(userDataDir, 'wispcrew-settings.json');
}

export function readSettings(userDataDir: string, fallback: AppSettings = {}): AppSettings {
  try {
    let raw = fs.readFileSync(settingsPath(userDataDir), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip UTF-8 BOM
    const parsed = JSON.parse(raw) as AppSettings;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

/**
 * Fields that must never reach this file, which is plaintext JSON.
 *
 * Hard rule 5 says any path accepting a credential routes it through
 * `upsertSecrets`. That was a convention every call site had to remember,
 * and one did not: the node's `saveSettings` destructured `apiKey` out and
 * wrote everything else verbatim, so a Telegram bot token sent by the
 * desktop landed here in the clear. Measured on a real profile — 46
 * characters of live credential, in a file somebody might reasonably paste
 * into a bug report.
 *
 * A convention that must be remembered at every call site is not a rule, it
 * is a hope. This is the choke point, so the rule lives here.
 */
const CREDENTIAL_FIELDS = ['apiKey', 'telegramToken'] as const;

/**
 * Fields the settings VIEW adds, which are answers rather than settings.
 *
 * `getSettings` decorates its reply with `hasApiKey`, `isEncrypted` and
 * `encryptionDescription`. A caller that hands the whole object back to
 * `saveSettings` persists them, and they then shadow the real answer on the
 * next read. All three were sitting in that same profile.
 */
const DERIVED_FIELDS = ['hasApiKey', 'isEncrypted', 'encryptionDescription'] as const;

export function writeSettings(userDataDir: string, patch: Partial<AppSettings>): AppSettings {
  /*
   * Refused loudly, never stripped quietly.
   *
   * Silently dropping a credential shipped once on the `configureNode` path
   * and cost a day: the call reported success, the node stored nothing, and
   * a remote agent produced empty turns with no error anywhere. A throw
   * names the field, and the caller has to deal with it.
   */
  for (const field of CREDENTIAL_FIELDS) {
    if ((patch as Record<string, unknown>)[field] !== undefined) {
      throw new Error(
        `writeSettings cannot store "${field}": the settings file is plaintext. ` +
          'Route it through upsertSecrets.',
      );
    }
  }

  const current = readSettings(userDataDir);
  const next = { ...current, ...patch };

  /*
   * Derived answers are dropped rather than refused: handing back the
   * object you were given is a reasonable thing to do, and these are merely
   * wrong to persist rather than dangerous. Dropping them here also cleans
   * a profile that already has them.
   */
  for (const field of DERIVED_FIELDS) delete (next as Record<string, unknown>)[field];
  // An explicit `undefined` in the patch means "remove this field", not
  // "leave it alone" — spread keeps the key with an undefined value, which
  // would otherwise let a stale plaintext apiKey survive migration to the
  // encrypted secrets store.
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (next as Record<string, unknown>)[k];
  }
  try {
    fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('failed to save settings', err);
  }
  return next;
}
