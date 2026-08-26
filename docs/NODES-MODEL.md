# What a node is, and what it is not

Written after checking a user's mental model against the running system,
because four of five parts matched and the one that did not is load-bearing.

## What matches

**A node is a headless service that owns its own everything.** Verified on a
real VPS: `agents.json`, `conversations.json`, `transcripts/`, `workspace/`,
its own settings, its own TLS certificate, and its own encrypted key file. No
OS keychain on a server, so it uses a machine-local key file instead.

**Keys never leave the node that owns them.** A compromised machine costs that
machine's credentials rather than every credential the user has. This is why
`configureNode` sends a key the user typed *for* that node rather than
copying one across.

**A node keeps working with no client attached.** Routines, watches and
self-scheduled follow-ups run whether or not anyone is looking.

## What does not match, and why it matters

> "nodes can connect to each other, any of the remote nodes can request agent
> to be created, added in room or whatever from a connected node"

**Nodes do not know about each other.** `docs/DISTRIBUTED.md` is explicit:
there is no coordinator, and only the client holds the registry of paired
machines. A node has no idea any other node exists.

```
        NOT THIS                          THIS
   ┌──────┐   ┌──────┐              ┌──────┐   ┌──────┐
   │ vps  │───│ home │              │ vps  │   │ home │
   └──────┘   └──────┘              └───▲──┘   └──▲───┘
                                        └────┬────┘
                                          client
```

That is a deliberate trade, not an oversight. Peer connections would need
every node to hold every other node's address, token and trust — so pairing
becomes O(n²), a compromised node learns about all the others, and a machine
behind NAT needs inbound reachability it does not have.

The cost is real and is stated rather than hidden: **a cross-machine room
needs a connected client.** Single-machine agents and routines are
unaffected.

### How to lift that limitation, when it becomes worth lifting

The blocker is not trust or addressing — those are solved by pairing. It is
**reachability**: a laptop behind NAT cannot accept an inbound connection, so
even two nodes that trust each other have no way to meet.

