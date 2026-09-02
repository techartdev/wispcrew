/**
 * conversations.ts — rooms, and the migration into them.
 *
 * A transcript used to be `f(agentId)`. It is now `f(conversationId)`, with
 * the room holding the participants. See `docs/CONVERSATIONS.md`.
 *
 * ## The migration must be invisible
 *
 * Every existing agent gets a room containing that agent and the local user.
 * The transcript file is not touched or rewritten — the room simply points
 * at the agent's existing id — so the riskiest part of this change is the
 * part that does nothing at all.
 *
 * That is deliberate. A migration that rewrites transcripts is a migration
 * that can corrupt them, and this project has already lost one conversation
 * to a careless write.
 */
import type {
  AgentParticipant,
  ChannelId,
  ConversationRecord,
  HumanParticipant,
  Participant,
  RoomEvent,
  RoomEventKind,
  TranscriptEntry,
} from '@wispcrew/shared';
import { agentsIn, handleFor } from '@wispcrew/shared';
import { fileLog } from './filelog.js';
import * as store from './store.js';

/**
 * The person using this installation.
 *
 * A fixed id rather than a generated one: it appears in `lastAddressed`
 * keys and in event text, and a value that changed between runs would make
 * old entries unreadable. Named "You" because that is how the UI addresses
 * them; a real display name arrives when a second human can join.
 */
export const LOCAL_HUMAN_ID = 'human:local';

export function localHuman(channels: ChannelId[] = ['app', 'desktop']): HumanParticipant {
  return { kind: 'human', id: LOCAL_HUMAN_ID, name: 'You', channels };
}

/**
 * Fill in `kind` for a record written before it existed.
 *
 * Done on read rather than only in the migration, because a profile is not
 * always migrated by the process that reads it: two hosts share one store,
 * and a remote node's records arrive over the wire having never passed
 * through this machine's startup at all.
 *
 * The rule is what the user already lived with: a room holding more than one
 * agent has been behaving as a group, whatever it was created as. Anything
 * else is a direct chat.
 */
function withKind(record: ConversationRecord): ConversationRecord {
  if (record.kind === 'direct' || record.kind === 'group') return record;
  return { ...record, kind: agentsIn(record).length > 1 ? 'group' : 'direct' };
}

