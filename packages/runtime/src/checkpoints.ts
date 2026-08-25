/**
 * checkpoints.ts — a way back when a transcript is destroyed.
 *
 * Transcripts are written whole on every change, so anything that shortens
 * one loses the difference permanently. That is not hypothetical: a careless
 * cleanup during development erased a real conversation of 33 entries with
 * no way to recover it.
 *
 * Before a write that would *lose* content, the previous version is kept.
 * Restoring is then a file copy rather than an apology.
 *
 * ## Why only shrinking writes
 *
 * Streaming rewrites the transcript on every token. Checkpointing all of
 * them would mean thousands of copies per conversation and a great deal of
 * disk churn for no benefit, because a growing transcript has not lost
 * anything — the previous state is a prefix of the current one.
 *
 * Losing entries is the event worth capturing, and it is rare: a clear, a
 * rewind, a branch, or a bug. So the trigger is "this write removes
 * content", which is cheap to detect and catches every case that matters.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TranscriptEntry } from '@wispcrew/shared';
import { fileLog } from './filelog.js';

/** Directory holding checkpoints, beside the transcripts they protect. */
const CHECKPOINT_DIR = 'checkpoints';

/**
 * How many versions to keep per agent.
 *
 * Enough to survive a mistake noticed a few actions later, few enough that a
 * long conversation does not quietly consume disk. Oldest are pruned first.
 */
const MAX_PER_AGENT = 10;

export interface Checkpoint {
  agentId: string;
  file: string;
  /** When it was taken. */
  createdAt: number;
  /** How many entries it holds. */
  entries: number;
  /** What prompted it, for the UI. */
  reason: string;
}

function checkpointDir(dataDir: string): string {
  return path.join(dataDir, CHECKPOINT_DIR);
}

/**
 * Record the current transcript before it is overwritten.
 *
 * Silent on failure by design: a checkpoint is a safety net, and failing to
 * take one must never stop the write the user actually asked for.
 */
export function writeCheckpoint(
  dataDir: string,
  agentId: string,
  entries: TranscriptEntry[],
  reason: string,
): void {
  if (entries.length === 0) return;

  try {
    const dir = checkpointDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });

    // Sortable name, so pruning and listing are both a directory read.
    const file = path.join(dir, `${agentId}.${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ agentId, createdAt: Date.now(), reason, entries }, null, 2),
      { mode: 0o600 },
    );

    prune(dataDir, agentId);
    fileLog('[checkpoint] kept', String(entries.length), 'entries for', agentId, `(${reason})`);
  } catch (err) {
    fileLog('[checkpoint] failed', (err as Error).message);
  }
}

/** Drop the oldest checkpoints beyond the retention limit. */
function prune(dataDir: string, agentId: string): void {
  const all = listCheckpoints(dataDir, agentId);
  for (const stale of all.slice(MAX_PER_AGENT)) {
    try {
      fs.rmSync(stale.file, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Checkpoints for an agent, newest first. */
export function listCheckpoints(dataDir: string, agentId?: string): Checkpoint[] {
  const dir = checkpointDir(dataDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const out: Checkpoint[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    // `<agentId>.<timestamp>.json` — the id may itself contain dots, so the
    // timestamp is taken from the end rather than by splitting.
    const match = /^(.+)\.(\d+)\.json$/.exec(name);
    if (!match) continue;
    if (agentId && match[1] !== agentId) continue;

    const file = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        entries?: unknown[];
        reason?: string;
      };
      out.push({
        agentId: match[1]!,
        file,
        createdAt: Number(match[2]),
        entries: Array.isArray(parsed.entries) ? parsed.entries.length : 0,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown',
      });
    } catch {
      // A corrupt checkpoint is skipped rather than failing the listing: the
      // others are still useful.
    }
  }

  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Read a checkpoint's entries.
 *
 * Returns null rather than throwing, so a caller offering "restore" can
 * report a missing or damaged checkpoint instead of crashing on it.
 */
export function readCheckpoint(file: string): TranscriptEntry[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: TranscriptEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : null;
  } catch {
    return null;
  }
}
