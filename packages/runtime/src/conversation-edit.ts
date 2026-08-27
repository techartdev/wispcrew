/**
 * conversation-edit.ts — rewinding and branching, for either host.
 *
 * These lived in the desktop's bridge, which meant the CLI could not offer
 * them: a command calling `rewindConversation` failed at runtime with
 * "Unknown method", because the node's table had nothing to serve.
 *
 * Copying them to the node was the obvious fix and the wrong one. This
 * project has already been bitten by two functions that looked identical and
 * behaved differently — `writeSettings` silently dropped an API key that
 * `saveSettings` stored — and a second copy of transcript-editing logic
 * would drift the same way, quietly, in the half nobody runs by hand.
 *
 * So the logic moves here, where both hosts call the same code. That is the
 * reason `packages/runtime` exists at all.
 *
 * The engine's own memory is kept in step through injected callbacks: this
 * module knows what a transcript is and deliberately does not know what a
 * live session is.
 */
import type { AgentRecord, TranscriptEntry } from '@wispcrew/shared';
import { prefixBefore, prefixThrough, rebuildHistory } from './branching.js';
import { createAgentWithRoom } from './conversations.js';
import * as store from './store.js';

/** How the caller keeps a running agent's memory in step. */
export interface EditHooks {
  /**
   * Replace what the live agent remembers.
   *
   * Without this the model would still recall turns the transcript no longer
   * shows — the interface and the agent disagreeing about what was said,
   * which is worse than either version alone.
   */
  seedHistory?: (agentId: string, history: unknown[]) => void;
  /** Tell listeners the transcript changed underneath them. */
  emit?: (event: { type: string; [key: string]: unknown }) => void;
}

/**
 * Drop everything after an entry, keeping the removed part recoverable.
 *
 * `mode` decides whether the named entry survives: `through` keeps it,
 * `before` drops it too — the difference between "undo the reply" and "undo
 * my question as well".
 */
export function rewindConversation(
  agentId: string,
  entryId: string,
  mode: 'through' | 'before' = 'through',
  hooks: EditHooks = {},
): TranscriptEntry[] {
  const entries = store.loadTranscript(agentId);
  const kept = mode === 'before' ? prefixBefore(entries, entryId) : prefixThrough(entries, entryId);

  /*
   * A missing entry is not an error.
   *
   * A client may have rendered the button before the transcript was cleared
   * or trimmed underneath it, and failing there would turn a harmless race
   * into an error the user has to understand.
   */
  if (kept === null) return entries;

  // Labelled, so the recovery list distinguishes a rewind from a clear.
  store.saveTranscript(agentId, kept, 'rewind');

  hooks.seedHistory?.(agentId, rebuildHistory(kept));
  hooks.emit?.({ type: 'run-state', agentId, state: 'idle' });
  for (const entry of kept.slice(-1)) {
    hooks.emit?.({ type: 'transcript', agentId, entry });
  }

  return kept;
}

/**
 * Fork a conversation into a new agent from a chosen point.
 *
 * The branch is a new agent with the same configuration, seeded with the
 * shared prefix. The original is untouched — that is what makes this safe to
 * try, and the reason it is a branch rather than a rewind.
 */
export function branchConversation(
  agentId: string,
  entryId: string,
  name?: string,
  hooks: EditHooks = {},
): AgentRecord {
  const source = store.getAgent(agentId);
  if (!source) throw new Error(`No such agent: ${agentId}`);

  const entries = store.loadTranscript(agentId);
  const kept = prefixThrough(entries, entryId);
  if (kept === null) throw new Error('That message is no longer in the conversation.');

  const branch = createAgentWithRoom({
    ...source,
    id: undefined,
    name: name ?? nextBranchName(source.name),
    // A branch is an experiment; pinning it would put it above the original.
    pinned: false,
  });

  store.saveTranscript(branch.id, kept);
  hooks.emit?.({ type: 'agents-changed', agents: store.listAgents() });

  return branch;
}

/**
 * "Assistant" becomes "Assistant 2", then "Assistant 3".
 *
 * Counted from what exists rather than stored, so deleting a branch frees
 * its number instead of leaving a gap that looks like a missing agent.
 */
export function nextBranchName(base: string): string {
  const stem = base.replace(/ \d+$/, '');
  const taken = new Set(store.listAgents().map((a) => a.name));

  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${stem} ${Date.now()}`;
}
