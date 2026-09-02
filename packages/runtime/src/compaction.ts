/**
 * compaction.ts — making room without losing the thread.
 *
 * The whole transcript is sent on every turn, so a conversation that goes
 * anywhere eventually stops working. Trimming the oldest messages is the
 * obvious fix and the wrong one: what falls off the front of a long project
 * conversation is exactly what a person put there first — the goal, the
 * constraints, the decisions everything since has been built on. An agent
 * that silently forgets those is worse than one that admits it is full.
 *
 * So: the recent turns are kept EXACTLY as they are, and everything before
 * them is replaced by a summary the agent writes itself.
 *
 * ## Three things that make this safe rather than clever
 *
 * **A checkpoint is written first.** Compaction is a destructive edit to
 * somebody's conversation. The previous version goes to the same store the
 * History panel already reads, labelled so it is obvious which one it is, so
 * the answer to "that summary lost something important" is one click and not
 * an apology.
 *
 * **The seam is visible.** A conversation that quietly changed shape reads
 * as an agent that has started forgetting things. The transcript keeps a
 * marked entry saying what happened and how much it covered.
 *
 * **A tool call and its result are never separated.** Providers reject a
 * conversation where an assistant tool call has no matching result, so a
 * split point in the middle of a pair does not save space — it makes every
 * subsequent turn fail with a validation error that names nothing useful.
 */
import type { TranscriptEntry } from '@wispcrew/shared';
import { writeCheckpoint } from './checkpoints.js';
import { getConversation } from './conversations.js';
import { host } from './host.js';
import * as store from './store.js';
import { pushTranscript } from './transcript.js';

/** How the summary is asked for. Supplied by the engine, which owns models. */
export type Summariser = (
  agentId: string,
  conversationText: string,
) => Promise<string>;

let summarise: Summariser | undefined;

/**
 * Installed by the engine.
 *
 * A hook rather than an import because the summary is produced by the
 * agent's own model, and reaching the provider means resolving credentials,
 * presets and OAuth — all of which live in `engine.ts`, which imports this.
 */
export function setSummariser(fn: Summariser): void {
  summarise = fn;
}

export interface CompactionResult {
  ok: boolean;
  /** Why not, when `ok` is false — shown to the user verbatim. */
  reason?: string;
  /** How many entries the summary replaced. */
  replaced?: number;
  /** How many were kept exactly as they were. */
  kept?: number;
}

/**
 * How much of the tail to keep verbatim.
 *
 * Deliberately generous. The recent turns are where the current task lives,
 * and a summary of the last ten minutes is far less useful than the ten
 * minutes themselves — the point of compaction is to reclaim the long tail,
 * not to save the maximum possible.
 */
const KEEP_RECENT_ENTRIES = 20;

/**
 * Below this there is nothing worth doing.
 *
 * Compacting a short conversation spends a model call to replace text with
 * a summary of similar length, and loses detail for nothing.
 */
const MIN_ENTRIES_TO_COMPACT = 30;

/**
 * Choose a split point that does not break a tool call from its result.
 *
 * Walks BACKWARDS from the proposed boundary while the entry at it is a
 * tool call, so the pair travels together into the kept half. Returns the
 * index of the first entry to keep.
 */
export function splitPoint(entries: TranscriptEntry[], keepRecent: number): number {
  let idx = Math.max(entries.length - keepRecent, 0);

  /*
   * A `tool-call` entry becomes TWO model messages: the assistant's request
   * and the result. Starting the kept half on one would leave the request
   * inside the summarised half and the result outside it, and the provider
   * rejects the whole conversation for it.
   */
  while (idx > 0 && entries[idx]?.kind === 'tool-call') idx--;

  return idx;
}

/** Render entries as something a model can read and summarise. */
export function renderForSummary(entries: TranscriptEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    switch (entry.kind) {
      case 'message':
        if (!entry.content?.trim()) break;
        lines.push(`${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content.trim()}`);
        break;
      case 'tool-call':
        /*
         * Named with its arguments, and its output truncated hard.
         *
         * What matters months later is that a file was edited or a command
         * was run, not the four thousand characters it printed. Keeping the
         * full output here would make the text to be summarised as large as
         * the thing being compacted.
         */
        lines.push(
          `[tool ${entry.toolName}${entry.args ? ` ${JSON.stringify(entry.args).slice(0, 200)}` : ''}] ` +
            `${(entry.content ?? '').slice(0, 300).replace(/\s+/g, ' ')}`,
        );
        break;
      case 'notice':
        if (entry.level === 'error') break;
        lines.push(`(${entry.text})`);
        break;
      default:
        break;
    }
  }

  return lines.join('\n');
}

