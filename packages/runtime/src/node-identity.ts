/**
 * node-identity.ts — how a local client finds and authenticates to a daemon.
 *
 * A daemon writes a small file describing where to reach it and the token
 * required. A client on the same machine reads that file instead of being
 * configured by hand, so starting the desktop app "just connects".
 *
 * ## Why a token at all on localhost
 *
 * Because loopback is not an authorisation boundary. Every process running
 * as any user on the machine can open a local socket, and this one runs
 * shell commands. The token file is readable only by the owning user, which
 * is the actual boundary being relied on — the socket merely carries it.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ENDPOINT_FILE = 'node-endpoint.json';

export interface NodeEndpoint {
  /** Unix socket path, or Windows named pipe. */
  address: string;
  token: string;
  /** PID of the daemon, so a client can tell a stale file from a live one. */
  pid: number;
  nodeName: string;
  startedAt: number;
  /**
   * When the engine code this daemon loaded was last built.
   *
   * A daemon is long-lived by design: it survives the app quitting, which is
   * the whole point. The consequence is that it keeps running whatever code
   * it started with, so after an upgrade — or a developer rebuild — the UI
   * can be new while the engine is old.
   *
   * That is not theoretical. A shell-quoting fix was built, tested and
   * committed, and the running daemon carried on using the broken version
   * for the next hour, because nothing had told it to reload. The symptoms
   * looked like the fix had not worked.
   *
   * A client compares this against its own build stamp and restarts a
   * daemon that is older.
   */
  buildStamp?: number;
}

/**
 * When the currently loaded engine code was built.
 *
 * Uses this module's own file time: it is rebuilt whenever the runtime is,
 * needs no build step to inject a version, and is honest about what is
 * actually loaded rather than what a package.json claims.
 */
export function engineBuildStamp(): number {
  try {
    return Math.floor(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs);
  } catch {
    // Unknowable — treated as "always current" so a packaging quirk cannot
    // put a client into a restart loop.
    return 0;
  }
}

/**
 * Where the daemon listens locally.
 *
 * Windows named pipes live in a kernel namespace rather than the filesystem,
 * so the data directory is folded into the name to keep two profiles on one
 * machine from colliding.
 */
export function localAddress(dataDir: string): string {
  if (process.platform === 'win32') {
    /*
     * A digest of the whole path, not a prefix of it.
     *
     * Hex-encoding and truncating kept only the first twelve *characters* of
     * the directory, so every profile under `C:\Users\Someone\…` produced an
     * identical pipe name. Two profiles on one machine collided and the
     * second daemon died with EADDRINUSE. Observed while wiring the desktop
     * to a daemon, not theorised.
     */
    const digest = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\ghostbot-${digest}`;
  }
  return path.join(dataDir, 'node.sock');
}

export function endpointPath(dataDir: string): string {
  return path.join(dataDir, ENDPOINT_FILE);
}

/**
 * Publish this daemon's endpoint.
 *
 * Written 0600 before any content: the token is a credential, and creating
 * the file readable and then tightening it leaves a window where it is not.
 */
export function writeEndpoint(dataDir: string, endpoint: NodeEndpoint): void {
  const file = endpointPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(endpoint, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows uses ACLs inherited from the profile directory */
  }
}

export function clearEndpoint(dataDir: string): void {
  try {
    fs.rmSync(endpointPath(dataDir), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Read a published endpoint, if one looks live.
 *
 * A crashed daemon leaves its file behind, so the PID is checked. Connecting
 * to a stale address would fail with a confusing socket error; returning
 * null lets the caller simply start a daemon instead.
 */
export function readEndpoint(dataDir: string): NodeEndpoint | null {
  try {
    const raw = fs.readFileSync(endpointPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as NodeEndpoint;
    if (!parsed?.address || !parsed.token) return null;
    if (!isProcessAlive(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Is that PID still alive?
 *
 * `kill(pid, 0)` sends no signal and only tests existence. EPERM means the
 * process exists but belongs to another user — treated as alive, because the
 * alternative is stomping on a daemon that is genuinely running.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * When the process at this pid started, in epoch milliseconds.
 *
 * Returns null when it cannot be determined — no such process, no
 * permission, or an unsupported platform. Callers must treat null as "cannot
 * confirm", never as a match.
 */
export function processStartTime(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`,
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
      ).trim();
      if (!out) return null;
      const fileTime = Number(out);
      if (!Number.isFinite(fileTime)) return null;
      // Windows FILETIME counts 100ns ticks from 1601-01-01.
      return Math.round(fileTime / 10_000 - 11_644_473_600_000);
    }

    // POSIX: elapsed seconds since the process started.
    const out = execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (!out) return null;
    const elapsedSeconds = Number(out);
    if (!Number.isFinite(elapsedSeconds)) return null;
    return Date.now() - elapsedSeconds * 1000;
  } catch {
    return null;
  }
}

/**
 * Is the process at this pid still the daemon we recorded?
 *
 * A pid is not an identity. Operating systems reuse them, so an endpoint file
 * left by a daemon that died can name a pid now belonging to something else —
 * and acting on that means signalling an innocent process. Small odds per
 * launch, but the consequence is killing a stranger's work, and this codebase
 * now kills a pid read from a file when it decides a daemon is out of date.
 *
 * Comparing start times makes the pair effectively unique: a recycled pid
 * belongs to a process that started later than the one we recorded. When the
 * start time cannot be read the answer is "not ours", because declining to
 * kill is always the safer failure.
 */
export function isSameProcess(pid: number, startedAt: number | undefined): boolean {
  if (!isProcessAlive(pid)) return false;
  if (typeof startedAt !== 'number') return false;

  const actual = processStartTime(pid);
  if (actual === null) return false;

  /*
   * A minute of tolerance. `startedAt` is recorded inside the daemon once it
   * is up, so it always trails the OS value by the process's own start-up
   * time. Anything within a minute is the same launch; a reused pid is
   * separated by however long the original ran.
   */
  return Math.abs(actual - startedAt) < 60_000;
}

/** A fresh token. 32 bytes of randomness, hex-encoded. */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}
