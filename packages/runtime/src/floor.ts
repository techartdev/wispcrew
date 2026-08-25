/**
 * floor.ts — who speaks, and who merely listens.
 *
 * Everyone in a room sees every message; that is what makes collaboration
 * possible and it costs only context. **Acting** is separate.
 *
 * Left alone, several helpful agents either all answer at once or wait for
 * each other and none does. Constrained too tightly, the user approves every
 * utterance until they stop reading — and an oversight mechanism nobody
 * reads is oversight in name only.
 *
 * So this is a pure decision: given a message and a room, who should act?
 * Keeping it free of I/O is deliberate — the rules are fiddly enough that
 * they need to be exhaustively testable, and a bug here is expensive in
 * tokens rather than merely wrong.
 *
 * See `docs/GROUP-CHAT.md` for the reasoning.
 */
import type { AgentParticipant, ConversationRecord, RoomMode } from '@wispcrew/shared';
import { agentsIn } from '@wispcrew/shared';

/**
 * How many agent turns may follow one another before the room stops.
 *
 * The backstop that makes `free` safe enough to offer. Even with the
 * no-reply-by-default rule, a chain of explicit `@mentions` can run away, and
 * the failure mode should be a pause rather than a bill.
 */
export const DEFAULT_TURN_BUDGET = 12;

export interface Routing {
  /** Agents that should act on this message. */
  speakers: AgentParticipant[];
  /** Agents that may ask to speak, in modes where that applies. */
  mayRequest: AgentParticipant[];
  /** Why, for the transcript and for explaining a surprise to the user. */
  reason: string;
  /** True when the budget stopped the room instead. */
  budgetExhausted?: boolean;
}

/** `@handle` mentions, lowercased, in order of appearance. */
export function mentionsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9-]*)/gi)) {
    const handle = match[1]!.toLowerCase();
    if (!found.includes(handle)) found.push(handle);
  }
  return found;
}

/**
 * Is this message addressed to the room rather than to one agent?
 *
 * Detected by an explicit marker only. Guessing from phrasing — "does this
 * build on your platform?" — would be a model call before every turn and a
 * wrong answer would wake every agent at once.
 */
export function addressesEveryone(text: string): boolean {
  return /(?:^|\s)@(?:all|everyone|room)\b/i.test(text);
}

export interface RouteInput {
  conversation: ConversationRecord;
  text: string;
  /** Which human sent it; used for per-person last-addressed. */
  speakerId: string;
  /** Consecutive agent turns since a human last spoke. */
  agentTurnsSoFar?: number;
  /** Override for tests. */
  budget?: number;
}

/**
 * Decide who acts on a message from a human.
 */
export function routeHumanMessage(input: RouteInput): Routing {
  const { conversation, text, speakerId } = input;
  const agents = agentsIn(conversation);

  if (agents.length === 0) {
    return { speakers: [], mayRequest: [], reason: 'no agents in this room' };
  }

  // A room with one agent behaves exactly as a single-agent chat always
  // has: no tagging, no ceremony.
  if (agents.length === 1) {
    return { speakers: agents, mayRequest: [], reason: 'the only agent here' };
  }

  if (addressesEveryone(text)) {
    return { speakers: agents, mayRequest: [], reason: 'addressed to the room' };
  }

  const mentioned = mentionsIn(text);
  if (mentioned.length > 0) {
    const tagged = agents.filter((a) => mentioned.includes(a.handle));

    if (tagged.length > 0) {
      return {
        speakers: tagged,
        // Nobody needs to request the floor when the user named who they
        // wanted; anyone else piling in is exactly the noise being avoided.
        mayRequest: [],
        reason: tagged.length === 1 ? `addressed to @${tagged[0]!.handle}` : 'addressed to several',
      };
    }

    /*
     * A mention that matches nobody.
     *
     * Silently falling through to the last-addressed agent would answer as
     * though the user had not tried to direct it, which is worse than
     * saying so — they misspelled a handle and should find out now.
     */
    return {
      speakers: [],
      mayRequest: [],
      reason: `no agent here is called @${mentioned[0]}`,
    };
  }

  /*
   * Untagged: continue with whoever this person last addressed.
   *
   * Per person, not per room. With two humans present "the last-addressed
   * agent" has no single answer, and inheriting a colleague's addressee
   * would route a message somewhere nobody intended.
   */
  const previous = conversation.lastAddressed?.[speakerId];
  const continuing = previous ? agents.find((a) => a.id === previous) : undefined;

  if (continuing) {
    return {
      speakers: [continuing],
      mayRequest: othersMayRequest(conversation.mode, agents, [continuing]),
      reason: `continuing with @${continuing.handle}`,
    };
  }

  /*
   * Nobody addressed yet in a multi-agent room.
   *
   * Waking every agent would be the expensive guess, so the room asks
   * instead — and in `free` mode, where the user has said they want
   * initiative, they all get to.
   */
  if (conversation.mode === 'free') {
    return { speakers: agents, mayRequest: [], reason: 'free mode: anyone may answer' };
  }

  return {
    speakers: [],
    mayRequest: agents,
    reason: 'nobody addressed yet — tag an agent, or let one ask',
  };
}

/**
 * Who may ask to speak, given the room's discipline.
 *
 * `directed` shows requests but never grants them automatically; `open`
 * grants them; `free` does not need them because agents may simply speak.
 */
function othersMayRequest(
  mode: RoomMode,
  agents: AgentParticipant[],
  speaking: AgentParticipant[],
): AgentParticipant[] {
  if (mode === 'free') return [];
  return agents.filter((a) => !speaking.some((s) => s.id === a.id));
}

/**
 * Decide whether an agent's message causes another agent to act.
 *
 * The default is no. Two helpful agents replying to each other is an
 * unbounded loop that costs real money, so an agent responds because it was
 * ADDRESSED, not because somebody spoke.
 */
export function routeAgentMessage(input: RouteInput & { authorId: string }): Routing {
  const { conversation, text, authorId } = input;
  const budget = input.budget ?? DEFAULT_TURN_BUDGET;
  const soFar = input.agentTurnsSoFar ?? 0;

  if (soFar >= budget) {
    /*
     * The backstop.
     *
     * Even with no-reply-by-default, a chain of explicit mentions can run
     * away. Stopping and asking is the right failure: a pause costs
     * attention, a runaway costs money.
     */
    return {
      speakers: [],
      mayRequest: [],
      reason: `${soFar} agent turns without you — stopping to check`,
      budgetExhausted: true,
    };
  }

  const agents = agentsIn(conversation);
  const mentioned = mentionsIn(text);

  // An agent addressing the room is not licence for everyone to answer; that
  // is precisely how a loop starts.
  if (mentioned.length === 0) {
    return { speakers: [], mayRequest: [], reason: 'agents do not reply unless addressed' };
  }

  const tagged = agents.filter(
    (a) => mentioned.includes(a.handle) && a.id !== authorId,
  );

  if (tagged.length === 0) {
    return { speakers: [], mayRequest: [], reason: 'nobody addressed' };
  }

  return {
    speakers: tagged,
    mayRequest: [],
    reason: `addressed by another agent`,
  };
}

/**
 * Remember who a person last addressed.
 *
 * Returns the patch rather than writing it, so the caller decides when the
 * conversation record is saved.
 */
export function rememberAddressee(
  conversation: ConversationRecord,
  speakerId: string,
  agentId: string,
): Partial<ConversationRecord> {
  return {
    lastAddressed: { ...(conversation.lastAddressed ?? {}), [speakerId]: agentId },
  };
}
