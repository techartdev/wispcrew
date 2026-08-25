# Conversations

A design note. This is the model WispCrew is moving to, why the current one
runs out, and the decisions that are expensive to reverse.

## The problem

Today a transcript is `f(agentId)` — one conversation per agent, and nowhere
else for a conversation to live. That was fine while WispCrew was one person
typing to one agent in one window. Three things it cannot express:

**Talking to an agent from your phone.** Delivery works: an agent can send
you a Telegram message. But a *reply* has nowhere to go. There is no
conversation the phone is part of, only an agent that happens to have your
chat id.

**Several agents working together.** You described wanting a project tested
on Linux, Windows and macOS by three agents sharing one task. There is no
room for them to share — only `ask_agent`, where one agent calls another and
gets an answer back. That is delegation, not collaboration: the callee never
sees the discussion, and neither sees the other's work.

**More than one place.** Telegram is not the last channel. Slack, Matrix,
email, a webhook. Bolting each onto "an agent has a chat id" multiplies a
mistake.

## The model

A **conversation** becomes the root record. It has participants.

```
   Room "Cross-platform test run"
     ├── human:   you                 (desktop, telegram)
     ├── human:   a colleague         (desktop)
     ├── agent:   Linux builder       (on node "vps")
     ├── agent:   Windows builder     (local)
     └── agent:   macOS builder       (on node "mini")
```

A participant is a **human** or an **agent**. A **channel** is how a
participant reaches the room — not a member of it.

That distinction took a correction to arrive at. An earlier draft made a
channel a participant alongside agents, with no humans at all, which quietly
assumed a single user. Two problems follow. A colleague could never join,
which is a strange limitation in something called a crew. And attribution
comes out wrong: a message from your phone is **"you, via Telegram"**, not
"Telegram said" — the channel has no opinions and no memory, it is a door.

So a human participant has one identity and any number of channels. Sitting
at the desktop or replying from a train are the same person in the same
conversation, which is exactly the property that makes leaving the house
harmless.

That answers all three problems:

- *Talking from your phone* is attaching Telegram to yourself. The room then
  reaches you there, and what you send arrives as your own turn — the same
  turn it would have been from the desktop.
- *Agents working together* is adding several agents. They share one
  transcript, so each sees the others' work.
- *Someone else joining* is adding another human. Nothing else changes.

A room starts with you and one agent, which is the setup step and the common
case. Everything else is adding participants later.

### Guests

Membership does not have to be permanent. An agent may bring another agent
into a room for a specific problem, and that agent may leave when it is done:

```
You      Why is this container crashing?
Dev      This looks infrastructure-specific. Bringing Infra in.
—        Infra joined, invited by Dev.
Infra    The OOM killer took it at 03:12; the memory limit is 512MB.
—        Infra left.
```

This falls out of membership being recorded as events rather than kept as
state: a join is a thing that happened, at a time, caused by someone. Without
that record a guest's arrival would be inexplicable to everyone else in the
room, which is the same reason the events exist at all.

An agent inviting another is a real grant, so it goes through approval like
any other consequential act — but as one decision, not one per message. What
it must not become is an agent quietly assembling a committee.

### Why a channel belongs to a participant, rather than being one

The existing code treats channels as somewhere to *send* — a queue with
`desktop` and `telegram` as destinations. That transport is right and it
stays. What it lacks is any record that a conversation is **reachable** from
somewhere, which is what makes two-way work: "make this chat work from my
phone" should be one action with an obvious inverse.

An earlier draft of this document solved that by making a channel a
participant. That was wrong, and the body above now says so — a channel has
no identity, no memory and no opinions. It is a door. Attaching it to a
person keeps the attribution honest: a message from your phone is
**"you, via Telegram"**, not "Telegram said".

This heading survived the correction for a while and contradicted the section
it sits under, which is a good argument for reading a document end to end
after changing its central claim.

## What is actually distinctive

Multi-agent group chat is not a differentiator. GrokBot reportedly has it
already — several bots in a room, `@name` addressing, agents handing work to
each other, persistent membership. I could not confirm the specifics from
public documentation, so treat that as reported rather than verified; but it
is safest to assume the feature itself is table stakes.

What is not table stakes is **where the room can be reached from**.

If a room is a first-class record with participants, then a UI is just one
door into it. The desktop app is a door. Telegram is a door. A future web
view is a door. The conversation does not live in any of them.

