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
/**
 * Parse `ps -o etime=` output into seconds.
 *
 * The format is `[[dd-]hh:]mm:ss`, so the pieces are read from the right:
 * seconds and minutes always present, hours and days only for long-running
 * processes. Returns null for anything unrecognised rather than guessing —
 * a wrong number here would let a recycled pid pass as the original.
 */
export function parseElapsed(text: string): number | null {
  const trimmed = text.trim();
  const [dayPart, clockPart] = trimmed.includes('-')
    ? [trimmed.slice(0, trimmed.indexOf('-')), trimmed.slice(trimmed.indexOf('-') + 1)]
    : ['0', trimmed];

  const days = Number(dayPart);
  if (!Number.isFinite(days)) return null;

  const parts = clockPart.split(':').map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) {
    return null;
  }

  const seconds = parts.pop()!;
  const minutes = parts.pop()!;
  const hours = parts.pop() ?? 0;

  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/** Run a command, returning null instead of throwing when it is unavailable. */
function tryExec(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function processStartTime(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      /*
       * Two ways to ask, because one is not reliable enough.
       *
       * `Get-Process().StartTime` returns nothing on some Windows hosts —
       * measured on a CI runner, where it produced an empty string for the
       * process asking about itself. The property needs permissions a
       * constrained environment may not grant, and it fails silently.
       *
       * WMIC reads the same value from the process table without that
       * requirement. It is deprecated but still present, so it is tried
       * first and PowerShell remains the fallback for hosts where it has
       * been removed.
       */
      const wmic = tryExec('wmic', [
        'process',
        'where',
        `ProcessId=${pid}`,
        'get',
        'CreationDate',
        '/value',
      ]);

      /*
       * `CreationDate=20260825195922.231723+180`
       *
       * Local time, then the minutes east of UTC. The trailing offset is
       * used rather than the machine's current one: they differ across a
       * daylight-saving boundary, which would shift a start time by an hour
       * and make a daemon look like a stranger — a rare bug that would
       * appear twice a year and be very hard to place.
       */
      const stamp = /CreationDate=(\d{14})\.\d+([+-]\d+)/.exec(wmic ?? '');
      if (stamp) {
        const s = stamp[1]!;
        const offsetMinutes = Number(stamp[2]);
        const asUtc = Date.UTC(
          Number(s.slice(0, 4)),
          Number(s.slice(4, 6)) - 1,
          Number(s.slice(6, 8)),
          Number(s.slice(8, 10)),
          Number(s.slice(10, 12)),
          Number(s.slice(12, 14)),
        );
        return Number.isFinite(offsetMinutes) ? asUtc - offsetMinutes * 60_000 : null;
      }

      const out = tryExec('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`,
      ]);
      if (!out) return null;
      const fileTime = Number(out.trim());
      if (!Number.isFinite(fileTime)) return null;
      // Windows FILETIME counts 100ns ticks from 1601-01-01.
      return Math.round(fileTime / 10_000 - 11_644_473_600_000);
    }

    /*
     * POSIX: elapsed time since the process started.
     *
     * `etimes` — plain seconds, trivial to parse — is a Linux extension.
     * macOS `ps` rejects it and prints nothing, so every identity check
     * silently failed there and the daemon would never be recognised as its
     * own. Caught by CI on macOS, not by reading man pages.
     *
     * `etime` is POSIX-standard and present everywhere, at the cost of
     * parsing a formatted duration.
     */
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (!out) return null;

    const elapsedSeconds = parseElapsed(out);
    if (elapsedSeconds === null) return null;
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
