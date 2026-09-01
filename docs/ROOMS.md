# Rooms

How a shared conversation should work, and why the current shape does not.
Agreed with the project owner; written down before building because it
changes the central data model.

## The problem with what exists

A room is a `ConversationRecord` whose **id is its first agent's id**. That
single shortcut causes everything reported:

- The header shows one agent's model, because the room *is* that agent.
- **Configure** opens that agent; reaching a room-mate meant leaving the
  room, finding its own chat in the sidebar, and coming back.
- Room-level things — the tone, the purpose, who is here and why — have
  nowhere to live.
- Deleting the founding agent leaves the room in an undefined state.

It was the right shortcut to get rooms working at all. It does not survive
what rooms are now for, and it confuses both the agents and the person
using them.

## What a room is

**A place where already-configured agents talk.** Nothing more.

A room does **not** hold a model or a provider, and does not reach into an
agent's internals. An agent arrives configured; the room does not
reconfigure it. This is the correction that matters most — an earlier draft
of this document gave rooms a default model, and that is wrong: it would
make the same agent behave differently depending on where it was spoken to,
which is exactly the confusion this is meant to end.

```
Conversation
  id            room_…            its own, never an agent's
  title         "Deploy review"
  members       [agentId, …]      nobody is the root
  mode          directed | open | free
  greeting      the tone, the purpose, who is here and why
```

### The greeting

The one piece of content a room owns. It carries the tone, the core idea,
and who is participating — and it **travels with the conversation**, so an
agent reading the room knows what kind of place it has walked into.

**Visible to everyone who has joined.** Not a hidden system instruction: an
agent that can read the room's rules can follow them and can tell the user
what they are, and a person who can read them knows what their agents were
told. A rule nobody can see is a rule nobody can correct.

## Creating one

Two ways in, because the two situations are genuinely different.

### From the plus button

Today it always makes an agent. It should ask first:

- **Agent** — exactly as now, unchanged.
- **Group** — a short setup: name, greeting, and **at least two
  participants**. A group of one is a chat, and offering it would only
  produce rooms that are not rooms.

### From a conversation already in progress

Adding a second agent to a one-to-one chat is the common case, and it is
where the current behaviour is worst — the newcomer arrives with no idea
what has been discussed. So it asks:

- **Start fresh** — a new empty group with these members. The history stays
  on the original one-to-one chat, untouched.
- **Bring the history** — the group begins with what has already been said,
  so the joining agent can see where things stand and what it is joining
  in the middle of.

Neither is right for every case, which is why it is a question rather than
a default.

## Reaching an agent's settings

From inside the room. Each member carries its own cog — **shipped** — which
opens that agent's own configuration. The room is where you notice an agent
is misbehaving, so it is where fixing it should begin.

## Migration

Every existing room keeps its agent-derived id as its `id`. Nothing moves
on disk, nothing is renamed, and `members` is filled from the participants
already recorded. Rooms created afterwards get a real `room_…` id. Both
shapes work indefinitely; there is no flag day.

A one-to-one chat is a room with one member and is rendered exactly as it
is today, so the common case is untouched.

## Order of work

1. `members` and a room id, with the migration — the shape only, no
   behaviour change.
2. The greeting: stored, editable, shown to members.
3. Header and Configure move from the agent to the room.
4. The two creation paths.
5. A suite pinning the migration, and that one-to-one chats are untouched.

## Not part of this

`ask_agent` refuses a room-mate with a message that reads as a fault, which
is why an agent tried to reach one by rebuilding the application over a
shell instead of simply mentioning it. That is a wording fix and needs none
of the above.
