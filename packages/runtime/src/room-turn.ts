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
import { createConversation, getConversation, recordRoomEvent, updateConversation } from './conversations.js';
import { runPrompt } from './engine.js';
import { fileLog } from './filelog.js';
import { rememberAddressee, routeHumanMessage } from './floor.js';
import * as store from './store.js';
import { claimTurn, updateTurn } from './turns.js';
import { placeSpeakers, runRemote } from './room-dispatch.js';

export interface RoomTurnInput {
  conversationId: string;
  text: string;
  /** Which human said it. */
  speakerId: string;
  /** The door it arrived through; undefined means the local app. */
  channel?: ChannelId;
  attachments?: Parameters<typeof runPrompt>[2];
  /**
   * A pre-decided id for the message entry.
   *
   * Set when a message arrives with an identity of its own -- a replicated
   * entry, or a retry of one already recorded -- so a turn claims against
   * the same id rather than a fresh one.
   */
  entryId?: string;
  /** Injected by tests. */
  run?: typeof runPrompt;
}

export interface RoomTurnResult {
  /** Agents that were actually started. */
  ran: string[];
  /** Present when nobody acted, explaining why. */
  notice?: string;
  /**
   * Agents that started and did not finish.
   *
   * A failing agent is caught so it cannot take down the others, which left
   * the caller unable to tell success from failure — Telegram reported
   * "Done, with nothing to report" for a turn that had thrown. Worse than
   * silence, because it is confidently wrong.
   */
  failures?: { agentId: string; handle: string; error: string }[];
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
  let conversation = getConversation(input.conversationId);

  /*
   * An agent without a room gets one, here.
   *
   * Every send path now goes through this function, so "no room" means a
   * silently dead conversation: the message is accepted and nothing ever
   * happens. A suite caught exactly that — an agent created straight through
   * the store had no room, and its transcript stayed empty.
   *
   * `createAgentWithRoom` covers the paths a user takes, but the store's own
   * `createAgent` is used by tests, by migrations, and by any future caller
   * who has not read this file. Healing here is cheap and removes a whole
   * class of "why is nothing happening".
   */
  if (!conversation) {
    const agent = store.listAgents().find((a) => a.id === input.conversationId);
    if (agent) {
      conversation = createConversation({ agentId: agent.id, agentName: agent.name });
      fileLog('[room] created a missing room for', agent.name);
    }
  }

  if (!conversation) {
    return { ran: [], notice: 'That conversation no longer exists.' };
  }

  const text = input.text.trim();
  if (!text) return { ran: [] };

  /*
   * The entry id is what a turn claims against.
   *
   * Generated here rather than inside the store call so it can be handed to
   * `claimTurn` — that pairing is what makes a replayed message identifiable
   * as the same message.
   */
  const triggerEntryId = input.entryId ?? store.newId('usr');

