/**
 * retention.ts — keeping tool output usable without throwing it away.
 *
 * A tool can produce far more text than belongs in a model's context: a
 * build log, a large file, a verbose test run. Something has to give.
 *
 * The previous approach cut at 200 KB and appended "[stdout truncated]".
 * That is the worst of both: the model is told almost nothing about what it
 * lost, and the user debugging a long build has no way to see the rest at
 * all — the bytes were simply dropped.
 *
 * Instead, oversized output is written to a spill file and replaced with a
 * bounded preview plus a plain statement of what was kept and what was
 * omitted. The model can then decide to read the file; the user can open it.
 * Nothing is destroyed.
 *
 * ## Why the head *and* the tail
 *
 * The interesting parts of a long output are usually at the ends: what a
 * command set out to do, and how it finished. The middle of a build log is
 * the least informative part, so that is what gets elided.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Above this, output is spilled rather than inlined. */
export const DEFAULT_LIMIT = 32_000;

/** How much of the head and tail to keep when spilling. */
const HEAD_SHARE = 0.6;

export interface RetainedText {
  /** What to show the model. */
  text: string;
  /** Where the whole output lives, when it was spilled. */
  spillFile?: string;
  /** Total size of the original, in characters. */
  originalLength: number;
  omitted: number;
}

/**
 * Where spill files live.
 *
 * Under the OS temp directory by default: this is diagnostic output, not
 * user data, and it should not accumulate in a profile forever. A caller
 * with somewhere better can say so.
 */
export function defaultSpillDir(): string {
  return path.join(os.tmpdir(), 'ghostbot-output');
}

/**
 * Bound a piece of text, spilling the remainder to a file.
 *
 * Writing the spill file is best-effort: if it fails the text is still
 * bounded and the notice says the full output was unavailable, rather than
 * failing the tool call over a temp-file problem.
 */
export function retainText(
  raw: string,
  options: { limit?: number; spillDir?: string; label?: string } = {},
): RetainedText {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (raw.length <= limit) {
    return { text: raw, originalLength: raw.length, omitted: 0 };
  }

  const headSize = Math.floor(limit * HEAD_SHARE);
  const tailSize = limit - headSize;
  const head = raw.slice(0, headSize);
  const tail = raw.slice(raw.length - tailSize);
  const omitted = raw.length - head.length - tail.length;

  let spillFile: string | undefined;
  try {
    const dir = options.spillDir ?? defaultSpillDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = `${options.label ?? 'output'}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.txt`;
    spillFile = path.join(dir, name);
    fs.writeFileSync(spillFile, raw, 'utf8');
  } catch {
    spillFile = undefined;
  }

  /*
   * The notice is deliberately factual and addressed to the reader, not a
   * warning. It says how much was kept, how much was not, and where the rest
   * is — everything needed to decide whether to go and look.
   */
  const notice = spillFile
    ? `\n\n[${omitted.toLocaleString()} characters omitted from the middle. ` +
      `Full output (${raw.length.toLocaleString()} characters): ${spillFile}]\n\n`
    : `\n\n[${omitted.toLocaleString()} characters omitted from the middle. ` +
      'The full output could not be saved.]\n\n';

  return {
    text: head + notice + tail,
    spillFile,
    originalLength: raw.length,
    omitted,
  };
}

/**
 * Remove spill files older than a day.
 *
 * Called opportunistically rather than scheduled: these are diagnostic
 * scratch files, and a cleanup that never runs is better than a timer that
 * keeps a process awake.
 */
export function pruneSpillFiles(dir = defaultSpillDir(), maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {
        /* raced with another cleanup */
      }
    }
  } catch {
    /* nothing to prune */
  }
}
