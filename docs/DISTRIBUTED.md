# Detaching the engine

A design note. This is the architecture WispCrew is moving to, why, and the
decisions that are expensive to reverse.

## The problem

Today WispCrew is a desktop app that happens to contain an agent engine.
Close the window and everything stops: scheduled routines do not fire, MCP
servers shut down, a long task dies mid-turn. The agent only exists while you
are looking at it.

That is the difference between a chat client and an agent platform. A tool
that only works while its GUI is open is an assistant you have to babysit.
The competing products people compare us to run the agent on a machine that
is always on, and the user's laptop is merely a window onto it.

We are not going to sell hosted VMs — that contradicts local-first and would
make WispCrew a service rather than a program you own. But the *capability*
gap is real, and it is the difference between "another local agent app" and
something worth choosing.

## The shape

Split the app in two along a seam that already almost exists:

```
   ┌──────────────────────────────┐
   │   Desktop app (a client)     │   the window
   │   React UI, panels, chat     │
   └───────────────┬──────────────┘
                   │  WispBridge (same API as today)
   ┌───────────────▼──────────────┐
   │   wispcrew serve (a daemon)  │   the engine
   │   store · scheduler · agents │
   │   MCP · grants · secrets     │
   └──────────────────────────────┘
```

The daemon owns everything durable. The UI owns nothing but presentation.

**This is less work than it sounds.** Of the eighteen modules in the main
process, only four touch Electron:

| Electron-bound | Already headless |
|---|---|
| `main.ts` (window, menu, lifecycle) | `store`, `scheduler`, `cron`, `agent-sessions` |
| `bridge-host.ts` (IPC transport) | `mcp-manager`, `grants`, `delegation`, `branching` |
| `secrets-store.ts` (`safeStorage`) | `attachments`, `oauth-store`, `provider-keys`, `settings-file` |
| `userdata-migration.ts` (`app.getPath`) | every `packages/*` — none import Electron |

The engine is not trapped in the desktop app. It is sitting inside it, almost
free already. The four exceptions each have an obvious headless counterpart:
a config directory instead of `app.getPath`, and file-based encryption
instead of `safeStorage` where no OS keychain exists.

## Nodes

Once the engine is a daemon, "where does this agent run?" becomes a real
question with a useful answer.

```
        Desktop app
             │
   ┌─────────┼─────────────────┬──────────────┐
   ▼         ▼                 ▼              ▼
 local    home server        VPS            Raspberry Pi
 daemon   (always on)     (public IP)      (on your LAN)
```

A **node** is any machine running `wispcrew serve`. Each agent is assigned to
one. The default is `local`, so a user who never configures anything gets
exactly today's behaviour.

What a node owns:

- its own store (agents, transcripts, routines, skills)
- its own secrets — **keys are never transported between nodes**
- its own workspace root
- its own MCP servers

What crosses the wire: the bridge API, and nothing else. A node is not a
worker executing instructions from a coordinator; it is a full WispCrew that
happens to be steered from elsewhere.

### Why keys stay put

The tempting design is a single keychain on the desktop, pushed to nodes as
needed. It is wrong. A VPS that never receives your OpenAI key cannot leak
it, and a compromised node should cost you that node's credentials, not
every credential you own. You configure each node's providers on that node —
through the UI, but stored there.

This also means a node can use credentials the desktop does not have, which
is the point: a home server signed into your CLI tools, a VPS with a scoped
deploy key.

## Trust between nodes

Pairing, not accounts:

1. On the node: `wispcrew serve --pair` prints a short code and a fingerprint.
2. In the desktop app: add a node, enter host and code.
3. The two exchange a long-lived per-node token over TLS; the code expires in
   minutes and is single-use.

No WispCrew servers exist in this flow. No account, no relay, nothing to sign
up for, and it works on a LAN with the internet down. This is the same shape
as pairing a device you own, and deliberately unlike "log in to our cloud".

**This is a remote-code-execution surface and must be treated as one.** The
daemon runs shell commands. Therefore, non-negotiably:

- Bind to `127.0.0.1` by default. Exposing a port is an explicit act.
- No token, no service — refuse to start rather than run open.
- TLS always, self-signed accepted, fingerprint pinned on first pair.
- The approval policy is evaluated **on the node that executes**, so a
  remote node cannot be talked into skipping it.

## What this does not become

Worth stating, because scope creep here is fatal:

- **No hosted infrastructure.** We do not run machines for users. Users bring
  their own, which is why it stays MIT and free.
- **No accounts or billing.** Pairing is between your devices.
- **No central coordinator.** Nodes do not know about each other; the client
  knows about nodes.
- **No agent migration.** An agent belongs to a node. Moving one is an
  explicit export/import, not a live handoff — and pretending otherwise
  invites split-brain on the store.

## What is built

Steps 1–4 are done and verified end to end.

| | Evidence |
|---|---|
| Headless runtime | 18 modules, zero Electron imports |
| `wispcrew serve` | a routine fired with no UI open, against a live model |
| Desktop as a client | app quit, daemon kept serving, transcripts intact |
| Pairing over TLS | a real `--network --pair` daemon paired and driven |

The pairing implementation deviates from the sketch above in one way worth
recording: the **certificate is generated in-process** rather than by
shelling out to `openssl`, because a stock Windows machine has none on PATH.
The DER is assembled by hand in `node-tls.ts` — about eighty lines — which
removes a runtime dependency from a security path at the cost of code that
must be read carefully. It is verified against Node's own TLS stack rather
than trusted.

Two bugs that this uncovered are worth remembering:

- `serveNode` listened for `connection`, which on a `tls.Server` fires with
  the **raw TCP socket before the handshake**. Frames were read as
  ciphertext, so the node silently ignored everything. It now selects
  `secureConnection` when handed a TLS server.
- A refusal was sent and then the socket `destroy`ed, which discards buffered
  writes — so "wrong pairing code" arrived as an unexplained disconnect.

## Order of work

Deliberately sequenced so each step is useful alone, and so the seam is
proven before anything is distributed:

1. **Extract the engine** into a headless package with no Electron imports.
   Nothing user-visible changes.
2. **`wispcrew serve`** — the daemon, on `127.0.0.1`. The desktop app starts
   one automatically and connects to it. *Now cron survives closing the
   window*, which is the single biggest win and needs no networking.
3. **Node pairing and remote transport.** Mostly transport work once the
   seam is real.
4. **Per-agent node assignment** in the UI.

Building 3 before 1 would bake the wrong boundaries into the protocol, which
is why the order matters more than the speed.

## Open questions

Honest about what is not decided:

- **Streaming over a remote link.** Locally, transcript entries are pushed as
  events. Over a network that needs reconnection and replay, or a turn that
  survives a dropped connection looks like a hung agent.
- **Which node does the UI show by default?** Probably the last used, but a
  node being offline needs to read as "offline", not "empty".
- **Attachments to a remote node.** Files are read from the client's disk
  today. Either they are uploaded, or the tool runs where the file is.
- **Windows as a node.** Straightforward to run; less obvious how it is
  installed as a service compared to systemd.
