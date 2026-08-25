/**
 * secrets-store.ts — encrypted-at-rest storage for provider API keys.
 *
 * Encryption is supplied by the host, because the right answer differs by
 * environment: the desktop app uses Electron `safeStorage` (DPAPI, Keychain,
 * libsecret), while a headless daemon on a VPS has no keychain and uses a
 * machine-local key file instead. Ciphertext lives in
 * `<dataDir>/ghostbot-secrets.enc`.
 *
 * Whichever backend is in use reports `available()` truthfully, and that is
 * what reaches the UI — a keyless host says so rather than implying the same
 * protection an OS keychain earns.
 *
 * Migration: earlier builds stored secrets as plaintext JSON in
 * `ghostbot-secrets.json`. On first access we transparently import that
 * file, rewrite it encrypted, and delete the plaintext original.
 *
 * Fallback: if encryption is unavailable entirely, we fall back to the
 * plaintext file so the app keeps working, and report
 * `isPersistent`/`isEncrypted` honestly rather than pretending otherwise.
 */
import { host } from './host.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileLog } from './filelog.js';

export type SecretMap = Record<string, string>;

const ENC_FILE = 'ghostbot-secrets.enc';
const PLAIN_FILE = 'ghostbot-secrets.json';

function encPath(userDataDir: string): string {
  return path.join(userDataDir, ENC_FILE);
}
function plainPath(userDataDir: string): string {
  return path.join(userDataDir, PLAIN_FILE);
}

/** True when the OS can actually encrypt (keychain/DPAPI available). */
export function isEncryptionAvailable(): boolean {
  try {
    return host().crypto.available();
  } catch {
    return false;
  }
}

function readPlainFile(file: string): SecretMap {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM-tolerant
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Keep only string values; ignore anything malformed.
    const out: SecretMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Read all secrets, migrating a legacy plaintext file when present. */
export function readSecrets(userDataDir: string): SecretMap {
  const encrypted = encPath(userDataDir);
  const plain = plainPath(userDataDir);

  // 1. Preferred: encrypted store.
  if (fs.existsSync(encrypted) && isEncryptionAvailable()) {
    try {
      const buf = fs.readFileSync(encrypted);
      const json = host().crypto.decrypt(buf);
      const parsed = JSON.parse(json) as SecretMap;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      // A keychain change (or copying userData between machines) makes the
      // blob undecryptable. Don't wedge the app — report and start clean.
      fileLog('[secrets] decrypt failed', (err as Error).message);
      return {};
    }
  }

  // 2. Legacy plaintext → migrate to encrypted on first read.
  if (fs.existsSync(plain)) {
    const store = readPlainFile(plain);
    if (isEncryptionAvailable()) {
      const migrated = writeSecrets(userDataDir, store);
      if (migrated) {
        try {
          fs.rmSync(plain);
          fileLog('[secrets] migrated plaintext → encrypted, removed', PLAIN_FILE);
        } catch (err) {
          fileLog('[secrets] migration cleanup failed', (err as Error).message);
        }
      }
    }
    return store;
  }

  return {};
}

/**
 * Persist the whole secret map. Returns true when written encrypted,
 * false when it had to fall back to plaintext (or failed).
 */
export function writeSecrets(userDataDir: string, store: SecretMap): boolean {
  const json = JSON.stringify(store, null, 2);

  if (isEncryptionAvailable()) {
    try {
      const buf = host().crypto.encrypt(json);
      fs.writeFileSync(encPath(userDataDir), buf);
      return true;
    } catch (err) {
      fileLog('[secrets] encrypt failed, falling back to plaintext', (err as Error).message);
    }
  }

  // Fallback: plaintext, restricted to the owner where the OS supports it.
  try {
    fs.writeFileSync(plainPath(userDataDir), json, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    fileLog('[secrets] save failed', (err as Error).message);
  }
  return false;
}

/** Read a single secret by key. */
export function getSecret(userDataDir: string, key: string): string | undefined {
  return readSecrets(userDataDir)[key];
}

/** Insert/replace entries; an empty or undefined value deletes the key. */
export function upsertSecrets(
  userDataDir: string,
  entries: Array<{ key?: string; value?: string }>,
): void {
  const store = readSecrets(userDataDir);
  for (const e of entries) {
    if (!e.key) continue;
    if (e.value === undefined || e.value === '') delete store[e.key];
    else store[e.key] = e.value;
  }
  writeSecrets(userDataDir, store);
}

/** Delete the given keys. */
export function removeSecrets(userDataDir: string, keys: string[]): void {
  const store = readSecrets(userDataDir);
  for (const k of keys) delete store[k];
  writeSecrets(userDataDir, store);
}

/** Key names only — never values (used by the UI's secrets manager list). */
export function listSecretKeys(userDataDir: string): string[] {
  return Object.keys(readSecrets(userDataDir));
}
