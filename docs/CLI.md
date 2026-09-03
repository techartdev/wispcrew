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

Fifty-eight commands. The fifty-six that take arguments are described by `COMMAND_SCHEMA` in
`apps/daemon/src/cli-commands.ts` — `wispcrew capabilities --json` prints it,
and `scripts/check-cli-methods.cjs` fails the build if any of them calls a
method the daemon does not have.

```
wispcrew
├── serve                       the daemon, with no window
├── status                      what is running, here and on paired nodes
├── configure                   provider, key, workspace, policy
├── settings                    read the current configuration
│
├── agents  show|create|set|duplicate|delete|stop
├── ask <agent> <prompt>        one turn, optionally --wait
├── context <agent>             how full the context is; --compact to reclaim
│
├── rooms   show|tail|new|say|greeting|add|remove
│           mode|clear|rewind|branch|delete
├── history restore             recover a previous transcript version
│
├── tasks   status|wait|cancel  work started with --detach
├── approvals allow|deny        answer a headless node's request
├── routines create|run|pause|resume|delete
│
├── providers | models | personas | skills
├── mcp     add|remove
├── grants  revoke              standing tool permissions
├── test    provider|telegram   prove a credential works
├── signins | signout           subscription sign-ins
│
├── pair                        attach this machine to another
└── machines forget
```

Two flags on `agents set` exist because this build cannot always infer them:

- `--context-window <tokens|auto>` — only needed for a model the build does
  not recognise, such as a self-hosted endpoint. Without it there is no
  percentage and **no automatic compaction**, because guessing a window is
  how a tool discards history with most of the context still free.
- `--reasoning-effort <level|default>` — refused for a model that has no
  such control, and refused for a level that model does not accept. The
  accepted values differ by model, not merely by provider.

### Approvals are not optional

A headless install is only headless until the first `ask` policy fires.
Without `wispcrew approvals`, the answer today is that a daemon **denies**
anything needing approval — correct, and useless if that is the only mode
available.

```
$ wispcrew approvals
ID     AGENT   NODE   TOOL   REQUEST
a81f   coder   vps    shell  git push origin main

$ wispcrew approvals allow a81f
```

### Tasks, because orchestration is asynchronous

A task is a turn with a handle, and `turns.ts` is the durable record behind
it. **What exists today is the reading half:**

```bash
wispcrew tasks                   # every turn, past and present
wispcrew tasks status <id>       # one of them; a prefix is enough
wispcrew tasks wait <id>         # block until it settles, non-zero if it failed
wispcrew tasks cancel <id>
```

**What does not exist is a way to START one without waiting.** `ask` and
`rooms say` block until the turn finishes, so the fan-out an external agent
actually wants —

```bash
# NOT possible today: there is no detached start.
WIN=$(wispcrew ask windows-builder "test $SHA" --detach --json | jq -r .taskId)
```

— has no command. The turn record, the states and `tasks wait` are all
there; the missing piece is one flag that returns the id instead of the
answer. It is listed here rather than in the tree above so that nobody reads
the tree and assumes it works: this document previously showed a `task
create` example for a command that has never existed.

### Discovery, so an agent can learn the tool

```
wispcrew capabilities --json     what this installation supports,
                                 including every command's schema
wispcrew agents --json           who exists, where, and with which tools
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
