/**
 * conversation.ts — a room, its participants, and how they reach it.
 *
 * Until now a transcript was `f(agentId)`: one conversation per agent, with
 * nowhere else for a conversation to live. That was right while WispCrew was
 * one person typing to one agent in one window, and it cannot express three
 * things the project now needs — replying from a phone, several agents
 * working together, or a second person joining.
 *
 * See `docs/CONVERSATIONS.md` for the reasoning. The short version:
 *
 *   A participant is a HUMAN or an AGENT.
 *   A CHANNEL is how a participant reaches the room, not a member of it.
 *
 * That distinction took a correction to arrive at. Treating a channel as a
 * participant quietly assumed a single user, and it made attribution wrong:
 * a message from your phone is "you, via Telegram", not "Telegram said". A
 * channel has no opinions and no memory. It is a door.
 */

/**
 * Somewhere a message can be delivered, or a participant can reach a room
 * from.
 *
 * `app` is the odd one: it means "the transcript itself", which is always
 * written and needs no permission. It is a delivery target rather than a
 * door — nobody *reaches the room* through it, they see it because they are
 * already looking. Kept in the same union because delivery and doors are
 * otherwise the same set, and two near-identical types would drift.
 */
export type ChannelId = 'app' | 'desktop' | 'telegram';

/** The doors a person can actually arrive through. */
export type DoorId = Exclude<ChannelId, 'app'>;

/**
 * How much a room constrains who may speak.
 *
 * Different work wants different discipline, and the wrong default is
 * expensive in both directions: too loose and every agent answers at once,
 * too tight and the user approves every utterance until they stop reading.
 */
export type RoomMode =
  /** Only tagged agents speak. Requests are shown but never auto-granted. */
  | 'directed'
  /** Tagged agents speak; untagged ones may request and are usually granted. */
  | 'open'
  /** Any agent may speak when it has something to add, subject to the budget. */
  | 'free';

/** A person in a room. */
export interface HumanParticipant {
  kind: 'human';
  id: string;
  /** Shown on their messages and in membership events. */
  name: string;
  /**
   * Doors this person can be reached through.
   *
   * One identity, any number of channels: sitting at the desktop and
   * replying from a train are the same person in the same conversation,
   * which is exactly the property that makes leaving the house harmless.
   */
  channels: ChannelId[];
}

/** An agent in a room. */
export interface AgentParticipant {
  kind: 'agent';
  /** The agent's own id, so its configuration and node are already known. */
  id: string;
  /**
   * Short handle for addressing it, e.g. `@windows`.
   *
   * Derived from the agent's name but stored, because renaming an agent
   * must not silently break every `@mention` already in the transcript.
   */
  handle: string;
  /**
   * Set when another participant brought this agent in for one problem.
   *
   * A guest is expected to leave when it is done, and the id of whoever
   * invited it is what makes its arrival explicable to everyone else.
   */
  invitedBy?: string;
}

export type Participant = HumanParticipant | AgentParticipant;

export interface ConversationRecord {
  id: string;
  /** User-facing title. Defaults to the first agent's name. */
  title: string;
  participants: Participant[];
  mode: RoomMode;
  createdAt: number;
  updatedAt: number;

  /**
   * The agent each person last addressed, keyed by human id.
   *
   * Tracked per person rather than per room: with two humans present, "the
   * last-addressed agent" has no single answer, and inheriting a
   * colleague's addressee would route a message somewhere nobody intended.
   */
  lastAddressed?: Record<string, string>;
}

/**
 * Something that happened to the room, as opposed to something said in it.
 *
 * These live in the transcript rather than a side table, because an agent
 * added halfway through needs to know how the room reached its current
 * state. Without them a guest's arrival is inexplicable, and a message
 * addressed to an agent that left reads as a mistake.
 */
export type RoomEventKind =
  | 'joined'
  | 'left'
  | 'channel-connected'
  | 'channel-disconnected'
  | 'approved'
  | 'declined'
  | 'floor-requested'
  | 'floor-granted';

export interface RoomEvent {
  kind: RoomEventKind;
  /**
   * Who caused it — a participant id, never "the user".
   *
   * With more than one human that is ambiguous, and it is equally wrong
   * when an AGENT brought in a guest, which is the case where knowing the
   * cause matters most.
   */
  actorId: string;
  /** Who or what it happened to. */
  subjectId?: string;
  /** Rendered sentence, e.g. `Vanyo added @linux.` */
  text: string;
}

/**
 * Words that describe where an agent runs rather than what it does.
 *
 * "Local Infrastructure Eye" would otherwise become `@local`, which says
 * nothing and collides with every other agent someone calls "Local
 * something". The second word is almost always the distinguishing one.
 *
 * Deliberately short: a longer list starts making choices the user did not
 * ask for, and a wrong guess is worse than a dull handle.
 */
const WEAK_FIRST_WORDS = new Set(['local', 'remote', 'my', 'the', 'a', 'new', 'main']);

/** A handle from an agent name: lowercase, no spaces, unique within a room. */
export function handleFor(name: string, taken: string[] = []): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  // Skip a leading word that only says where the agent lives, unless it is
  // the whole name — `@local` is right for an agent actually called "Local".
  const first = words[0] ?? '';
  const base =
    (WEAK_FIRST_WORDS.has(first) && words.length > 1 ? words[1] : first) || 'agent';

  if (!taken.includes(base)) return base;

  // Two agents called "Build server" would otherwise share a handle, and
  // `@build` would be ambiguous exactly when precision matters most.
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Participants that can be addressed with `@`. */
export function agentsIn(conversation: ConversationRecord): AgentParticipant[] {
  return conversation.participants.filter((p): p is AgentParticipant => p.kind === 'agent');
}

export function humansIn(conversation: ConversationRecord): HumanParticipant[] {
  return conversation.participants.filter((p): p is HumanParticipant => p.kind === 'human');
}
