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

## Small models are a first-class case

WispCrew lets people bring their own model, and a real reason to use it is
self-hosting: Ollama, LM Studio, a 7B on a laptop, a 70B on a rented GPU.
Those models follow instructions less reliably than a frontier one, and
designing only for the strong case would quietly exclude exactly the users
who chose this project for its local-first promise.

Two behaviours measured on **Llama 3.3 70B** make the point:

- Asked "what is 3 + 4?", an agent **delegated** to a general-purpose agent,
  which answered "7", which was relayed back.
- Told it could "reach the user through: app", an agent used `notify_user`
  to *answer*, sending two notifications for two questions before replying
  once.

Both were fixed, and neither fix was a stronger instruction. Three separate
prompt edits telling an agent to answer from its own knowledge changed
nothing, because **a tool that is offered gets used**. What worked was
removing the option: the default general-purpose agent is no longer a
delegate, and `notify_user` is not registered for a turn somebody is
watching.

That is the principle worth generalising:

> Make the wrong choice unavailable rather than discouraged.

It costs a strong model nothing — it would not have made those calls — and
it is the difference between working and not working on a small one. Prompt
wording is a hint; a tool registry is a fact.

**But do not expect a small model to be a large one.** Some things will
remain worse: reasoning through a long tool chain, holding a room's context,
knowing when to stop. The test is whether the *product* behaves correctly,
not whether every model is equally good at using it.

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

## What was built, and what use changed

Steps 1–4 shipped. This section records how the design above survived contact
with real use, because parts of it did not.

1. ✅ Conversation record and migration.
2. ✅ Channel participants — Telegram in **both** directions, with the
   placeholder streaming described above, and desktop-side activity mirrored
   out to a connected chat (`channel-mirror.ts`). See [TELEGRAM.md](TELEGRAM.md).
3. ✅ Per-agent-per-channel approval.
4. ✅ Multiple agents, tagging, and floor control — `floor.ts`,
   `room-turn.ts`.
5. ⬜ Cross-node replication.

**Agent-to-agent addressing works, and it was the important half.** An
agent's `@handle` mention wakes that member exactly as a person's does. The
guards are the ones sketched above: silence unless addressed, never the
author itself, and a budget of consecutive agent turns that stops the room
and says so rather than running up a bill.

It also sat broken longest. `routeAgentMessage` was written, exported,
documented and **called from nowhere** — so an agent asked to consult a
colleague wrote "@other, what do you think?" and was talking to nobody. The
rules were never the hard part; connecting them was.

**`check_agents`** was added because a room-mate could read what the others
had *said* but not tell whether one was working right now. There is
deliberately no blocking `wait_for_agent`: two agents each waiting for the
other is a deadlock no budget can unwind, and it holds a turn on both sides
meanwhile.

**Floor offers mattered less than expected.** The prediction was that their
annoyance could not be judged from the design. In practice the room is quiet
by default, `directed` mode carries the cases where control matters, and the
offer is one muted line rather than a prompt — so the question mostly
dissolved.
