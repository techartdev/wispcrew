# Conversations

A design note. This is the model GhostBot is moving to, why the current one
runs out, and the decisions that are expensive to reverse.

## The problem

Today a transcript is `f(agentId)` — one conversation per agent, and nowhere
else for a conversation to live. That was fine while GhostBot was one person
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
   Conversation "Cross-platform test run"
     ├── agent:   Linux builder      (on node "vps")
     ├── agent:   Windows builder    (local)
     ├── agent:   macOS builder      (on node "mini")
     ├── channel: desktop            (this app)
     └── channel: telegram           (your phone)
```

A participant is an **agent** or a **channel**. That single idea answers all
three problems:

- *Talking from your phone* is adding your Telegram as a participant. It then
  receives the history because it is **in** the conversation, and messages
  you send arrive as ordinary user turns.
- *Agents working together* is adding several agents. They share one
  transcript, so each sees the others' work.
- *More places* is another kind of channel participant. The conversation does
  not change.

A conversation starts with one agent, which is the setup step and the common
case. Everything else is adding participants later.

### Why a channel is a participant, not a delivery target

The current code treats channels as somewhere to *send* — a queue with
`desktop` and `telegram` as destinations. That is the right transport and it
stays, but it is the wrong **concept** for two-way conversation, because a
delivery target has no identity in the discussion. It cannot be addressed, it
cannot contribute, and nothing about the conversation records that it is
present.

As a participant, "make this chat work from my phone" is one action with an
obvious inverse. That is the shape you described, and it is better than what
I had been sketching.

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