/** Every room, newest first. */
export function listConversations(): ConversationRecord[] {
  const all = store.readJson<ConversationRecord[]>(store.conversationsPath(), []);
  if (!Array.isArray(all)) return [];

  return [...all].map(withKind).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * A room as a person should see it: without members who no longer exist.
 *
 * Deleting an agent now removes it from every room, but rooms written BEFORE
 * that fix still carry the dead handle — and a stale profile is exactly what
 * a real user has. The symptom was visible in the mention menu:
 * `@scenariob — agent_mtbbymlly9j4el`, an id where a name should be, for an
 * agent that could never answer.
 *
 * Deliberately NOT done inside `listConversations`. That function is also
 * how membership is managed, and filtering there made `removeParticipant`
 * unable to see the participant it was asked to remove — a suite caught it
 * immediately. Reading is one concern; displaying is another.
 */
export function visibleParticipants(room: ConversationRecord): ConversationRecord['participants'] {
  const live = new Set(store.listAgents().map((a) => a.id));
  return (room.participants ?? []).filter((p) => p.kind !== 'agent' || live.has(p.id));
}

export function getConversation(id: string): ConversationRecord | undefined {
  return listConversations().find((c) => c.id === id);
}

function saveConversations(all: ConversationRecord[]): void {
  store.writeJson(store.conversationsPath(), all);
}

/**
 * Create a room around one agent.
 *
 * The common case, and the shape every migrated conversation takes: you and
 * one agent, in `open` mode, which behaves exactly as a single-agent chat
 * always has.
 */
export function createConversation(patch: {
  agentId: string;
  agentName: string;
  id?: string;
  title?: string;
}): ConversationRecord {
  const now = Date.now();
  const record: ConversationRecord = {
    // Reusing the agent id as the room id for a migrated conversation is
    // what lets the existing transcript file stay exactly where it is.
    id: patch.id ?? patch.agentId,
    title: patch.title ?? patch.agentName,
    kind: 'direct',
    participants: [
      localHuman(),
      { kind: 'agent', id: patch.agentId, handle: handleFor(patch.agentName) },
    ],
    mode: 'open',
    createdAt: now,
    updatedAt: now,
  };

  saveConversations([...listConversations(), record]);
  return record;
}

/**
 * Create a room that belongs to nobody.
 *
 * The difference from `createConversation` is the whole point of this
 * restructure: the id is the room's own (`room_…`), not an agent's, so the
 * room stops being its first member. Deleting any one agent leaves the room
 * intact, the header has something to describe other than a model, and
 * Configure has a room to configure.
 *
 * A room has no model and no provider, and there is no parameter here for
 * one. Agents arrive already configured; a room that could set a model would
 * make the same agent answer differently depending on which room it was
 * spoken to in, which is exactly the confusion rooms are meant to end.
 *
 * Two members minimum, enforced rather than advised: a group of one is a
 * direct chat wearing the wrong clothes, and every screen that renders a
 * room would then have to cope with a room that is not one.
 */
export function createRoom(patch: {
  title: string;
  members: { id: string; name: string }[];
  greeting?: string;
  mode?: ConversationRecord['mode'];
  id?: string;
  /**
   * Start the room with what has already been said in another conversation.
   *
   * The second creation path in `docs/ROOMS.md`: adding an agent to a
   * one-to-one asks whether to start fresh or bring the history, because
   * neither is right for every case. Without the history the newcomer
   * arrives with no idea what has been discussed; with it, the user may be
   * handing a whole private conversation to an agent that was not part of
   * it. That is a decision, so it is a question.
   *
   * The source is COPIED, never moved. The original chat is untouched — the
   * user asked to start a group, not to lose the conversation they were in.
   */
  fromConversationId?: string;
}): ConversationRecord {
  if (patch.members.length < 2) {
    throw new Error('A group needs at least two agents. With one, use a direct chat.');
  }

  const now = Date.now();
  const handles: string[] = [];
  const agents: AgentParticipant[] = patch.members.map((m) => {
    const handle = handleFor(m.name, handles);
    handles.push(handle);
    return { kind: 'agent', id: m.id, handle };
  });

  const record: ConversationRecord = {
    id: patch.id ?? store.newId('room'),
    title: patch.title,
    kind: 'group',
    participants: [localHuman(), ...agents],
    mode: patch.mode ?? 'open',
    greeting: patch.greeting?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };

  saveConversations([...listConversations(), record]);

  if (patch.fromConversationId) {
    const source = getConversation(patch.fromConversationId);
    const carried = store.loadTranscript(patch.fromConversationId);

    if (carried.length > 0) {
      /*
       * A line marking the seam.
       *
       * Without it the room opens mid-conversation with no explanation, and
       * an agent added halfway through cannot tell that the earlier part
       * happened somewhere else, with someone else, before it arrived. That
       * is exactly the confusion the greeting exists to prevent, one level
       * down.
       *
       * Written as a notice so it renders immediately and reads as
       * something that happened TO the room, not as somebody's message.
       */
      store.saveTranscript(record.id, [
        ...carried,
        {
          kind: 'notice',
          id: store.newId('evt'),
          level: 'info',
          text: source
            ? `Continued from "${source.title}". Everything above was said before this room existed.`
            : 'Continued from an earlier conversation. Everything above was said before this room existed.',
          createdAt: Date.now(),
        },
      ]);
    }
  }

  return record;
}

/**
 * Set or clear the room's standing instructions.
 *
 * A separate function rather than a raw `updateConversation` call so the
 * change is announced in one place and the empty string means *clear* rather
 * than "a greeting consisting of nothing" — a room with a blank greeting
 * would still print an empty instructions block into every member's prompt.
 *
 * The record it returns is what every caller shows, which is the point: the
 * greeting is visible to the user and to the agents, and there is no second
 * hidden copy anywhere for them to disagree about.
 */
export function setRoomGreeting(
  conversationId: string,
  greeting: string,
): ConversationRecord | undefined {
  const text = greeting.trim();
  return updateConversation(conversationId, { greeting: text || undefined });
}

/**
 * Create an agent together with its room.
 *
 * Every agent needs one: `sendToRoom` is now the only send path, and an
 * agent without a room cannot be talked to at all. The startup migration
 * covers agents that already existed, but said nothing about agents created
 * afterwards — which meant every NEW agent was unreachable. Found by running
 * a live conversation, not by reading the code.
 *
 * Lives here rather than in `store.ts` because the store cannot import this
 * module without a cycle: `conversations` already depends on `store`.
 */
export function createAgentWithRoom(patch: Parameters<typeof store.createAgent>[0]) {
  const agent = store.createAgent(patch);
  createConversation({ agentId: agent.id, agentName: agent.name });
  return agent;
}

export function updateConversation(
  id: string,
  patch: Partial<ConversationRecord>,
): ConversationRecord | undefined {
  const all = listConversations();
  const index = all.findIndex((c) => c.id === id);
  if (index === -1) return undefined;

  const next = { ...all[index]!, ...patch, id, updatedAt: Date.now() };
  all[index] = next;
  saveConversations(all);
  return next;
}

export function deleteConversation(id: string): void {
  saveConversations(listConversations().filter((c) => c.id !== id));
}

/*
 * Delete an agent's room along with the agent.
 *
 * Registered here rather than called from `store.ts`, which cannot import
 * this module without creating a cycle. An agent's own room shares its id,
 * so this removes exactly that one — a room the agent merely participates in
 * belongs to whoever created it and is left alone.
 *
 * Without this a deleted agent left a conversation nobody could answer:
 * it rendered in the sidebar, accepted messages, and did nothing with them.
 */
store.setAgentDeletedHook((agentId) => {
  /*
   * Only the agent's OWN direct chat goes with it.
   *
   * Before rooms had a `kind`, this deleted any room whose id matched the
   * agent's — and a group made by adding a second agent to a direct chat
   * carries the founding agent's id. So deleting the agent you happened to
   * start the group from destroyed the group, its transcript included, while
   * deleting any other member did not. That is the "undefined state" in
   * `docs/ROOMS.md`, and it was silent data loss.
   *
   * A group survives its founder: it belongs to whoever made it, and the
   * departing agent is removed like any other member below.
   */
  const own = getConversation(agentId);
  if (own && own.kind !== 'group') deleteConversation(agentId);

  /*
   * And out of every room it merely joined.
   *
   * Removing the agent's own room was not enough: it stayed listed as a
   * participant in shared rooms, so the strip still offered `@handle` and a
   * message addressed to it reached nobody. The room looked willing to
   * answer and silently would not — the same shape as the missing-room bug
   * above, one level out.
   *
   * Found by deleting one of two agents in a room and then checking the
   * other room's membership.
   *
   * The room itself survives: it belongs to whoever created it, and may hold
   * other agents and a transcript the user still wants.
   */
  for (const room of listConversations()) {
    if (!(room.participants ?? []).some((p) => p.id === agentId)) continue;
    removeParticipant(room.id, agentId, LOCAL_HUMAN_ID, 'You');
  }
});

/**
 * Record something that happened to the room.
 *
 * Written into the transcript rather than a side table, because an agent
 * added halfway through needs to know how the room reached its current
 * state — without these, a guest's arrival is inexplicable and a message
 * addressed to an agent that left reads as a mistake.
 */
export function recordRoomEvent(
  conversationId: string,
  kind: RoomEventKind,
  actorId: string,
  text: string,
  subjectId?: string,
): void {
  const event: RoomEvent = { kind, actorId, subjectId, text };
  const entry: TranscriptEntry = {
    kind: 'notice',
    id: store.newId('evt'),
    level: 'info',
    text,
    event,
    createdAt: Date.now(),
  };
  store.upsertTranscriptEntry(conversationId, entry);
}

/** Add a participant, recording who did it. */
export function addParticipant(
  conversationId: string,
  participant: Participant,
  actorId: string,
  actorName: string,
): ConversationRecord | undefined {
  const conversation = getConversation(conversationId);
  if (!conversation) return undefined;
  if (conversation.participants.some((p) => p.id === participant.id)) return conversation;

  const participants = [...conversation.participants, participant];

  /*
   * A second agent joining a direct chat makes it a group.
   *
   * Kept for now because it is what happens today, and step 1 of the
   * restructure changes no behaviour. Step 5 replaces this path: adding an
   * agent to a one-to-one will ask whether to start fresh or bring the
   * history, and either answer produces a NEW room rather than quietly
   * converting the chat the user was already in.
   */
  const kind = participants.filter((p) => p.kind === 'agent').length > 1 ? 'group' : conversation.kind;

  const updated = updateConversation(conversationId, { participants, kind });

  const label = participant.kind === 'agent' ? `@${participant.handle}` : participant.name;
  const invited = participant.kind === 'agent' && participant.invitedBy;
  recordRoomEvent(
    conversationId,
    'joined',
    actorId,
    invited ? `${actorName} invited ${label}.` : `${actorName} added ${label}.`,
    participant.id,
  );

  return updated;
}

/** Remove a participant, recording who did it. */
export function removeParticipant(
  conversationId: string,
  participantId: string,
  actorId: string,
  actorName: string,
): ConversationRecord | undefined {
  const conversation = getConversation(conversationId);
  if (!conversation) return undefined;

  const leaving = conversation.participants.find((p) => p.id === participantId);
  if (!leaving) return conversation;

  const updated = updateConversation(conversationId, {
    participants: conversation.participants.filter((p) => p.id !== participantId),
  });

  const label = leaving.kind === 'agent' ? `@${leaving.handle}` : leaving.name;
  // A guest leaving of its own accord reads differently from being removed,
  // and the difference matters to everyone still in the room.
  const text =
    participantId === actorId ? `${label} left.` : `${actorName} removed ${label}.`;
  recordRoomEvent(conversationId, 'left', actorId, text, participantId);

  return updated;
}

/**
 * Give every agent a room, once.
 *
 * Idempotent by construction: a room whose id equals the agent's id already
 * exists after the first run, so a second call finds nothing to do. That
 * matters because both hosts call this at startup and either may go first.
 */
export function migrateAgentsToConversations(): number {
  backfillKinds();

  const existing = new Set(listConversations().map((c) => c.id));
  const agents = store.listAgents();

  let created = 0;
  for (const agent of agents) {
    if (existing.has(agent.id)) continue;
    createConversation({ agentId: agent.id, agentName: agent.name });
    created++;
  }

  if (created > 0) {
    fileLog('[conversations] created', String(created), 'room(s) for existing agents');
  }
  return created;
}

/**
 * Write `kind` onto rooms that predate it.
 *
 * `listConversations` already fills it in on the way out, so nothing depends
 * on this having run — it exists so the file on disk stops needing to be
 * interpreted. Writes only when something actually changed, because a
 * rewrite that changes nothing is still a rewrite, and every write of this
 * file is a chance to lose it.
 *
 * No id is touched. Every existing room keeps its agent-derived id, exactly
 * as `docs/ROOMS.md` promises: nothing moves on disk and there is no flag
 * day. Only rooms created from here on get a `room_…` id of their own.
 */
function backfillKinds(): number {
  const raw = store.readJson<ConversationRecord[]>(store.conversationsPath(), []);
  if (!Array.isArray(raw)) return 0;

  let changed = 0;
  const next = raw.map((record) => {
    const filled = withKind(record);
    if (filled !== record) changed++;
    return filled;
  });

  if (changed > 0) {
    saveConversations(next);
    fileLog('[conversations] labelled', String(changed), 'room(s) direct/group');
  }
  return changed;
}
