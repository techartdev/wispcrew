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
import type { ConversationRecord, TranscriptEntry } from '@wispcrew/shared';
import { emitEngineEvent } from './engine-events.js';
import * as store from './store.js';

/** Persist a transcript entry and tell whoever is listening. */
export function pushTranscript(agentId: string, entry: TranscriptEntry): void {
  store.upsertTranscriptEntry(agentId, entry);
  emitEngineEvent({ type: 'transcript', agentId, entry });
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
