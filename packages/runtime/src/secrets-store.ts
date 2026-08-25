/**
 * secrets-store.ts — encrypted-at-rest storage for provider API keys.
 *
 * Encryption is supplied by the host, because the right answer differs by
 * environment: the desktop app uses Electron `safeStorage` (DPAPI, Keychain,
 * libsecret), while a headless daemon on a VPS has no keychain and uses a
 * machine-local key file instead. Ciphertext lives in
 * `<dataDir>/wispcrew-secrets.enc`.
 *
 * Whichever backend is in use reports `available()` truthfully, and that is
 * what reaches the UI — a keyless host says so rather than implying the same
 * protection an OS keychain earns.
 *
 * Migration: earlier builds stored secrets as plaintext JSON in
 * `wispcrew-secrets.json`. On first access we transparently import that
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
import { createNodeCrypto } from './node-crypto.js';

export type SecretMap = Record<string, string>;

const ENC_FILE = 'wispcrew-secrets.enc';
const PLAIN_FILE = 'wispcrew-secrets.json';
/**
 * A copy the desktop app writes for a background daemon.
 *
 * The primary store is encrypted with whatever backend wrote it — usually
 * the OS keychain, which a detached daemon cannot open. Rather than have the
 * daemon silently see zero providers, the desktop re-encrypts the same
 * secrets with the machine-local key file and leaves them here.
 */
const NODE_FILE = 'wispcrew-secrets-node.enc';

function encPath(userDataDir: string): string {
  return path.join(userDataDir, ENC_FILE);
}
function nodePath(userDataDir: string): string {
  return path.join(userDataDir, NODE_FILE);
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
/**
 * Rename keys that carried the old product name.
 *
 * Entries are stored under names like `GHOSTBOT_KEY_NVIDIA` and
 * `GHOSTBOT_OAUTH_CHATGPT`. Nothing looks for those any more, so without
 * this a migrated profile has the user's credentials on disk and reports
 * having none — which is exactly the maddening failure the store's own
 * comments warn about.
 *
 * Applied on read rather than by rewriting the file: the blob may not be
 * writable by this process, and a read-time mapping cannot corrupt anything.
 */
function withCurrentNames(secrets: SecretMap): SecretMap {
  const out: SecretMap = {};
  for (const [key, value] of Object.entries(secrets)) {
    const renamed = key.startsWith('GHOSTBOT_')
      ? `WISPCREW_${key.slice('GHOSTBOT_'.length)}`
      : key;
    // A current entry always wins over a legacy one with the same meaning.
    if (!(renamed in out) || key === renamed) out[renamed] = value;
  }
  return out;
}

export function readSecrets(userDataDir: string): SecretMap {
  const encrypted = encPath(userDataDir);
  const plain = plainPath(userDataDir);

  /*
   * 1. Preferred: encrypted store.
   *
   * Attempted whenever the file exists, NOT only when `available()` is true.
   * `available()` reports whether an OS keychain is backing us, which is a
   * different question from whether this blob can be decrypted — the
   * headless backend deliberately answers false while still being perfectly
   * able to read its own ciphertext. Gating on it made a daemon silently see
   * zero providers.
   */
  if (fs.existsSync(encrypted)) {
    try {
      const buf = fs.readFileSync(encrypted);
      const json = host().crypto.decrypt(buf);
      const parsed = JSON.parse(json) as SecretMap;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      /*
       * Undecryptable, which has one common and important cause: this store
       * was written by a *different backend* on the same machine — the
       * desktop app using the OS keychain, now being read by a daemon that
       * has none (or the reverse).
       *
       * Starting clean is right — wedging the app helps nobody — but it must
       * be loud. Silently reporting "no API key" for providers the user
       * definitely configured is a maddening thing to debug.
       */
      /*
       * Before giving up: the desktop app may have left a copy encrypted
       * for exactly this situation. Trying it here is what lets a detached
       * daemon use the providers the user configured in the UI, instead of
       * reporting no keys for a profile that plainly has them.
       */
      const shared = nodePath(userDataDir);
      if (fs.existsSync(shared)) {
        /*
         * Try the machine-local key file, not this host's crypto.
         *
         * The shared copy is always written with the key-file backend, so
         * that is what reads it. Using `host().crypto` here meant the
         * DESKTOP could never open it — DPAPI cannot decrypt a `gbk1` blob —
         * and the fallback only ever worked in the direction it was written
         * for.
         *
         * That mattered the moment the app was renamed: Electron scopes
         * `safeStorage` by application name, so every DPAPI blob written as
         * "GhostBot" became unreadable as "WispCrew". The user's API keys
         * were still on disk in the shared copy, and still unreachable.
         */
        for (const attempt of [createNodeCrypto(userDataDir), host().crypto]) {
          try {
            const json = attempt.decrypt(fs.readFileSync(shared));
            const parsed = JSON.parse(json) as SecretMap;
            if (parsed && typeof parsed === 'object') {
              fileLog('[secrets] recovered from the machine-local copy');
              return withCurrentNames(parsed);
            }
          } catch {
            /* try the next backend */
          }
        }
        fileLog('[secrets] the shared copy could not be read either');
      }

      fileLog('[secrets] decrypt failed', (err as Error).message);
      fileLog(
        '[secrets] the store at',
        encrypted,
        'cannot be read with this backend:',
        host().crypto.describe(),
      );
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

  /*
   * Always attempt encryption, regardless of `isEncryptionAvailable()`.
   *
   * That function answers "is an OS keychain backing us", which is a
   * *different question* from "can this backend encrypt". The headless
   * backend deliberately answers false — it is honest that a key file is
   * weaker than a keychain — while being perfectly able to encrypt.
   *
   * Gating on it meant a daemon wrote every API key to disk in PLAINTEXT.
   * The same mistake was already fixed in `readSecrets`; this is its twin,
   * and the more dangerous of the two.
   *
   * Plaintext remains only as a last resort, when encryption genuinely
   * throws, and `isPersistent`/`isEncrypted` report that honestly.
   */
  try {
    const buf = host().crypto.encrypt(json);
    fs.writeFileSync(encPath(userDataDir), buf, { mode: 0o600 });
    // A previous plaintext fallback must not linger with stale keys in it.
    try {
      fs.rmSync(plainPath(userDataDir), { force: true });
    } catch {
      /* nothing to clean up */
    }
    return true;
  } catch (err) {
    fileLog('[secrets] encrypt failed, falling back to plaintext', (err as Error).message);
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
