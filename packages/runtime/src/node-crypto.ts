/**
 * node-crypto.ts — encryption at rest for hosts with no OS keychain.
 *
 * The desktop app uses Electron `safeStorage`, backed by DPAPI, Keychain or
 * libsecret. A daemon on a VPS or a Raspberry Pi usually has none of those,
 * so it needs something that is honest about what it does and does not
 * protect.
 *
 * ## What this protects against
 *
 * A key file with `0600` permissions and AES-256-GCM means secrets are not
 * sitting in readable plaintext: an accidental `cat`, a backup copied to
 * another machine, a stolen disk without the key file, or another user on a
 * multi-user box are all covered.
 *
 * ## What it does not
 *
 * **An attacker who can read files as your user can decrypt everything**,
 * because the key is a file that same user must be able to read. That is not
 * a flaw to be engineered away — without hardware or a passphrase the
 * process would have nowhere else to get the key from. `available()`
 * therefore returns **false**, so the UI can tell the truth instead of
 * showing the same reassurance an OS keychain earns.
 *
 * The alternative designs were considered and rejected:
 *
 *  - *Derive from hostname/machine-id*: obfuscation with extra steps, and it
 *    silently breaks when a VM is cloned or a hostname changes.
 *  - *Prompt for a passphrase*: defeats the point of a daemon that starts
 *    unattended at boot, which is the entire reason this exists.
 *  - *Refuse to run without a keychain*: pushes users to plaintext env vars,
 *    which is strictly worse.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SecretCrypto } from './host.js';

const KEY_FILE = 'node-key';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Distinguishes our payloads from a `safeStorage` blob, which starts "v10". */
const MAGIC = Buffer.from('gbk1');

/**
 * Load the node key, creating it on first use.
 *
 * Written with mode 0600 before any content reaches it: creating the file
 * world-readable and then tightening it leaves a window where the key is
 * exposed, which on a shared host is exactly the case this is meant to cover.
 */
function loadOrCreateKey(dataDir: string): Buffer {
  const file = path.join(dataDir, KEY_FILE);
  try {
    const existing = fs.readFileSync(file);
    if (existing.length === 32) return existing;
    // A wrong-sized key file means something else wrote here. Refuse rather
    // than overwrite: regenerating would silently destroy every stored
    // secret, and the user would see "no API key" with no explanation.
    throw new Error(
      `${file} is not a valid WispCrew node key (${existing.length} bytes). ` +
        'Move it aside if you intend to start fresh — deleting it makes existing secrets unreadable.',
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const key = randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });

  /*
   * POSIX modes are honoured on Linux and macOS. On Windows they are not:
   * `stat` reports 0666 and the file inherits the parent directory's ACL,
   * which on a shared machine can include other principals. Verified
   * directly — an inherited ACL listed several SIDs plus Administrators.
   *
   * So on Windows the mode is set for tidiness and the real protection is
   * left to the data directory's own ACL, which lives under the user profile.
   * `describe()` says "machine-local key file" rather than claiming
   * per-user protection we cannot guarantee on every platform.
   */
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort; not all filesystems support it */
  }
  return key;
}

/**
 * File-backed AES-256-GCM encryption for headless hosts.
 *
 * GCM is authenticated: a tampered payload fails to decrypt rather than
 * yielding plausible garbage that would be handed to a provider as a key.
 */
export function createNodeCrypto(dataDir: string): SecretCrypto {
  let key: Buffer | null = null;
  const getKey = () => (key ??= loadOrCreateKey(dataDir));

  return {
    // Deliberately false: this is real encryption, but it is not OS-backed,
    // and the UI must not imply that it is.
    available: () => false,

    describe: () => 'encrypted with a machine-local key file (no OS keychain on this host)',

    encrypt(plaintext: string): Buffer {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, getKey(), iv);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
    },

    decrypt(payload: Buffer): string {
      if (!payload.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error(
          'Secret store was written by a different encryption backend (an OS keychain, most likely). ' +
            'It cannot be read on this host.',
        );
      }
      const iv = payload.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
      const tag = payload.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
      const body = payload.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}