```
                    Room
                     │
     ┌───────────────┼───────────────┐
   human            agents        channels
     │                              (doors)
  ┌──┴──┐                        ┌────┴────┐
desktop telegram              desktop   telegram
```

So the same conversation continues when you leave the house, and a reply
typed on a train is your turn in the room rather than a message to a
side-channel bot. Later, at the desk:

```
08:31  Architect
08:35  Coder
08:36  You · via Telegram
08:41  Coder
```

That, plus being open source, self-hosted, and able to run agents on machines
the user already owns, is a more defensible identity than "we also have group
chats". The honest one-line version:

> Open-source AI teammates you can reach from anywhere. One conversation —
> humans and agents, desktop and phone.

## Open problems, and what an outside review found

A review of these documents raised several points that were right and are
recorded here rather than quietly absorbed.

### A turn should be a durable record, before cross-node work starts

Today "who is running" is an in-memory `Map` in `agent-sessions.ts`, keyed by
agent. That is enough for one machine with a window open, and it cannot
answer the question a distributed room asks constantly: *is this message
already being worked on?*

Consider a node that receives `@windows run the tests`, starts, loses its
connection, reconnects, and sees the same replicated message. Stable entry
ids stop the transcript being duplicated. They do **not** stop the tests
being run twice — and once these are deployments or `git push`, that
distinction is expensive.

So a turn wants to be a thing with an identity:

```
Message  m_123
   └── Turn t_981   agent=@windows  node=vps
         state: claimed → running → awaiting_approval → completed
```

A great deal then has an obvious home rather than being scattered across
runtime state, transcript entries and transport behaviour: reconnection,
duplicate suppression, Stop, approval waits, Telegram progress, the
consecutive-turn budget, and "who is speaking right now".

**Not yet built.** It is the right next structural change, and it should
land before cross-node rooms rather than after.

### Ordering needs causality, not just timestamps

The merge rule here is union by id, ties broken by `(createdAt, authorId)`.
That is deterministic, and determinism is not the same as being correct.

With clocks a few seconds apart, an answer can sort *before* the question it
answers — every reader then sees a room where an agent replied to something
nobody had said yet. A monotonic per-author sequence number, or a
`parentId` naming the entry a reply was caused by, fixes it without adopting
a full CRDT.

### Who carries a cross-node conversation when nobody is watching

`docs/DISTRIBUTED.md` is explicit that nodes do not know about each other and
there is no coordinator; only the client knows the nodes. This document
describes a conversation replicated across every participating node. Both can
be true, but something has to move the bytes.

Three options, and honesty about which is real:

- **Client-relayed.** The desktop carries room traffic. Simple, and
  multi-node rooms pause when it is closed.
- **A room host.** One node sequences for the room, with failover.
- **Peer replication.** Nodes connect directly. Genuinely distributed, and
  considerably more to get wrong.

The local-first choice is the first one, said plainly in the interface —
*cross-node collaboration needs a connected client; single-node agents and
routines keep running regardless.* Anything else is a claim this project has
not earned yet.

### A guest must not borrow the authority of whoever invited it

Delegation already narrows privilege: a delegate never exceeds its caller.
The same rule has to apply to an invited agent. Bringing a more privileged
agent into a room must not lend it the inviter's authority, or "invite" turns
into a privilege-escalation path.

## What this does *not* mean

**Not per-channel sessions.** OpenClaw keeps separate sessions per IM
provider. That suits a bot with many users; it is wrong here. An agent that
remembers what you said on your phone but not at your desk makes you repeat
context and can contradict itself between channels. One conversation, many
windows onto it.

**Not a broadcast.** Adding two agents does not mean both answer everything.
Turn-taking is designed below, because "two agents in a room" without it
produces either silence or a loop.

## Approval

Approval becomes **per agent, per channel**.

A keyboard you are sitting at and a chat reachable by anyone who compromises
your Telegram account are not the same risk, so they should not share one
policy. The resolution order:

```
conversation participant policy   (this agent, in this conversation)
  └─ agent policy                 (this agent, anywhere)
      └─ global default           (ask)
```

Every level may be set to `ask`, `auto` or `readonly`. A user who wants YOLO
sets `auto` and gets it — including remotely, if they choose. The default
stays `ask`, and a remote channel defaults to `ask` even when the agent is
`auto` locally, because that is the difference the split exists to express.

