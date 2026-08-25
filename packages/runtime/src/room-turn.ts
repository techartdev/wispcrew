/**
 * room-turn.ts — running a turn in a room rather than at an agent.
 *
 * `runPrompt(agentId, text)` assumes one agent owns the conversation. That
 * was true until rooms existed. This is the replacement: given a room and
 * something a person said, work out who should act and run them.
 *
 * The floor rules live in `floor.ts` as a pure decision; this is the part
 * that has effects — writing the message, starting the runs, remembering who
 * was addressed.
 *
 * ## Why agents run concurrently
 *
 * Tagging two agents means asking two questions at once, and running them in
 * sequence would make the second wait on the first for no reason — they are
 * usually on different machines doing unrelated work. The transcript is
 * upserted by entry id, so interleaved streaming is already handled.
 */
import type { ChannelId, ConversationRecord } from '@wispcrew/shared';
import { getConversation, recordRoomEvent, updateConversation } from './conversations.js';
import { runPrompt } from './engine.js';
import { fileLog } from './filelog.js';
import { rememberAddressee, routeHumanMessage } from './floor.js';
import * as store from './store.js';

export interface RoomTurnInput {
  conversationId: string;
  text: string;
  /** Which human said it. */
  speakerId: string;
  /** The door it arrived through; undefined means the local app. */
  channel?: ChannelId;
  attachments?: Parameters<typeof runPrompt>[2];
  /** Injected by tests. */
  run?: typeof runPrompt;
}

export interface RoomTurnResult {
  /** Agents that were actually started. */
  ran: string[];
  /** Present when nobody acted, explaining why. */
  notice?: string;
}

/**
 * Count consecutive agent messages at the end of a transcript.
 *
 * The turn budget is about how long the room has run without human input,
 * so the count resets at the last thing a person said.
 */
function agentTurnsSinceHuman(conversationId: string): number {
  const transcript = store.loadTranscript(conversationId);
  let count = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i]!;
    if (entry.kind !== 'message') continue;
    if (entry.role === 'user') break;
    count++;
  }
  return count;
}

/**
 * Run a turn in a room.
 *
 * The message is recorded first, whatever happens next: a user's words
 * belong in the conversation even if no agent acts on them, and losing them
 * because nobody was addressed would be baffling.
 */
export async function runRoomTurn(input: RoomTurnInput): Promise<RoomTurnResult> {
  const conversation = getConversation(input.conversationId);
  if (!conversation) {
    return { ran: [], notice: 'That conversation no longer exists.' };
  }

  const text = input.text.trim();
  if (!text) return { ran: [] };

  store.upsertTranscriptEntry(conversation.id, {
    kind: 'message',
    id: store.newId('usr'),
    role: 'user',
    content: text,
    authorId: input.speakerId,
    via: input.channel && input.channel !== 'app' ? input.channel : undefined,
    createdAt: Date.now(),
  });

  const routing = routeHumanMessage({
    conversation,
    text,
    speakerId: input.speakerId,
    agentTurnsSoFar: agentTurnsSinceHuman(conversation.id),
  });

  if (routing.speakers.length === 0) {
    /*
     * Nobody acted. Say why in the room rather than silently doing nothing —
     * a message that vanishes into a conversation with three agents in it is
     * indistinguishable from a broken app.
     */
    store.upsertTranscriptEntry(conversation.id, {
      kind: 'notice',
      id: store.newId('note'),
      level: 'info',
      text: routing.reason,
      createdAt: Date.now(),
    });

    if (routing.mayRequest.length > 0) {
      recordFloorOffer(conversation, routing.mayRequest.map((a) => a.handle));
    }

    return { ran: [], notice: routing.reason };
  }

  // Remember who this person addressed, so an untagged follow-up continues
  // with the same agent.
  if (routing.speakers.length === 1) {
    updateConversation(
      conversation.id,
      rememberAddressee(conversation, input.speakerId, routing.speakers[0]!.id),
    );
  }

  const run = input.run ?? runPrompt;

  /*
   * Concurrently, not in sequence.
   *
   * Tagging two agents asks two questions at once; making the second wait on
   * the first would be arbitrary, and they are usually on different machines
   * doing unrelated work.
   */
  await Promise.all(
    routing.speakers.map((agent) =>
      /*
       * The room, not the agent, owns the transcript.
       *
       * Without the last argument each agent writes into its own file, so a
       * second agent's replies never appear in the room — measured: `@all`
       * ran two agents and showed nothing.
       */
      run(agent.id, text, input.attachments ?? [], undefined, input.channel, conversation.id).catch(
        (err: Error) => {
          // One agent failing must not take down the others.
          fileLog('[room] turn failed for', agent.handle, err.message);
          store.upsertTranscriptEntry(conversation.id, {
            kind: 'notice',
            id: store.newId('note'),
            level: 'error',
            text: `@${agent.handle} could not finish: ${err.message}`,
            createdAt: Date.now(),
          });
        },
      ),
    ),
  );

  return { ran: routing.speakers.map((a) => a.id) };
}

/**
 * Note that agents could contribute if asked.
 *
 * One quiet line rather than a prompt per agent: a user asked to approve
 * every utterance stops reading, and then the oversight is worthless.
 */
function recordFloorOffer(conversation: ConversationRecord, handles: string[]): void {
  if (conversation.mode === 'directed') {
    // The mode exists precisely so nobody is nudged; the UI can still show
    // the handles, but the room stays quiet.
    return;
  }

  recordRoomEvent(
    conversation.id,
    'floor-requested',
    'room',
    handles.length === 1
      ? `@${handles[0]} could answer this.`
      : `${handles.map((h) => `@${h}`).join(', ')} could answer this.`,
  );
}
