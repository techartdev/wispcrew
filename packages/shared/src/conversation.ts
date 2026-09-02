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
   * Handle for addressing it, e.g. `@windows-builder`.
   *
   * Stored rather than derived on read, so a room can resolve a mention
   * without the roster — but it FOLLOWS the agent's name, and is rewritten
   * when the agent is renamed.
   *
   * That reverses the original decision, which froze it so that renaming an
   * agent "must not silently break every `@mention` already in the
   * transcript". The trade proved to be the wrong way round. Old mentions
   * are prose in a finished conversation; nothing resolves them and nothing
   * acts on them. A frozen handle, by contrast, is live: an agent renamed
   * "Assistant" to "OpenClaw AddOn Dev" kept introducing itself as
   * `@assistant`, in a room whose members list said otherwise, and the user
   * could not tell whether the agent was confused or the app was.
   *
   * A rename now says so in every room the agent is in, so the change is
   * visible rather than merely correct.
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

/**
 * What kind of place this is, as the person who made it intended.
 *
 * `direct` is you and one agent — the original shape, and still the common
 * one. `group` is a room several agents were deliberately put in.
 *
 * Stored rather than counted, because the two answer different questions.
 * "How many agents are in here right now?" is a count; "was this meant to be
 * a group?" is an intention, and the difference shows the moment a group
 * drops to one member. Counting would silently demote it to a private chat
 * with whoever happened to be left — renaming its header, moving its
 * Configure button, and making the room look like it belongs to an agent
 * that merely outlasted the others.
 */
export type ConversationKind = 'direct' | 'group';

export interface ConversationRecord {
  id: string;
  /** User-facing title. Defaults to the first agent's name. */
  title: string;
  kind: ConversationKind;
  participants: Participant[];
  mode: RoomMode;
  createdAt: number;
  updatedAt: number;

  /**
   * The one piece of content a room owns: its tone, its purpose, and why
   * these particular agents are here.
   *
   * **Visible to everyone who has joined**, deliberately — it is shown in
   * the room and it goes into every member's prompt marked as something the
   * user can also read. Not a hidden system instruction.
   *
   * That choice is the whole design. An agent that can read the room's rules
   * can follow them, can say what they are when asked, and can point out
   * that one of them is wrong. A rule nobody can see is a rule nobody can
   * correct — and the user, reading a reply shaped by an instruction they
   * cannot find, has no way to know why their agent is behaving oddly.
   *
   * Belongs to the room, not to any agent: it travels with the conversation,
   * so an agent added halfway through knows what kind of place it walked
   * into without reading the whole transcript.
   */
  greeting?: string;

  /**
   * What the provider said the last request cost, in input tokens.
   *
   * The one measured number available about context use, and it was being
   * discarded: `usage` arrives on every `turn_end` and nothing recorded it.
   *
   * Kept on the CONVERSATION because that is the question it answers — "how
   * full is this conversation" — rather than on a message. Reading it off
   * the last assistant entry would break whenever a turn ended with a tool
   * call rather than prose, which is most long turns.
   *
   * Absent until a turn has run. Before that the meter shows an estimate
   * and says so.
   */
  lastInputTokens?: number;

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
 * A handle from an agent name: the whole name, slugified, unique in a room.
 *
 * This used to keep only the first meaningful word, skipping a leading
 * "local"/"remote"/"the" as uninformative. It read well for one agent and
 * failed for a team: "OpenClaw AddOn Dev" and "OpenClaw Dev Version" — two
 * agents on the same project, which is exactly when you have several —
 * became `@openclaw` and `@openclaw2`. The numbering is what gives it away:
 * the shortening manufactured a collision, then papered over it, and the
 * result told nobody which agent was which.
 *
 * The whole name has no such failure. `@openclaw-addon-dev` is longer to
 * read and never ambiguous, and nothing has to be typed by hand anyway —
 * the composer completes handles from the room's membership.
 */
export function handleFor(name: string, taken: string[] = []): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      // Punctuation at either end would otherwise leave a dangling dash.
      .replace(/^-+|-+$/g, '') || 'agent';

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
  return (conversation.participants ?? []).filter(
    (p): p is AgentParticipant => p.kind === 'agent',
  );
}

/**
 * The room's members: the agents in it, by id.
 *
 * `docs/ROOMS.md` sketches this as a stored `members: string[]` beside
 * `participants`. It is derived instead, and the reason is the bug class
 * that has cost this project the most: two records of the same fact drift,
 * and then the answer depends on which one you happened to read. Membership
 * is already written down — `participants` carries each agent's id, handle
 * and who invited it — so a second list could only ever agree or be wrong.
 *
 * What the document actually asked for was that **nobody is the root**: a
 * room is not its first agent. That is delivered by the room owning an id of
 * its own, not by copying ids into a parallel array.
 */
export function memberIds(conversation: ConversationRecord): string[] {
  return agentsIn(conversation).map((a) => a.id);
}

/**
 * Is this room a group — several agents deliberately put together?
 *
 * Reads `kind` when it is set and falls back to counting, so a record
 * written before `kind` existed still answers correctly.
 */
export function isGroup(conversation: ConversationRecord): boolean {
  return conversation.kind ? conversation.kind === 'group' : agentsIn(conversation).length > 1;
}

export function humansIn(conversation: ConversationRecord): HumanParticipant[] {
  return conversation.participants.filter((p): p is HumanParticipant => p.kind === 'human');
}

/**
 * What a turn is doing.
 *
 * `claimed` is deliberately distinct from `running`: a claim is written
 * before any model call starts, so a second attempt arriving while the first
 * is still setting up loses rather than races.
 */
export type TurnState =
  | 'claimed'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * One agent's attempt at one message.
 *
 * Durable, because the question "is this already being worked on?" outlives
 * any single process. Stable entry ids stop a transcript being duplicated;
 * they do not stop a deploy being run twice after a reconnect, which is what
 * this record is for.
 */
export interface TurnRecord {
  id: string;
  conversationId: string;
  /** The transcript entry that caused this turn — usually a user message. */
  triggerEntryId: string;
  agentId: string;
  /** Which machine is doing the work, so a shutdown can release its claims. */
  nodeId: string;
  state: TurnState;
  startedAt: number;
  /**
   * Last sign of life.
   *
   * A process killed mid-turn leaves its claim behind; without this, that
   * message could never be attempted again.
   */
  heartbeatAt?: number;
  finishedAt?: number;
  /** Why it ended, when that is not obvious. */
  detail?: string;
}
