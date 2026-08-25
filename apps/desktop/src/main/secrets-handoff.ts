/**
 * secrets-handoff.ts — let a background daemon read this profile's keys.
 *
 * The desktop encrypts secrets with the OS keychain. A daemon spawned as a
 * background process cannot open that keychain, so it would start healthy,
 * see zero providers, and fail every routine with "needs an API key" for
 * providers plainly configured in the UI.
 *
 * The fix is to write a second copy that the daemon *can* read, protected by
 * the machine-local key file rather than the keychain.
 *
 * ## The tradeoff, stated plainly
 *
 * This lowers the protection on those keys. Keychain-encrypted secrets
 * require the OS to unlock them; key-file-encrypted secrets can be read by
 * anything running as your user. That is a real reduction, and the UI says
 * so rather than quietly making the change.
 *
 * It is still the right default here:
 *
 *  - The alternative is asking a user who has already configured the app to
 *    enter every key a second time, for a reason they cannot see.
 *  - Any process running as your user could already read the *plaintext*
 *    keys out of the running app's memory, or simply drive the app's own
 *    IPC. The keychain protects against offline disk access and other
 *    users, both of which the 0600 key file also covers.
 *
 * What it must never do is happen silently or automatically for a remote
 * node. Keys are copied only into the same profile directory on the same
 * machine — never transported over a network.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createNodeCrypto,
  fileLog,
  readSecrets,
  type SecretCrypto,
} from '@ghostbot/runtime';

/** Where the daemon-readable copy lives, beside the keychain-encrypted one. */
const DAEMON_SECRETS = 'ghostbot-secrets-node.enc';

export function daemonSecretsPath(dataDir: string): string {
  return path.join(dataDir, DAEMON_SECRETS);
}

/**
 * Has a daemon-readable copy already been written for the current secrets?
 *
 * Compared by content rather than by existence: a user who adds a provider
 * in the UI must have that key reach the daemon too, and a stale copy would
 * silently strand the new provider.
 */
export function handoffIsCurrent(dataDir: string, crypto: SecretCrypto): boolean {
  const file = daemonSecretsPath(dataDir);
  if (!fs.existsSync(file)) return false;
  try {
    const existing = crypto.decrypt(fs.readFileSync(file));
    const current = JSON.stringify(readSecrets(dataDir));
    return existing === current;
  } catch {
    return false;
  }
}

/**
 * Write the daemon-readable copy of this profile's secrets.
 *
 * Returns the number of credentials shared, so the caller can log or show
 * it. Writing nothing when there are no secrets avoids creating a file that
 * implies keys exist when none do.
 */
export function writeDaemonSecrets(dataDir: string): number {
  const secrets = readSecrets(dataDir);
  const count = Object.keys(secrets).length;
  if (count === 0) return 0;

  const crypto = createNodeCrypto(dataDir);
  const file = daemonSecretsPath(dataDir);
  const tmp = `${file}.tmp`;

  // Atomic: a half-written secrets file would leave the daemon unable to
  // decrypt anything, which looks identical to having no keys at all.
  fs.writeFileSync(tmp, crypto.encrypt(JSON.stringify(secrets)), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows relies on the profile directory's ACL */
  }

  fileLog('[handoff] shared', String(count), 'credential(s) with the local daemon');
  return count;
}

/**
 * Remove the daemon-readable copy.
 *
 * Offered so a user can revoke the lowered protection without hunting for
 * the file. The daemon then loses provider access on its next read, which is
 * the intended effect.
 */
export function clearDaemonSecrets(dataDir: string): void {
  try {
    fs.rmSync(daemonSecretsPath(dataDir), { force: true });
    fileLog('[handoff] cleared daemon-readable secrets');
  } catch {
    /* already gone */
  }
}
