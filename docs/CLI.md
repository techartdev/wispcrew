# The CLI

**Status: built, and verified on a real headless machine.** What follows is
the design; this note records what actually shipped against it.

Working today, all through the daemon protocol and none of it touching the
store directly:

| | |
|---|---|
| `serve` `status` | run the engine, and see what it would use |
| `configure` `settings` | provider, model and key, encrypted on that machine |
| `agents` `show` `create` `delete` | including creating an agent **on the machine running the command** |
| `rooms` `show` `tail` `add` `remove` | membership and transcript |
| `ask` | send a message and wait for the reply |
| `approvals` `allow` `deny` | a headless node can ask a person now |
| `tasks` `status` `wait` `cancel` | asynchronous work, on the durable turn record |
| `machines` | paired nodes |
| `capabilities` | the whole surface as JSON, for another agent |

Every command supports `--json`, `--output ndjson` and `--quiet`.

Also: `pair` / `machines` / `machines forget`, `routines`, `skills`,
`grants`, `mcp`, `history`, `providers`, `personas`, `signins`, and
`test provider` / `test telegram`.

### How complete is it?

`node scripts/cli-gap.cjs` compares every method in the bridge — the
desktop's whole surface — against what a CLI command reaches. It is a report
rather than a gate, and the number is meant to be checked rather than
remembered.

**Nine GUI-only capabilities are deliberately absent**, each because a
terminal genuinely cannot offer it: a browser sign-in, a file or directory
picker, opening a path in a file manager, window chrome, and the two
event-subscription methods, which are a push channel rather than a command.

**Nine remain unbuilt**, named rather than skipped:

| | why not yet |
|---|---|
| `createSkill` `updateSkill` `deleteSkill` | a skill is a body of instructions; editing it on a command line wants an `$EDITOR` convention this project has not chosen |
| `updateMcpServer` `setMcpToolEnabled` | per-tool toggling needs a way to name one tool of many; `mcp add`/`remove` cover the common case |
| `configureNode` | configuring *another* machine, which `wispcrew configure` run there already does better |
| `oauthImportFromCli` `listDetectedCliSignIns` | adopting a Claude Code or Codex sign-in; reachable, and touching borrowed credentials deserves its own care |
| `discoverChatId` | finding a Telegram chat id by watching for a message — inherently interactive |

**`--timeout` stays on `ask` and `tasks wait` only.** Every other command is
a single round trip that answers or fails; a timeout there would be
decoration.

## Why this is not a developer convenience

The obvious argument is that a headless machine has no window. That is true
and it is the least interesting reason.

The real one: **every coding agent already knows how to run a shell command.**
Claude Code, Codex, Cursor, Copilot, Aider, a CI job, a cron line — none of
them need an SDK, a plugin, an MCP server or a TypeScript import to use
something they can invoke.

So a CLI turns WispCrew from a thing you use into a thing other agents can
use:

```
   Claude Code (orchestrating)
        │  shell
        ▼
   wispcrew ask windows-builder "test this branch" --wait --json
        │
        ▼
   WispCrew daemon ──► the Windows machine, with its own keys
```

And the relationship runs both ways, because a WispCrew agent's shell tool
can invoke `codex` or `claude` just as readily. That makes WispCrew
**composable with the tools people already like** rather than a replacement
for them — a much easier proposition than asking someone to abandon their
coding agent.

## What makes this cheap to build

The architecture already did the hard part. `WispBridge` in
`packages/shared/src/bridge.ts` is an enumerated typed contract, and it
mentions Electron in exactly two places: a comment, and a version string in
`getAppInfo`. It is not an Electron API that happens to be typed — it is a
client/engine contract that Electron currently transports.

The daemon already serves most of it: of 56 bridge methods, 41 are already
implemented in `apps/daemon/src/methods.ts` over NDJSON. The gap is not
architectural, it is a list.

```
                     WispBridge (the contract)
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
   Electron IPC        NDJSON socket        NDJSON socket
         │                   │                   │
      Desktop               CLI              Telegram host
```

So the CLI is a third client, not a second engine.

## The rule that must not bend

**The CLI never touches storage.** Not `agents.json`, not the transcripts,
not `turns.json`.

This project already measured what happens when two processes write one JSON
store: updates are lost. That is why the desktop refuses to run its own
scheduler when a daemon owns the profile. A CLI that read or wrote directly
would reintroduce exactly that, and it would do so intermittently, which is
worse than doing it always.

