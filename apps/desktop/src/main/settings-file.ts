/** Settings persistence for the desktop main process (userData JSON). */
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings } from './types.js';

export function settingsPath(userDataDir: string): string {
  return path.join(userDataDir, 'ghostbot-settings.json');
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

export function writeSettings(userDataDir: string, patch: Partial<AppSettings>): AppSettings {
  const current = readSettings(userDataDir);
  const next = { ...current, ...patch };
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
