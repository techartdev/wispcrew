/**
 * transcript.ts — write an entry AND tell whoever is listening.
 *
 * This lived in `engine.ts`, which meant anything that could not import the
 * engine had to reach for `store.upsertTranscriptEntry` instead — and that
 * one saves and announces nothing. The result was the same bug three times:
 *
 *  - an approval card written but never pushed, so it appeared only after a
 *    reload, while the agent sat blocked;
 *  - every entry a room turn writes — the user's own message, the "nobody
 *    was addressed" notice, a failed member, a floor offer;
 *  - every room EVENT: joins, departures, and now an agent rewriting the
 *    room instructions.
 *
 * `conversations.ts` cannot import `engine.ts` (the engine imports it), so
 * the function moved here instead, where both can reach it. It depends only
 * on the store and the event sink, neither of which depends on anything
 * else.
 *
 * The rule this exists to make easy: a change made where a call is answered
 * has to be announced from there.
 */
import type { ChannelId, ConversationRecord, TranscriptEntry } from '@wispcrew/shared';
import { emitEngineEvent } from './engine-events.js';
import * as store from './store.js';
import { mirrorEntry } from './channel-mirror.js';

/** Persist a transcript entry and tell whoever is listening. */
export function pushTranscript(
  agentId: string,
  entry: TranscriptEntry,
  /**
   * Where this entry came from, when it came from somewhere.
   *
   * Only used to decide what NOT to mirror: an answer to a turn that
   * started in Telegram is already being delivered there by
   * `telegram-progress`, and sending it again would double it.
   */
  origin?: ChannelId,
): void {
  store.upsertTranscriptEntry(agentId, entry);
  emitEngineEvent({ type: 'transcript', agentId, entry });

  /*
   * And show it to anyone watching this conversation from elsewhere.
   *
   * Deliberately not awaited. A slow or unreachable Telegram must not hold
   * up the turn that produced the entry — the transcript is the record, and
   * this is a convenience on top of it.
   */
  void mirrorEntry(agentId, entry, {
    origin,
    nameOf: (id) => store.getAgent(id)?.name,
  });
}

/**
 * Tell every attached client that the routines changed.
 *
 * The event was emitted from exactly two places — the node's method table
 * and the desktop bridge — and both of them are doors a CLIENT knocks on.
 * Neither is involved when an AGENT schedules something for itself, which
 * is the whole point of `propose_routine` and `schedule_follow_up`. So a
 * routine an agent created appeared only after a reload: it was on disk, the
 * agent said it had made it, and the Scheduled list showed nothing.
 *
 * The list is read here rather than passed in, because the callers that
 * schedule do not have one and building it at each call site is how two
 * doors onto one fact begin to disagree.
 */
export function announceRoutines(): void {
  emitEngineEvent({ type: 'routines-changed', routines: store.listRoutines() });
}

/**
 * Tell every attached client that the rooms changed.
 *
 * Takes the list rather than reading it, because the two callers that have
 * one — the daemon's method table and the desktop bridge — already filter
 * out members whose agent no longer exists, and two doors onto one fact
 * must not disagree.
 */
export function announceRooms(conversations: ConversationRecord[]): void {
  emitEngineEvent({ type: 'rooms-changed', conversations });
}