The approval *request* already carries everything needed; what changes is
where the answer can come from. A channel participant that can answer
approvals is a channel that can authorise shell commands, so that is a
per-channel setting a user turns on deliberately.

## Turn-taking

The part that will go wrong if it is not decided up front. Two agents in a
room, both told to be helpful, will either both answer or neither will.

**Addressed turns.** A message names its recipient — by mention in the UI, or
implicitly when there is only one agent. An unaddressed message in a
multi-agent conversation goes to whichever agent the user last addressed.

**Agents do not reply to agents by default.** An agent responds when
addressed, not because another agent spoke. Without this, two helpful agents
discussing a task is an unbounded loop that costs money. An agent may address
another explicitly — that is the collaboration — but it is an act, not a
reflex.

**A hard turn budget per conversation.** Even with the above, a chain of
explicit addresses can run away. A conversation has a maximum number of
consecutive agent-to-agent turns before it stops and asks the user.

## What happened, not just what was said

A conversation records **events**, not only messages: who joined, who left,
what was approved, who asked to speak.

This is not bookkeeping. An agent added halfway through needs to know how the
room reached its current state:

```
User added participant @linux to the chat.
User removed participant @mac from the chat.
User: Please investigate why the Linux build is failing. @windows,
      describe the problem to the linux agent and give him a task.
```

Without the first two lines, `@linux` has no idea why it is being addressed,
that `@mac` ever existed, or why nobody is speaking for macOS. These events
are part of what was said, so they belong in the transcript rather than in a
side table only the UI reads.

Four kinds:

| Event | Example |
|---|---|
| Membership | `Vanyo added @linux.` · `Dev invited @infra.` · `@infra left.` |
| Channels | `Vanyo connected Telegram.` |
| Approvals | `Vanyo approved shell access for @windows.` |
| Floor | `@macos asked to speak. Vanyo declined.` |

Events name **who** did it, not "the user". With more than one human in a
room, "User added @linux" is ambiguous — and it is equally wrong when an
*agent* brought in a guest, which is the case where knowing the cause matters
most.

Channel events matter more than they look: an agent that knows the
conversation is now reachable from a phone may reasonably keep its answers
shorter. Approval events make the authority trail visible to every
participant rather than only to whoever clicked — which matters when one
agent is about to ask another to do something it may not be permitted to do.

These reuse the existing `notice` entry kind rather than inventing a parallel
concept. Notices already render, already persist, and already survive rewind
and branch.

## Storage

`transcripts/<agentId>.json` becomes `conversations/<conversationId>.json`,
with each entry naming its author:

```ts
interface TranscriptEntry {
  // ...
  /** Which participant produced this. */
  authorId: string;
  /** Where it entered the conversation, when not the app. */
  via?: 'telegram' | 'slack' | ...;
}
```

Existing transcripts migrate to a conversation with a single agent
participant, so nothing is lost and no user has to do anything.

**Agents still belong to a node.** A conversation can span nodes — that is
the Linux/Windows/macOS case — but each agent runs where it lives, and its
tools touch that machine. The conversation is client-side state; the work is
not.

## Open questions

Honest about what is undecided:

- **Where does a cross-node conversation's transcript live?** One node
  holding it makes that node a single point of failure for a conversation
  spanning three. The client holding it means agents cannot see each other's
  messages without the client running. Neither is obviously right.
- **Streaming to a channel.** The desktop shows tokens arriving; Telegram
  gets one message at the end. A five-minute turn looks like silence.
- **Which agent does a Telegram message address** when the conversation has
  three? A `/agent` command is the obvious answer and the obvious annoyance.
- **Group chats and approval.** If three agents are working and one needs
  approval, whose attention does it get, and what do the others do while
  waiting?

## Order of work

1. **Conversation record and migration.** No behaviour change; existing
   transcripts become single-agent conversations.
2. **Channel participants.** Telegram two-way, which is the smallest useful
   thing and exercises the model.
3. **Per-agent-per-channel approval.**
4. **Multiple agents and turn-taking.**
5. **Cross-node conversations.**

Steps 1 and 2 are worth doing regardless. Steps 4 and 5 are where the open
questions above have to be answered, and I would rather answer them with a
working step 2 in hand than on paper.
