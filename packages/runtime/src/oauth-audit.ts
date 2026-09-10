/**
 * oauth-audit.ts — a written record of every refresh, so the next incident
 * is read rather than guessed.
 *
 * This exists because of how the last one went. A turn died with "OAuth
 * access token has been revoked" and recovered on its own. Four rounds of
 * investigation followed, proposing in turn: a cross-process race on the
 * shared secrets file, then the VS Code extension competing for the same
 * rotating token, then a stale daemon. Every one of those was plausible.
 * None was checkable, because the only trace of a refresh was a `fileLog`
 * call — and `fileLog` writes nothing unless that env var is set, which
 * nothing sets. The evidence had never been recorded.
 *
 * So this writes unconditionally, to a fixed path in the data directory.
 *
 * ## What it deliberately does NOT contain
 *
 * No access token, no refresh token, no authorization code. A credential is
 * identified by a short SHA-256 prefix of the refresh token, which is enough
 * to answer the question that actually matters — "did two processes hold the
 * same credential, and did one replace the other's?" — while being useless
 * to anyone who reads the file. The fingerprint changes when the token
 * rotates, which is precisely the signal a rotation race would produce.
 *
 * The PID and the process role are recorded for the same reason: the race
 * hypothesis was untestable without knowing who was asking.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** One line per event; the file is capped and trimmed from the front. */
const FILE = 'oauth-audit.jsonl';

/**
 * Roughly a thousand events. A refresh happens about hourly per vendor, so
 * this is months of history — long enough that an incident is still in the
 * file when someone gets round to looking at it.
 */
const MAX_BYTES = 256 * 1024;

export type OAuthEvent =
  /** A refresh was attempted because the credential was due. */
  | 'refresh-started'
  /** New tokens stored. */
  | 'refresh-succeeded'
  /** The server rejected the grant; the credential was cleared. */
  | 'refresh-rejected'
  /** The attempt failed for a reason that says nothing about the token. */
  | 'refresh-failed'
  /** A queued caller reused a token another refresh had just stored. */
  | 'refresh-coalesced'
  /** The user signed in or out by hand. */
  | 'signed-in'
  | 'signed-out';

export interface OAuthAuditFields {
  /** SHA-256 prefix of the refresh token — identity without the secret. */
  credential?: string;
  /**
   * The fingerprint the credential became, on a successful rotation.
   *
   * The pair is what makes a race provable: two `refresh-succeeded` entries
   * from the same `credential` to different `rotatedTo` values is one token
   * spent twice, which is exactly the failure that was hypothesised here and
   * could not be checked.
   */
  rotatedTo?: string;
  /** Where the new credential's access token expires, epoch ms. */
  expires?: number;
  /** HTTP status, when the event came from a response. */
  status?: number;
  /** The failure text, already free of tokens. */
  message?: string;
  /** Whether this event caused the credential to be discarded. */
  signedOut?: boolean;
}

/**
 * Identify a credential without storing it.
 *
 * Twelve hex characters: collision-proof for the handful of credentials one
 * machine holds, and far too short to attack the token it derives from.
 */
export function credentialFingerprint(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/**
 * Which process this is, in words.
 *
 * The whole cross-process question is "who else was refreshing", and a bare
 * PID does not answer it on a machine where the daemon, the desktop and a
 * CLI all run the same binary.
 */
function role(): string {
  const argv = process.argv.join(' ');
  if (argv.includes('serve')) return 'daemon';
  if (process.env.ELECTRON_RUN_AS_NODE) return 'electron-node';
  if (process.versions.electron) return 'desktop';
  return 'node';
}

let dir: string | null = null;

/** Told where to write. Without this the audit is silently disabled. */
export function initOAuthAudit(dataDir: string): void {
  dir = dataDir;
}

/**
 * Record one event.
 *
 * Never throws: an audit failure must not break a sign-in. A dropped line is
 * worse than nothing only if it is mistaken for evidence of absence, which
 * is why the reader below reports the file's own size and age.
 */
export function auditOAuth(
  event: OAuthEvent,
  vendor: string,
  fields: OAuthAuditFields = {},
): void {
  if (!dir) return;
  try {
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        event,
        vendor,
        pid: process.pid,
        role: role(),
        ...fields,
      }) + '\n';

    const file = path.join(dir, FILE);

    /*
     * Trim from the front when it grows, rather than truncating on start.
     * A file that resets every launch loses exactly the history an incident
     * spanning a restart needs — and this incident did span one.
     */
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        const kept = fs.readFileSync(file, 'utf8').split('\n').slice(-500).join('\n');
        fs.writeFileSync(file, kept);
      }
    } catch {
      /* no file yet */
    }

    fs.appendFileSync(file, line);
  } catch {
    /* auditing must never break the thing it observes */
  }
}

/** Read the log back, newest last. For diagnosis, not for the UI. */
export function readOAuthAudit(dataDir: string, limit = 200): OAuthAuditEntry[] {
  try {
    return fs
      .readFileSync(path.join(dataDir, FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l) as OAuthAuditEntry);
  } catch {
    return [];
  }
}

export interface OAuthAuditEntry extends OAuthAuditFields {
  at: string;
  event: OAuthEvent;
  vendor: string;
  pid: number;
  role: string;
}
