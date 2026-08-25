# Who speaks

A design note on multi-agent conversations, extending `CONVERSATIONS.md`.
The transcript is shared; this is about who acts on it.

## The problem

Several agents in one conversation, and every one of them helpful. Left
alone they all answer, or a chain of replies runs until someone stops it.
Constrain them tightly and the user approves every utterance, which is worse:
**a human who is asked to approve everything stops reading**. That is
[well documented](https://openleash.com/blog/human-in-the-loop-approval-fatigue)
— approval count is not a safety metric, and an oversight mechanism nobody
reads is oversight in name only.

So the design has to make the common case free and the consequential case
deliberate.

## Prior art

[AutoGen's `SelectorGroupChat`](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
has a model pick the next speaker from the shared context, with a rule
against the same agent speaking twice in a row. Its older `GroupChat`
supports round-robin, a custom selection function, and an explicit
`allowed_speaker_transitions` graph — effectively a state machine over who
may follow whom.
[Microsoft's Agent Framework](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat)
uses the same star topology with an orchestrator deciding flow.

Two things are worth taking:

- **An explicit selection step.** Somebody decides who speaks; it is never
  emergent.
- **A rule against consecutive turns.** Cheap, and it breaks the commonest
  loop.

One thing is worth rejecting: **a model as the referee by default.** An extra
model call before every turn costs money and latency, and it puts a
non-deterministic component in the position of deciding whether the user is
interrupted. For a desktop app where the human is present, the user's own
message is a better signal than a model's guess about it.

## The rule

**Everyone listens. Speaking is granted.**

Every agent in a conversation sees every message — that is what makes
collaboration possible, and it costs nothing but context. Acting is separate.

Who speaks is decided in this order:

1. **Tagged agents speak.** `@windows check the build` addresses one. Tag two
   and both speak. This is explicit and needs no approval, because the user
   just said who they wanted.

2. **An untagged message addressed to everyone reaches everyone.** "Does this
   build on your platform?" is plainly for the room. Detected by a plural
   address or an explicit `@all`, not by guessing.

3. **Otherwise the agent that speaker last addressed continues.** Tracked
   per person, not per room: with two humans present, "the last-addressed
   agent" is ambiguous, and inheriting a colleague's addressee would send
   your message somewhere you never intended. A room with one human and one
   agent therefore behaves exactly as it does today — you do not tag anybody
   to keep talking to the agent you are already talking to.

4. **An untagged agent may be offered the floor.** One short line naming who
   could answer — *"@windows, @linux could answer this."* Whoever is present
   grants it or ignores it.

   **"Listens" means the transcript, not inference.** An agent that was not
   addressed does not run. Asking every agent "do you want to speak?" after
   every message would be N model calls to decide who should make one — the
   same cost as the referee this document rejects two sections down, wearing
   a different hat. So the offer is made from the room's own state: these
   agents are present and were not addressed.

   An agent that is *already running* — because it was tagged, delegated to,
   or woken by a routine — can of course say something unprompted. That
   costs nothing extra, because the turn was already happening.

   A future *Room intelligence* setting could offer heuristic or
   coordinator-model selection for people who want it. It must stay opt-in
   and off by default: silently running N models per message is exactly the
   behaviour that makes multi-agent tools expensive to leave running.

## Making requests cheap

Your worry — constant approvals are exhausting — is the thing most likely to
sink this. Four mitigations, in order of how much they matter:

**Requests are batched, not interrupting.** Floor requests appear as one
quiet line at the end of a turn, not as modal prompts. Ignoring them is the
default and costs nothing.

**Grant duration, not utterances.** "Let the macOS builder speak" grants it
the floor for the current exchange, not for one message. Approving per
message is precisely the fatigue trap.

**A per-conversation mode.** Three settings, because different work wants
different discipline:

| Mode | Behaviour |
|---|---|
| **Directed** | Only tagged agents speak. Requests are shown but never auto-granted. |
| **Open** *(default)* | Tagged agents speak; untagged ones may request and are granted automatically unless the conversation is busy. |
| **Free** | Any agent may speak when it has something to add, subject only to the turn budget. |

Free is the YOLO setting you asked for, at conversation scope.

**A turn budget regardless of mode.** A conversation has a maximum number of
consecutive agent turns without user input. When it is reached, everything
stops and asks. This is the backstop that makes Free safe enough to offer: the
failure mode is a pause, not a runaway.

## Cross-node transcripts

You answered this: **the conversation lives on every node that participates.**

The reason is concrete. If the transcript lived on one node and the user
quoted agent 2 to request a change first addressed to agent 1, agent 2 would
need the earlier context — and without it the user has to retype. Every
participant holding the full history means any agent can be addressed about
anything already said.

That makes it a replicated log, which brings the usual difficulty: two nodes
appending at once. The mitigation is that entries are **append-only with a
stable id and an author**, so merging is a union rather than a reconciliation,
and ordering ties break on `(createdAt, authorId)`. No node is authoritative,
so no node is a single point of failure.

Not yet decided: what happens when a node is offline while the conversation
continues. Catch-up on reconnect is the obvious answer; whether an agent
should act on messages it missed is not obvious at all, and probably depends
on how old they are.

## Streaming to a channel

Solved, and OpenClaw's answer is the right one: **a placeholder message,
edited as work progresses, replaced by the final answer.**

A five-minute turn otherwise looks like silence. Telegram allows editing a
sent message, so:

1. On the first tool call, send *"Working…"*.
2. Edit it as steps complete — the tool being run, briefly.
3. Replace it with the final answer when the turn ends.

Worth noting: edits are rate-limited, so updates need throttling to roughly
one every few seconds rather than one per event. And a turn with no tool calls
should skip the placeholder entirely — a fast answer arriving directly is
better than a placeholder that flickers.

## Order of work

Unchanged from `CONVERSATIONS.md`, with this slotting into step 4:

1. Conversation record and migration.
2. Channel participants — Telegram two-way, with the placeholder streaming
   above.
3. Per-agent-per-channel approval.
4. **Multiple agents, tagging, and floor control as described here.**
5. Cross-node replication.

Steps 1–3 are worth doing regardless of how much of this survives contact
with real use. I would rather build 4 once you have used 2 and 3, because how
annoying floor requests actually are is not something I can predict from here.
