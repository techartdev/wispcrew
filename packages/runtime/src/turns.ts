/**
 * turns.ts — a turn as a durable record, not a boolean in memory.
 *
 * Until now "who is running" was `running: boolean` on an in-memory session
 * keyed by agent. That is enough for one machine with a window open, and it
 * cannot answer the question every other part of this system keeps asking:
 * **is this message already being worked on?**
 *
 * The failure that matters is not a duplicated transcript — stable entry ids
 * already prevent that. It is a duplicated *side effect*. A node receives
 * `@windows run the deploy`, starts, loses its connection, reconnects, sees
 * the same replicated message and runs it again. Nothing in the old design
 * says no.
 *
 * ```
 *   Message  m_123
 *     └── Turn t_981   agent=@windows  node=vps
 *           claimed → running → awaiting_approval → completed
 * ```
 *
 * With this in place a great deal stops being scattered across runtime
 * state, transcript entries and transport behaviour: reconnection, duplicate
 * suppression, Stop, approval waits, the consecutive-turn budget, and "who
 * is speaking right now".
 *
 * ## Why claiming is separate from running
 *
 * A claim is cheap and immediate; starting a model call is neither. Writing
 * the claim *first* is what makes the check meaningful — a second attempt
 * arriving while the first is still setting up must lose, not race.
 */
import type { TurnRecord, TurnState } from '@wispcrew/shared';
import { fileLog } from './filelog.js';
import { host } from './host.js';
import * as store from './store.js';

/**
 * How long a claim stays believable without progress.
 *
 * A process killed mid-turn leaves its claim behind, and a claim nobody will
 * ever finish would block that message forever. Long enough that a slow
 * model call is not mistaken for a dead one — turns here routinely run
 * minutes — and short enough that a crash does not wedge a conversation for
 * an afternoon.
 */
export const STALE_CLAIM_MS = 15 * 60_000;

/** States a turn will not leave. */
const TERMINAL: ReadonlySet<TurnState> = new Set<TurnState>([
  'completed',
  'failed',
  'cancelled',
]);

function turnsPath(): string {
  return store.filePathFor('turns.json');
}

export function listTurns(conversationId?: string): TurnRecord[] {
  const all = store.readJson<TurnRecord[]>(turnsPath(), []);
  if (!Array.isArray(all)) return [];
  return conversationId ? all.filter((t) => t.conversationId === conversationId) : all;
}

function saveTurns(turns: TurnRecord[]): void {
  /*
   * Keep the file from growing without bound.
   *
   * Finished turns are useful for a while — "what happened during that
   * reconnect?" — and worthless forever. The live ones are always kept
   * regardless of age, because dropping a running turn would let its
   * message be claimed twice.
   */
  const live = turns.filter((t) => !TERMINAL.has(t.state));
  const finished = turns
    .filter((t) => TERMINAL.has(t.state))
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
    .slice(0, 200);

  store.writeJson(turnsPath(), [...live, ...finished]);
}

/** A claim that is running but has not been touched for too long. */
function isStale(turn: TurnRecord, now: number): boolean {
  if (TERMINAL.has(turn.state)) return false;
  return now - (turn.heartbeatAt ?? turn.startedAt) > STALE_CLAIM_MS;
}

/**
 * Claim the right to work on a message.
 *
 * Returns the claim, or `null` when this message is already being handled by
 * a turn that is alive. The caller must not start work on a `null`.
 */
export function claimTurn(patch: {
  conversationId: string;
  triggerEntryId: string;
  agentId: string;
  /**
   * True when this message arrived with an identity of its own — replicated
   * from another node, or redelivered after a reconnect.
   *
   * The distinction decides what a *finished* turn means. A person resending
   * the same words is a retry and must be allowed; a transport redelivering
   * the same entry is a duplicate and must not run again. Both look
   * identical at the call site, so the caller says which it is.
   */
  replayed?: boolean;
}): TurnRecord | null {
  const now = Date.now();
  const all = listTurns();

  /*
   * One turn per (message, agent).
   *
   * Not per message: `@windows and @linux both look` is two turns on one
   * message, and both are legitimate. Two turns for the SAME agent on the
   * same message is the duplicate this exists to stop.
   */
  const existing = all.find(
    (t) => t.triggerEntryId === patch.triggerEntryId && t.agentId === patch.agentId,
  );

  if (existing) {
    // Alive: somebody is on it.
    if (!TERMINAL.has(existing.state) && !isStale(existing, now)) return null;

    /*
     * Already done, and this is the same entry arriving again.
     *
     * The case that matters: a node runs a deploy, the connection drops, and
     * the reconnect replays the message. Nothing about the transcript is
     * wrong — the entry is deduplicated by id — but running it a second time
     * deploys twice.
     */
    if (TERMINAL.has(existing.state) && patch.replayed) {
      fileLog('[turns] ignoring a replayed message already handled', existing.id);
      return null;
    }

    if (isStale(existing, now)) {
      // Whoever held this is gone. Say so rather than silently taking over:
      // a turn that vanished mid-deploy is worth knowing about.
      fileLog(
        '[turns] reclaiming a stale turn',
        existing.id,
        `idle ${Math.round((now - (existing.heartbeatAt ?? existing.startedAt)) / 1000)}s`,
      );
    }
  }

  const turn: TurnRecord = {
    id: store.newId('turn'),
    conversationId: patch.conversationId,
    triggerEntryId: patch.triggerEntryId,
    agentId: patch.agentId,
    nodeId: host().nodeName,
    state: 'claimed',
    startedAt: now,
    heartbeatAt: now,
  };

  saveTurns([...all.filter((t) => t.id !== existing?.id), turn]);
  return turn;
}

/** Move a turn along, and mark that it is still alive. */
export function updateTurn(
  id: string,
  patch: Partial<Pick<TurnRecord, 'state' | 'detail'>>,
): TurnRecord | undefined {
  const all = listTurns();
  const index = all.findIndex((t) => t.id === id);
  if (index === -1) return undefined;

  const now = Date.now();
  const next: TurnRecord = {
    ...all[index]!,
    ...patch,
    heartbeatAt: now,
    ...(patch.state && TERMINAL.has(patch.state) ? { finishedAt: now } : {}),
  };

  all[index] = next;
  saveTurns(all);
  return next;
}

/**
 * Say a turn is still alive.
 *
 * Called as work progresses so a long but healthy turn is never mistaken for
 * an abandoned one. Cheap: a timestamp on an existing record.
 */
export function heartbeatTurn(id: string): void {
  updateTurn(id, {});
}

/** Turns currently doing something, for "who is speaking right now". */
export function activeTurns(conversationId?: string): TurnRecord[] {
  const now = Date.now();
  return listTurns(conversationId).filter((t) => !TERMINAL.has(t.state) && !isStale(t, now));
}

/**
 * Abandon whatever this process was running.
 *
 * A host that is shutting down cleanly should not leave claims for the
 * staleness timeout to collect — the next start would otherwise refuse to
 * touch those messages for fifteen minutes.
 */
export function releaseTurnsForNode(nodeId: string): number {
  const all = listTurns();
  let released = 0;

  for (const turn of all) {
    if (turn.nodeId !== nodeId || TERMINAL.has(turn.state)) continue;
    turn.state = 'cancelled';
    turn.detail = 'the host stopped before this finished';
    turn.finishedAt = Date.now();
    released++;
  }

  if (released > 0) {
    saveTurns(all);
    fileLog('[turns] released', String(released), 'turn(s) on shutdown');
  }
  return released;
}
