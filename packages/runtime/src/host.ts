/**
 * host.ts — the few things the engine cannot decide for itself.
 *
 * Everything else in this package is plain Node. Two capabilities genuinely
 * differ by environment, so they are injected rather than imported:
 *
 *  - **Where durable state lives.** Electron knows `app.getPath('userData')`;
 *    a daemon on a VPS uses `$XDG_CONFIG_HOME` or an explicit `--data-dir`.
 *  - **How secrets are encrypted at rest.** The desktop has an OS keychain
 *    through `safeStorage`; a headless Linux box usually has no keychain at
 *    all, and pretending otherwise would either crash or silently store keys
 *    in plaintext.
 *
 * Injecting them keeps the engine honest about what it is running on. The
 * alternative — importing Electron and guarding every call — is how a
 * "headless" runtime quietly acquires a GUI dependency.
 */

/**
 * Encrypts secrets at rest.
 *
 * `available` is deliberately part of the contract: the UI tells the user
 * whether their keys are protected by the OS or merely obfuscated, and that
 * claim must come from the implementation actually in use rather than an
 * assumption about the platform.
 */
export interface SecretCrypto {
  /** True when this is real OS-backed encryption, not a fallback. */
  available(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(payload: Buffer): string;
  /**
   * Short description for the UI and logs, e.g. "OS keychain (DPAPI)" or
   * "machine-bound key file". Shown verbatim, so it must be truthful.
   */
  describe(): string;
}

/** What the engine needs from whatever is hosting it. */
export interface HostEnvironment {
  /** Directory for agents, transcripts, settings and secrets. */
  dataDir: string;
  /** Default workspace root for agents that do not set their own. */
  defaultWorkspaceRoot: string;
  crypto: SecretCrypto;
  /**
   * Human-readable name for this node, shown when several are paired.
   * Defaults to the machine hostname.
   */
  nodeName: string;
}

let current: HostEnvironment | null = null;

/**
 * Install the host environment. Must be called once before anything else in
 * this package touches disk.
 */
export function setHost(host: HostEnvironment): void {
  current = host;
}

/**
 * The active host.
 *
 * Throws rather than falling back to a default. A silent default would put
 * a user's agents and keys somewhere they never chose — most likely the
 * process working directory — and they would only find out later.
 */
export function host(): HostEnvironment {
  if (!current) {
    throw new Error(
      'GhostBot runtime used before setHost(): the engine does not guess where to store data.',
    );
  }
  return current;
}

export function hostInstalled(): boolean {
  return current !== null;
}
