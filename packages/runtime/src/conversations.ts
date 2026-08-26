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
import { handleFor } from '@wispcrew/shared';
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

/** Every room, newest first. */
export function listConversations(): ConversationRecord[] {
  const all = store.readJson<ConversationRecord[]>(store.conversationsPath(), []);
  return Array.isArray(all) ? [...all].sort((a, b) => b.updatedAt - a.updatedAt) : [];
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
  deleteConversation(agentId);
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

  const updated = updateConversation(conversationId, {
    participants: [...conversation.participants, participant],
  });

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
