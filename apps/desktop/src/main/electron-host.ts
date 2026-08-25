/**
 * electron-host.ts — wires the headless engine into the desktop app.
 *
 * `@wispcrew/runtime` has no idea it is running inside Electron. This module
 * is the only place that connects the two: it tells the engine where data
 * lives and hands it the OS keychain to encrypt secrets with.
 *
 * The equivalent file for `wispcrew serve` supplies a config directory and a
 * key-file cipher instead. Everything above this line is identical on both,
 * which is the point of the split.
 */
import { app, safeStorage } from 'electron';
import os from 'node:os';
import type { HostEnvironment, SecretCrypto } from '@wispcrew/runtime';

/**
 * Electron's `safeStorage`, backed by DPAPI on Windows, Keychain on macOS and
 * libsecret/kwallet on Linux.
 *
 * `available()` is asked, not assumed: a Linux session with no keyring
 * reports false, and the UI then says secrets are unprotected rather than
 * implying a keychain that is not there.
 */
function electronCrypto(): SecretCrypto {
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (payload) => safeStorage.decryptString(payload),
    describe: () => {
      switch (process.platform) {
        case 'win32':
          return 'OS keychain (Windows DPAPI)';
        case 'darwin':
          return 'OS keychain (macOS Keychain)';
        default:
          return 'OS keychain (libsecret)';
      }
    },
  };
}

/**
 * Build the host for this Electron process.
 *
 * `dataDir` is passed in rather than read here because the desktop app
 * migrates its user-data location on startup, and the engine must be given
 * the post-migration directory — not the one that existed a moment earlier.
 */
export function electronHost(dataDir: string): HostEnvironment {
  return {
    dataDir,
    defaultWorkspaceRoot: app.getPath('documents'),
    crypto: electronCrypto(),
    nodeName: os.hostname(),
  };
}
