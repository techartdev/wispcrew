<div align="center">

# WispCrew

**Your AI crew, across your machines, reachable from anywhere.**

Free and MIT-licensed. Bring your own model.
No account, no subscription, no cloud component.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

</div>

---

## What it is

WispCrew runs AI agents that can actually *do* things — read and write files,
run shell commands, search code, fetch pages — on the machines you own.

Three ideas make it different from a chat window with tools:

**A conversation is a room, not a thread with one bot.** It has participants:
you, a colleague, and any number of agents. Everyone sees every message; who
*answers* depends on how you address them.

**Your agents live on your machines.** An agent belongs to one node — your
laptop, a home server, a VPS — where its workspace, its files and its provider
key stay. The Linux agent runs on Linux because that is where it is.

**A room is reachable from anywhere.** The desktop app is one door into it.
Telegram is another. A reply typed on a train is *your own turn* in the same
conversation, not a message to a side-channel bot with separate memory.

```
                      Room: "Cross-platform release"
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
      You                    @windows                    @linux
        │                    (this PC)                  (a VPS)
   ┌────┴────┐
   │         │
Desktop  Telegram
```

### Why it exists

Most capable agent platforms are tied to one company's model, one
subscription, and one cloud. WispCrew keeps the useful parts — durable agents,
tool use, scheduled work, several agents collaborating — without the account,
the monthly fee, or running your work on someone else's computer.

It is deliberately **local-first**. There is no WispCrew service. What leaves a
machine leaves because you configured it: your model provider, a Telegram bot
you created, or a node you own.

## Getting started

**[QUICKSTART.md](QUICKSTART.md)** walks through it in fifteen minutes, with
a troubleshooting section built from failures that actually happened. The
short version:

Requires **Node.js 20+**.

```bash
git clone https://github.com/techartdev/wispcrew
cd wispcrew
npm install
npm run desktop
```

On first launch, open **Settings**, pick a provider, and paste an API key — or
choose Ollama or LM Studio and skip the key entirely.