/** The instruction the summariser is given. */
export const SUMMARY_INSTRUCTION =
  'Summarise the conversation above so it can be continued without it.\n' +
  'This summary REPLACES those messages: whatever you leave out is forgotten.\n' +
  'Keep, specifically:\n' +
  '- what the user is trying to achieve, and any constraint or preference they stated;\n' +
  '- decisions taken and the reasons for them, including ones that were rejected;\n' +
  '- concrete facts that took effort to establish — file paths, names, versions, ' +
  'commands that worked, and ones that did not;\n' +
  '- what is unfinished, and what was about to happen next.\n' +
  'Drop pleasantries, restatements, and the detail of tool output that was already acted on.\n' +
  'Write it as notes for yourself, not as a report to the user. No preamble.';

/**
 * Replace the older part of a conversation with a summary of it.
 *
 * Returns a reason rather than throwing when there is nothing to do: "this
 * conversation is too short to compact" is an answer, not a failure, and a
 * user who pressed the button deserves to be told which it was.
 */
export async function compactConversation(
  conversationId: string,
  opts?: { keepRecent?: number; minEntries?: number },
): Promise<CompactionResult> {
  const entries = store.loadTranscript(conversationId);
  const keepRecent = opts?.keepRecent ?? KEEP_RECENT_ENTRIES;
  const minEntries = opts?.minEntries ?? MIN_ENTRIES_TO_COMPACT;

  if (entries.length < minEntries) {
    return {
      ok: false,
      reason:
        `This conversation has ${entries.length} entries; there is nothing worth compacting ` +
        `yet. Compaction starts to help past about ${minEntries}.`,
    };
  }

  const cut = splitPoint(entries, keepRecent);
  if (cut <= 0) {
    return {
      ok: false,
      reason: 'Nothing could be summarised without splitting a tool call from its result.',
    };
  }

  const older = entries.slice(0, cut);
  const kept = entries.slice(cut);

  /*
   * A conversation that is already one summary plus a short tail has
   * nothing left to gain, and re-summarising a summary loses a little more
   * every time.
   */
  if (older.length === 1 && older[0]?.kind === 'notice' && older[0].summary) {
    return { ok: false, reason: 'Already compacted; there is only the summary before the recent turns.' };
  }

  if (!summarise) {
    return { ok: false, reason: 'No summariser is installed on this node.' };
  }

  /*
   * Whose model writes it: the agent whose conversation this is, so the
   * summary is in its own voice and costs its own provider rather than
   * silently using somebody else's credential.
   */
  const agentId =
    (getConversation(conversationId)?.participants ?? []).find((p) => p.kind === 'agent')?.id ??
    conversationId;

  let summaryText: string;
  try {
    summaryText = await summarise(agentId, renderForSummary(older));
  } catch (err) {
    return { ok: false, reason: `The summary could not be written: ${(err as Error).message}` };
  }

  if (!summaryText.trim()) {
    /*
     * Refuse rather than write an empty summary. Replacing real turns with
     * nothing is the exact outcome compaction exists to avoid, and a model
     * that returned nothing has told us nothing about why.
     */
    return { ok: false, reason: 'The model returned an empty summary, so nothing was changed.' };
  }

  /*
   * The checkpoint goes in BEFORE the write, and its reason names what is
   * about to happen. That label is the entire basis on which somebody picks
   * which saved version they want back.
   */
  writeCheckpoint(host().dataDir, conversationId, entries, 'before compacting');

  const marker: TranscriptEntry = {
    kind: 'notice',
    id: store.newId('sum'),
    level: 'info',
    summary: true,
    text:
      `Earlier conversation compacted — ${older.length} entries replaced by this summary. ` +
      `The full version is in History.\n\n${summaryText.trim()}`,
    createdAt: Date.now(),
  };

  store.saveTranscript(conversationId, [marker, ...kept], 'compacted');

  /*
   * Announced from here, because this is where the change happens. A
   * conversation whose shape changed without the window hearing would show
   * the old entries until a reload — and the user pressed a button, so the
   * silence would read as the button doing nothing.
   */
  pushTranscript(conversationId, marker);

  return { ok: true, replaced: older.length, kept: kept.length };
}