A relay solves it, and there is a well-worked design to borrow the *shape*
of: [SCP2P](https://scp2p.com/) (§10, "NAT and reachability"). Three ideas
are worth taking:

**Reachability is a state, not an assumption.** A node is `direct` (accepts
inbound), `outbound-only` (can dial, cannot be dialled), or `relayed`. Today
WispCrew assumes every node is `direct`, which is why a home machine can only
ever be reached by a client that dials it.

**A relay is an ordinary node with a flag.** Not a service, not
infrastructure, not something this project runs. A VPS the user already owns
sets `relay = true`, and their laptop registers an outbound connection to it:

```
   laptop ──outbound──► vps (relay) ◄──dials── home server
   (behind NAT)                                (behind NAT)
```

Both ends dial *out*, which every NAT permits. That is the whole trick, and
it fits this project's "no central service" stance exactly — the relay is a
machine the user chose, holding a slot, not their data.

**Relay carries control, not bulk.** SCP2P's own caveat, and the right one:
a relayed stream is for reaching a peer, not for shifting content through it.
Agent turns are small — a prompt, a reply, tool results — so this suits them
and would not suit file transfer.

**The idea, not the implementation.** SCP2P is Rust, QUIC and CBOR; WispCrew
is Node, TLS and NDJSON. Adopting the stack would mean a Rust dependency in a
project whose stated rule is to prefer readable local code, and a wire format
nobody can read in a log — this project has repeatedly found bugs by reading
the wire. What transfers is the *design*: three reachability states, a
slot-based relay role any node can take, and control-only traffic through it.

One further idea worth remembering when pairing is next touched:
`NodeId = SHA-256(public key)` makes a node's name *be* its key, so it cannot
be impersonated by a re-issued certificate and stays stable across
reinstalls. WispCrew pins a certificate fingerprint instead, which works and
is weaker. Not worth a migration on its own; worth doing if pairing changes
for another reason.

**Not now.** The CLI comes first, and single-machine use — which is nearly
everyone — does not need any of this.

## Agent visibility

> "a node can have agents locally which are not directly exposed to remote
> node, only remotely created agents by the remote node are available to it"

Close to what happens, by accident rather than design.

A node's `listAgents` returns its own roster, and the client never calls it —
`listAgents` is neither client-only nor agent-scoped, so it always runs on the
local engine. The result is that a node's own agents are **invisible**, not
merely unexposed.

That is wrong for the case that matters. Someone who configures a server over
SSH creates agents there, and the desktop then shows nothing. Your suggestion
is the right shape:

> "agents in remote node cannot be created but should be discoverable if
> flagged"

**Discoverable, opt-in, adoptable.** A node's agent stays private unless it is
marked shared; a shared one appears in the client as belonging to that
machine, and can be added to a room. The alternative — every node's roster
merging into the client automatically — makes a shared server leak its
occupants to whoever pairs with it.

Not built. It is the natural companion to the CLI, because it only matters
once people are creating agents on machines directly.

## The ordering question

> "desktop app or cli needs to be available before we have real working nodes,
> cli especially for headless hosts"

Correct, and demonstrated the hard way: setting up this VPS took SSH, a manual
`git clone`, a build, and a hand-copied pairing code. Every one of those is a
step a `wispcrew` command should own.

See [CLI.md](CLI.md). The relevant part here is that a node is already a
complete engine speaking a typed protocol — the CLI is a third client of it,
not new machinery.

## Bugs this exercise found

Assigning an agent to a machine had never actually worked end to end. Three
faults, each invisible until a real VPS was involved:

1. **`createAgent` dropped `nodeId`.** Its record is built field by field, so
   an unlisted field vanishes silently — the caller asked for a remote agent
   and got a local one with no error. The same omission has now cost three
   fields (`runAt`, `channelPolicies`, `nodeId`), so there is a suite that
   round-trips every settable field.

2. **A node could not be given a key.** Method routing keys on the first
   argument being an agent id, and settings have no agent, so `writeSettings`
   always reached the local daemon. A remote agent therefore had no way to
   reach a model. Fixed with `configureNode`, which addresses a node directly.

3. **`createAgent` never reached the node.** Same routing limitation, and
   worse here: the agent does not exist yet, so there is no id to route by.
   The agent was created locally with a `nodeId` pointing at a machine that
   had never heard of it — right node in the UI, no transcript, no workspace,
   no engine, and a message to it went nowhere and reported nothing.

Also fixed: the Machines panel fetched reachability once at startup, before
background links opened, and never again — so a connected machine was
displayed permanently as "not reachable".

## Can a headless machine hold a client registry?

**Yes, and it should.** The question came up because pairing writes to the
*client's* registry, and the CLI talks to a node — so `wispcrew pair` looked
like it needed a design decision before it could exist.

It does not. `nodes.json` lives in the data directory, which a daemon already
owns, and `addNode` / `listNodes` / `removeNode` take a `dataDir` and import
no Electron. Nothing about the registry is desktop-specific; it was simply
only ever written by the desktop.

What the desktop genuinely adds is **dialling**: `connectKnownNodes` opens
links at startup and `routeForCall` sends agent-scoped calls to the machine
that owns the agent. A daemon does neither, so a node that stores a peer
would remember it and never talk to it.

So the split is:

| | desktop | daemon |
|---|---|---|
| pair, list, forget | yes | **yes** (new) |
| dial known nodes at startup | yes | not yet |
| route an agent's calls to its node | yes | not yet |

`wispcrew pair` is therefore useful immediately — it attaches a machine and
records the credential — and becomes *fully* useful when a daemon dials its
peers too. Doing the first without the second is honest as long as the
limitation is stated rather than discovered.

## A node forgets its clients when it restarts

Found while verifying the fix below: a paired client stopped connecting, with
`The node refused the connection (wrong token, or it is not accepting
clients)`. The fingerprint still matched, so pinning was fine.

**Client tokens live only in memory.** A node has no file holding them, so
every restart invalidates every pairing and each client must pair again with
a fresh code — which nobody would guess from the error, and which makes a
node that restarts on boot effectively unpairable.

Not fixed here. The shape of the fix is clear — persist the issued tokens
beside the certificate, encrypted with the node's own key file, since they
are credentials of exactly the kind `secrets-store` already handles — but it
is a separate change from the CLI work and deserves its own verification.

## Fixed: creating an agent on a node

**Now working, and verified on the real VPS**: an agent created from the
desktop with a `nodeId` is created on that machine, keeps its `nodeId` in the
client's roster, and appears on the node under the same id. The account below
is kept because the three wrong attempts are the useful part.

`routeForCall` now sends `createAgent` to the node named in the patch, which
is right: the node creates the agent in its own store, with its own workspace
and engine. But the record it returns describes the agent *as the node sees
it* — and a node does not know its own id in the client's registry, because
that id is the client's name for it. So the client stores an agent with no
`nodeId`, and the next call about that agent routes locally.

The agent then exists on both machines and belongs to neither.

Three attempts, three different wrong places:

1. In the desktop handler — dead code, because `createAgent` is forwarded
   before any handler body runs.
2. In `routeForCall` — right place, wrong direction: the return value is the
   node's, not the client's.
3. **The fix**: the client stamps its own `nodeId` onto whatever the node
   returns, and mirrors the record into its roster under the same id. Only
   the client knows that id, because it is the client's name for the machine.

   The precedent was already there — `getSettings` is corrected on return for
   the same reason, because encryption at rest is a property of the receiving
   machine rather than the answering one. A value crossing a boundary needs
   the receiver's view added back.

The fix is small. The reason it is not made yet is the next section.

## Why this is the wrong thing to be fixing

Reaching a state where these bugs are even *reachable* took SSH, a manual
`git clone`, an `apt` install, a build, a hand-copied pairing code, and a
provider key extracted from a local profile by a purpose-written probe.
**None of that is a supported path.** A user cannot do any of it.

So the order matters more than the bug list:

1. **The CLI**, so a headless machine is set up without SSH and guesswork —
   `wispcrew serve`, `wispcrew pair`, `wispcrew agents create`.
2. **Node-side agent creation**, which then becomes a command run *on* the
   machine that owns the agent, rather than a remote-creation protocol at
   all. Most of the difficulty above disappears rather than being solved.
3. **Discoverable agents**, so one created on a server appears in the client
   when flagged shared.

Written down after three rounds spent fixing faults downstream of a setup
process that does not exist. The bugs were real and worth fixing; continuing
past them would have been building on sand.