If you want to try it for nothing, [build.nvidia.com](https://build.nvidia.com/)
has a free tier with Llama, Nemotron and Mistral models.

### Building an installer

```bash
npm run dist:win --workspace @wispcrew/desktop     # NSIS installer
npm run dist:mac --workspace @wispcrew/desktop     # DMG
npm run dist:linux --workspace @wispcrew/desktop   # AppImage
```

Installers are currently **unsigned**, so your OS will warn about an unknown
publisher.

## Using it

### One agent

It works as an ordinary assistant out of the box: type, it answers, tool calls
ask permission first. Nothing below is required.

### Several agents in a room

Open a conversation, press **Members**, and add another agent. A strip appears
showing who is present:

```
In this room:  @architect  @coder            Open ▾   Members
```

Then address them:

| You type | What happens |
|---|---|
| `@coder check the build` | Only that agent answers |
| `@coder @reviewer compare notes` | Both answer, concurrently |
| `@all what do you think?` | Everyone answers |
| `and the tests?` | Continues with whoever *you* last addressed |

**Agents do not reply to each other by default.** Two helpful agents answering
each other is an unbounded loop that costs real money, so an agent acts because
it was *addressed*. It may draw a colleague in by mentioning them, and a hard
budget stops a long chain to check with you.

Three modes decide how much the room constrains speaking:

- **Directed** — only agents you tag
- **Open** — untagged agents may offer to answer *(default)*
- **Free** — any agent may answer

### From your phone

Create a bot with [@BotFather](https://t.me/botfather), paste the token into
**Settings → Channels**, then message your bot:

```
/connect Release      bind this chat or topic to a conversation
/here                 which conversation is this?
/disconnect           unbind it
```

Telegram **topics** map to rooms, so a private chat or a forum group can hold
many conversations with no switching command — you tap the topic. Replying to
an agent's message addresses that agent.

Work appears as it happens: a placeholder message that edits itself as tools
run, then becomes the answer.

**Approval works remotely too.** A request from Telegram gets Allow/Deny
buttons — and an agent set to run unattended at your desk will still *ask*
when the request arrives from your phone, because those are different risks.
You can override that per agent if you want it.

### While you are away

- **Routines** — cron-scheduled prompts, run by a background daemon whether or
  not the window is open
- **Follow-ups** — an agent can schedule itself to check back
- **File watches** — an agent wakes when files change under its workspace
- **Notifications** — in-app, desktop, or Telegram

### Across machines

Pair another computer in **Machines**. Agents belong to it, and a room can hold
agents from several machines at once.

**Keys stay on the node that owns them.** A VPS never sees your laptop's
Anthropic key. Cross-machine rooms are relayed by the desktop, so they need it
connected — single-machine agents and routines keep running regardless.

## Features

| | |
|---|---|
| **Any provider** | DeepSeek, OpenAI, Anthropic, Groq, OpenRouter, Ollama, LM Studio, NVIDIA NIM, or any OpenAI-compatible endpoint |
| **Rooms** | Several agents and several people in one conversation, with `@handle` addressing |
| **Reachable anywhere** | Desktop and Telegram are doors onto the same room, not separate chats |
| **Remote machines** | Paired nodes over TLS with pinned fingerprints; keys never leave their node |
| **Background daemon** | Agents and routines survive closing the window |
| **A real CLI** | 50 commands — everything the desktop does, plus `--json` for scripts and other agents |
| **Durable agents** | Named teammates with their own instructions, model, workspace and permissions |
| **Real tools** | Shell, file read/write/edit, grep, directory listing, web fetch and search |
| **Attachments** | Drop in images and files — images go to vision models, text is inlined |
| **Delegation** | Agents can hand work to each other, with depth, cycle and permission guards |
| **Rewind & branch** | Undo a bad turn, or fork a conversation into a new agent from any point |
| **Permission gates** | Every write or command asks first — per agent, and per channel |
| **Routines & watches** | Cron schedules, self-scheduled follow-ups, filesystem triggers |
| **Skills** | Reusable instruction sets, invoked with `/name` |
| **MCP servers** | Extend agents with any Model Context Protocol server |
| **Encrypted keys** | Sealed with the OS keychain (DPAPI / Keychain / libsecret) |
| **Works offline** | Point it at Ollama or LM Studio and it never touches the internet |

## Small models are a first-class case

Self-hosting is a real reason to use this, so the design assumes models that
follow instructions loosely. The principle: **make the wrong choice
unavailable rather than discouraged.**

Two examples, both measured on Llama 3.3 70B. An agent delegated *"what is
3 + 4?"* to another agent rather than answering. Another used the notification
tool to reply to a question the user was already reading. Three separate prompt
edits fixed neither — a tool that is offered gets used — so the fix was to stop
offering them: the default general-purpose agent is not a delegate, and
notifications are unavailable on a turn you are watching.

That costs a strong model nothing, and it is the difference between working
and not working on a small one. **But do not expect a small model to be a
large one** — long tool chains and knowing when to stop are still harder.

## How it is put together

```
packages/
  runtime/          THE ENGINE — no Electron anywhere, so it runs in both hosts
  shared/           protocol + domain types (zero dependencies)
  llm/              provider adapters and presets
  core/             the agent loop and personas
  tools/            built-in tools + registry
  mcp/              MCP stdio client

apps/desktop/       Electron app — the deliverable
apps/daemon/        headless host, and the wispcrew CLI
                    serve.ts       the engine, running with no window
                    methods.ts     what a client may ask this node to do
                    cli.ts         command dispatch and argument parsing
                    cli-commands.ts every command, and the schema describing them

examples/cli-agent/ a minimal example agent, and the offline test suites
```

The engine lives in `packages/runtime` and imports no Electron, so the desktop
app and the daemon are **two hosts for one engine**. The desktop is a client:
it links to a detached daemon that owns durable state, spawning one if none is
running. Agent-scoped calls are routed to whichever node owns that agent.

A message flows **renderer → preload → bridge → room routing → engine →
provider**, with tool calls gated by the approval policy and results streamed
back as events. There is no polling and no hidden network path.

## The command line

Everything the desktop can do, a terminal can do too — the CLI lacks a
window, not features. That matters for a server with no screen, and for
another coding agent: every one of them already knows how to run a shell
command, so a CLI is the whole integration.

```bash
wispcrew serve                       # run the engine on this machine
wispcrew configure --provider nvidia --key <key>
wispcrew agents create Builder --description "You build things here"
wispcrew ask Builder "what changed in the last commit?"
```

Set up a headless machine without a desktop anywhere:

```bash
# on the server
wispcrew serve --listen --network --pair     # prints a code and a fingerprint

# on your laptop
wispcrew pair <address> <code> --fingerprint <value>
```

**Approvals work headlessly.** When an agent needs permission for something,
the request waits for a person rather than being refused:

```
$ wispcrew ask Linux "check the disk usage"
waiting for approval: shell — Run command: df -h
  wispcrew approvals allow cd071d8f
```

An unanswered request is **denied** after five minutes, so the safe default
is unchanged.

**For scripts and other agents**, every command takes `--json`:

```bash
wispcrew capabilities --json    # the whole command surface, with arguments
wispcrew agents --json          # exactly one JSON array on stdout
wispcrew tasks wait <id>        # blocks; exits non-zero if the task failed
```

`wispcrew capabilities --json` describes all 50 commands — what each takes,
what it returns, and when *not* to use it. A program can learn the tool from
that alone, without parsing help prose that changes whenever the wording is
improved.

See [docs/CLI.md](docs/CLI.md) for the full surface and the handful of
capabilities a terminal genuinely cannot offer.

## Subscription sign-in (optional — read this first)

WispCrew can sign in with a **Claude Pro/Max** or **ChatGPT** subscription
instead of an API key, either through your browser or by adopting a sign-in
that Claude Code or Codex CLI already holds.

**The caveats are real, and they are yours to weigh:**

- **Anthropic prohibits this.** Their Claude Code documentation forbids using
  Free/Pro/Max OAuth tokens in third-party products, and accounts can be
  suspended without warning. The account at risk is yours.
- **OpenAI does not document it for third-party apps.** "Sign in with ChatGPT"
  is real, but the subscription-billing path is documented for OpenAI's own
  surfaces. The endpoint WispCrew uses is private and can change at any time.

It is off by default, never enabled silently, and the warning appears above the
button rather than under it. **An API key is the supported path.**

## Rate limits

Free tiers throttle. NVIDIA's is roughly 40 requests per minute, and an agent
turn is several requests — think, call a tool, think again — so a busy turn can
brush against it.

WispCrew retries transient failures (429 and 5xx) with exponential backoff and
jitter, honouring `Retry-After` when the provider sends one. It also catches
capacity errors that arrive *inside* a successful response, which NVIDIA does
under load. Permanent failures — a bad key, an unknown model — are never
retried, because that only delays a clear error.

This smooths bursts inside your allowance. It does not rotate keys or work
around a provider's limits, and it never will.

## Security posture

This app runs commands on your machine, so the boundaries are deliberate:

- The renderer is fully sandboxed (`contextIsolation`, no Node, no
  `ipcRenderer`) and reaches main only through an enumerated API.
- A strict CSP forbids remote script, inline script, and outbound connections
  from the UI.
- Markdown from the model is rendered as React elements — never
  `dangerouslySetInnerHTML` — so HTML in a response cannot execute. Only
  `http(s)` links are clickable.
- File tools are confined to the agent's workspace root; traversal is rejected.
- API keys are encrypted at rest and never sent to the renderer.
- A remote channel does not inherit `auto` approval. Someone who compromises
  your Telegram cannot silently run shell commands.
- Paired nodes use TLS with pinned fingerprints and per-node tokens. Each node
  holds only its own credentials.

Found a problem? Please see [SECURITY.md](SECURITY.md).

### When something goes wrong

Misconfiguration is the expected first-run state for a bring-your-own-provider
app, so failures explain themselves. A rejected key says to check Settings; an
unknown model names the model; an unreachable local endpoint tells you to start
Ollama or LM Studio. You should never see a raw HTTP dump.

## Development

```bash
npm run typecheck                               # everywhere
npm run build                                   # all packages + desktop
npm run test --workspace @wispcrew/examples-cli # 68 offline suites, no API key needed
npm run desktop                                 # build + launch
npm run verify                                  # everything CI does, locally
```

`npm run verify` is the one to run before finishing: typecheck, build, all
offline suites, encoding, provenance and credential guards, and a headless boot
that fails if the window does not paint. About two minutes.

The offline suites need no API key and no network. Several were written after a
real bug and exist to keep it fixed: two engines writing one store, a killed
process that emits `exit` without `close` on Windows, a recycled pid that must
not be signalled, overwriting a file nobody read, and every panel's CSS classes
actually existing — that last one caught a modal that typechecked while looking
broken.

Four more suites need real credentials and are excluded from `npm test`.

CI additionally **boots the app headlessly on Linux, macOS and Windows** and
fails if the window does not render.

### Design documents

These record decisions and their reasoning, including what is *not* solved:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit
- [docs/CONVERSATIONS.md](docs/CONVERSATIONS.md) — the room model, and open problems
- [docs/GROUP-CHAT.md](docs/GROUP-CHAT.md) — who speaks when several agents share a room
- [docs/DISTRIBUTED.md](docs/DISTRIBUTED.md) — nodes, pairing, and where keys live
- [docs/CLI.md](docs/CLI.md) — the planned `wispcrew` binary

## Known gaps

Stated plainly rather than discovered later:

- **macOS and Linux are not verified on real hardware.** CI builds, tests and
  boots the app there, but cannot judge window chrome or native dialogs.
- **Installers are unsigned.**
- Claude *inference* is unverified — the test account has been rate-limited
  throughout. The token exchange is confirmed working.
- Cross-machine rooms need a connected desktop; there is no room host or peer
  replication yet.

## Contributing

Contributions are genuinely welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
What would help most right now:

- macOS and Linux testing on real hardware
- The `wispcrew` CLI ([docs/CLI.md](docs/CLI.md))
- More provider presets
- Additional built-in tools
- Translations

Please read the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) — do what you like, including commercially.

WispCrew is an independent project. It is not affiliated with, endorsed by, or
derived from any commercial AI assistant product. All code in this repository
is original work by its contributors or a permissively licensed dependency.
