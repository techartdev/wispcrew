/**
 * observation.ts — do not overwrite what you have not looked at.
 *
 * `write_file` replaces a file wholesale. If the agent has not read it, or
 * read it before something else changed it, that write silently destroys
 * content nobody reviewed.
 *
 * This is not a theoretical risk in this codebase. During development an
 * automated edit truncated three source files to zero bytes, and a cleanup
 * script destroyed a real conversation — both by writing a file whose
 * current contents had never been examined.
 *
 * The rule enforced here:
 *
 *   Replacing an existing file requires having read its current contents.
 *
 * Creating a new file is unrestricted — there is nothing to lose. Appending
 * is unrestricted — it adds without removing. Only a full replacement of
 * something that already exists has to be earned.
 *
 * ## Why a content hash and not a timestamp
 *
 * Filesystem timestamps have coarse and inconsistent resolution, and a fast
 * edit-write cycle can produce identical mtimes. A hash answers the question
 * that actually matters — "is this the same content I read?" — and is
 * immune to clock skew, timezone handling and copies that preserve mtime.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * What the agent has seen, by absolute path.
 *
 * Deliberately per-process and not persisted: it describes what *this*
 * session has observed. Carrying it across restarts would let an agent
 * overwrite a file on the strength of a read from days ago, which is the
 * situation the guard exists to prevent.
 */
const observed = new Map<string, string>();

/** Hash file contents, or null when the file cannot be read. */
function hashOf(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Record that the agent has seen a file's current contents. */
export function noteObserved(file: string, contents?: string): void {
  const hash =
    contents === undefined
      ? hashOf(file)
      : createHash('sha256').update(Buffer.from(contents, 'utf8')).digest('hex');
  if (hash) observed.set(file, hash);
}

/** Forget a file, e.g. after deleting it. */
export function forgetObserved(file: string): void {
  observed.delete(file);
}

/** Clear everything. Used when an agent's session is reset. */
export function clearObserved(): void {
  observed.clear();
}

export type WriteVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; errorCode: 'unobserved_write' | 'stale_write' };

/**
 * May this write proceed?
 *
 * Returns a verdict rather than throwing, so the caller can turn a refusal
 * into a tool result the model can act on — which is the point. The message
 * says exactly what to do: read the file, then write it.
 */
export function checkWrite(file: string): WriteVerdict {
  const current = hashOf(file);

  // Creating something new destroys nothing.
  if (current === null) return { allowed: true };

  const seen = observed.get(file);
  if (!seen) {
    return {
      allowed: false,
      errorCode: 'unobserved_write',
      reason:
        `Refusing to overwrite ${file} without reading it first. ` +
        'Read the file, then write it — a full replacement discards anything ' +
        'currently there, including changes made since this session started.',
    };
  }

  if (seen !== current) {
    return {
      allowed: false,
      errorCode: 'stale_write',
      reason:
        `${file} has changed since it was read. ` +
        'Read it again before writing, or the edit will discard whatever ' +
        'changed in the meantime.',
    };
  }

  return { allowed: true };
}

/** True when this file's current contents have been observed. */
export function hasObserved(file: string): boolean {
  const current = hashOf(file);
  if (current === null) return false;
  return observed.get(file) === current;
}