```
   CLI ──► daemon protocol ──► engine ──► store
```

Always. Even on the same machine, over the local socket or named pipe the
node server already listens on.

## Two audiences, one binary

The single most important design decision, because getting it wrong makes
the tool useless to half its users.

**A human** wants readable output, colour, and a sensible default when they
omit an argument.

**A program** wants none of that. `✨ Thinking...` on stdout, a spinner, or
prose wrapped around JSON turns a parseable result into a scraping problem.

So every command supports:

| Flag | Effect |
|---|---|
| `--json` | One JSON object on stdout, nothing else |
| `--output ndjson` | A stream of events, one JSON object per line |
| `--quiet` | Suppress everything but the result |
| `--no-interactive` | Never prompt; fail instead of waiting |
| `--timeout <s>` | Bound the wait |

NDJSON matters more than it looks. The engine already **pushes** events
rather than being polled, so streaming a turn is a transport change rather
than a new mechanism:

```
{"type":"turn.started","turnId":"t1"}
{"type":"message.delta","text":"I'll inspect the log"}
{"type":"tool.started","tool":"shell","id":"tc1"}
{"type":"tool.completed","tool":"shell","id":"tc1","exitCode":0}
{"type":"turn.completed","turnId":"t1"}
```

That is trivial for another program to consume and impossible to get from a
pretty terminal.

## Command surface

Deliberately small. A large surface is a large thing to keep correct, and
most of it would be guessed rather than needed.

```
wispcrew
├── serve                     the daemon
├── status                    what is running, here and on paired nodes
├── agents  list|show|create
├── ask <agent> <prompt>      one turn, optionally --wait
├── rooms   list|create|show|send|tail|add|remove
├── tasks   create|status|wait|cancel|list
├── approvals list|show|approve|deny
├── nodes   list|pair|show|remove
├── channels list|telegram
└── version
```

### Approvals are not optional

A headless install is only headless until the first `ask` policy fires.
Without `wispcrew approvals`, the answer today is that a daemon **denies**
anything needing approval — correct, and useless if that is the only mode
available.

```
$ wispcrew approvals
ID     AGENT   NODE   TOOL   REQUEST
a81f   coder   vps    shell  git push origin main

$ wispcrew approval approve a81f
```

### Tasks, because orchestration is asynchronous

`ask --wait` blocks. An external agent usually wants to start three things
and collect them later:

```bash
WIN=$(wispcrew task create windows-builder "test $SHA" --json | jq -r .taskId)
LIN=$(wispcrew task create linux-builder   "test $SHA" --json | jq -r .taskId)
MAC=$(wispcrew task create mac-builder     "test $SHA" --json | jq -r .taskId)

# ... do local work ...

wispcrew task wait "$WIN" "$LIN" "$MAC" --timeout 900 --json
```

A task is a turn with a handle. The durable `TurnRecord` added in
`turns.ts` is already most of what that needs.

### Discovery, so an agent can learn the tool

```
wispcrew capabilities --json     what this installation supports
wispcrew agents --json           who exists, where, and with which tools
wispcrew commands --json         machine-readable command definitions
```

A generic model parsing `--help` prose is a worse experience than reading a
schema, and the schema cannot drift from the implementation if it is
generated from it.

## What the CLI must not become

**Not a remote shell.** `wispcrew node shell vps "rm -rf /"` would be a
convenient way to destroy the security model. Execution belongs to an agent
turn, where the approval policy of the node that runs it applies. The CLI
asks an agent to do something; it does not reach past the agent.

**Not an approval bypass.** A command that approves its own request would
make the whole policy decorative.

## Relationship to MCP

Both, eventually, and not one instead of the other.

- **CLI** works with anything that has a shell, which today is everything.
- **MCP** is better where a native structured integration already exists.

They are two transports over the same daemon protocol, which is the point of
keeping `WispBridge` transport-independent.

## Where this sits

Higher than polishing Telegram group orchestration. Telegram makes WispCrew
reachable by *people*; the CLI makes it reachable by *everything else*,
including the coding agents its users already have open.

It should not start before the conversation model settles, because the room
and task commands are the interesting half and they would need rewriting.

**Today** `examples/cli-agent` exists and is a headless test client, not this.
It talks to the engine in-process, which is exactly what the rule above
forbids for a real CLI. It should stay what it is — the offline suites live
there — and `wispcrew` should be built as a separate client of the daemon.