  store.upsertTranscriptEntry(conversation.id, {
    kind: 'message',
    id: triggerEntryId,
    role: 'user',
    content: text,
    authorId: input.speakerId,
    via: input.channel && input.channel !== 'app' ? input.channel : undefined,
    createdAt: Date.now(),
    /*
     * Metadata only.
     *
     * Base64 image data would add megabytes per message to the transcript
     * file and is never re-sent from history — but the record that a file
     * WAS attached belongs in the conversation, or a reader sees a question
     * about an image that is not there.
     */
    ...((input.attachments ?? []).length
      ? {
          attachments: (input.attachments ?? []).map((a) => ({
            name: a.name,
            mimeType: a.mimeType,
            size: a.size,
            kind: a.kind,
          })),
        }
      : {}),
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
  /*
   * An agent belongs to exactly one node.
   *
   * Its workspace, its files and its provider key live there, so running it
   * here would give it none of them. The client relays: local agents run in
   * this process, remote ones on their own machine.
   *
   * A test that injects `run` keeps everything local — the seam exists to
   * avoid a provider call, not to model placement.
   */
  const placement = input.run ? { local: routing.speakers, remote: [], unreachable: [] }
    : placeSpeakers(routing.speakers);

  /*
   * Say when an agent could not be reached.
   *
   * Silence here is the worst outcome: the user tagged @windows, nothing
   * happened, and nothing explains why. Naming the machine is what makes it
   * actionable — the laptop is asleep, or the node was never paired.
   */
  for (const agent of placement.unreachable) {
    store.upsertTranscriptEntry(conversation.id, {
      kind: 'notice',
      id: store.newId('note'),
      level: 'error',
      text: `@${agent.handle} runs on another machine, which is not connected.`,
      createdAt: Date.now(),
    });
  }

  const started: string[] = [];
  const failures: NonNullable<RoomTurnResult['failures']> = [];

  /*
   * Remote agents, claimed the same way.
   *
   * The claim lives on THIS machine because the room does. A remote node
   * runs its own turn and keeps its own record; what this prevents is the
   * client relaying the same message twice.
   */
  const remoteWork = placement.remote.flatMap(({ nodeId, agents }) =>
    agents.map(async (agent) => {
      const turn = claimTurn({
        conversationId: conversation.id,
        triggerEntryId,
        agentId: agent.id,
        replayed: input.entryId !== undefined,
      });
      if (!turn) return;

      started.push(agent.id);
      updateTurn(turn.id, { state: 'running' });

      const error = await runRemote(nodeId, agent, text);
      if (error) {
        updateTurn(turn.id, { state: 'failed', detail: error });
        store.upsertTranscriptEntry(conversation.id, {
          kind: 'notice',
          id: store.newId('note'),
          level: 'error',
          text: `@${agent.handle} could not be reached: ${error}`,
          createdAt: Date.now(),
        });
      } else {
        updateTurn(turn.id, { state: 'completed' });
      }
    }),
  );

  await Promise.all([
    ...remoteWork,
    ...placement.local.map(async (agent) => {
      /*
       * Claim before running.
       *
       * A `null` means this exact (message, agent) pair is already being
       * worked on by a turn that is alive — a reconnect replaying the same
       * message, or two clients sending at once. Stable entry ids stop the
       * transcript being duplicated; only this stops the *deploy* being run
       * twice.
       */
      const turn = claimTurn({
        conversationId: conversation.id,
        triggerEntryId,
        agentId: agent.id,
        /*
         * A caller-supplied entry id means this message already had an
         * identity elsewhere — replicated from another node, or redelivered
         * after a reconnect. A freshly generated id is a new message, and a
         * person resending the same words deserves a real second attempt.
         */
        replayed: input.entryId !== undefined,
      });

      if (!turn) {
        fileLog('[room] already running', agent.handle, triggerEntryId);
        return;
      }

      started.push(agent.id);
      updateTurn(turn.id, { state: 'running' });

      try {
        /*
         * The room, not the agent, owns the transcript.
         *
         * Without the last argument each agent writes into its own file, so
         * a second agent's replies never appear in the room — measured:
         * `@all` ran two agents and showed nothing.
         */
        await run(
          agent.id,
          text,
          input.attachments ?? [],
          undefined,
          input.channel,
          conversation.id,
        );
        updateTurn(turn.id, { state: 'completed' });
      } catch (err) {
        // One agent failing must not take down the others.
        const message = (err as Error).message;
        updateTurn(turn.id, { state: 'failed', detail: message });
        failures.push({ agentId: agent.id, handle: agent.handle, error: message });
        fileLog('[room] turn failed for', agent.handle, message);

        store.upsertTranscriptEntry(conversation.id, {
          kind: 'notice',
          id: store.newId('note'),
          level: 'error',
          text: `@${agent.handle} could not finish: ${message}`,
          createdAt: Date.now(),
        });
      }
    }),
  ]);

  return { ran: started, ...(failures.length ? { failures } : {}) };
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
