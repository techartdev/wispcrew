<div align="center">

# WispCrew

**A free, open-source desktop AI agent. Bring your own model.**

No account. No subscription. No vendor lock-in.
Runs locally, talks to whichever LLM provider you choose.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

</div>

---

## What it is

WispCrew is a desktop agent that can actually *do* things on your computer —
read and write files, run shell commands, search code, fetch web pages — while
you stay in control of every action that touches your system.

It is deliberately **local-first** and **provider-agnostic**. Your conversations
and your API key live on your machine. The only network traffic is the request
you asked for, sent to the provider you chose.

### Why it exists

Most capable desktop agents are tied to one company's model, one subscription,
and one cloud. WispCrew keeps the useful parts of that experience — durable
agents, tool use, scheduled work, extensibility — without the account, the
monthly fee, or the requirement to run your work on someone else's computer.

## Features

| | |
|---|---|
| **Any provider** | DeepSeek, OpenAI, Anthropic, Groq, OpenRouter, Ollama, LM Studio, or any OpenAI-compatible endpoint |
| **Durable agents** | Named teammates with their own instructions, model, workspace, and permissions |
| **Real tools** | Shell, file read/write/edit, grep, directory listing, web fetch and search |
| **Attachments** | Drop in images and files — images go to vision models, text is inlined |
| **Agent delegation** | Agents can hand tasks to each other, with depth, cycle and permission guards |
| **Rewind & branch** | Undo a bad turn, or fork a conversation into a new agent from any point |
| **Permission gates** | Every write or command asks first — or set an agent to read-only, or let it run free |
| **Standing permissions** | “Always allow” is remembered per agent and tool, and listed in Settings so you can revoke it |
| **Subscription sign-in** | Optionally use a Claude or ChatGPT subscription instead of an API key — see the caveats below |
| **Free inference** | NVIDIA NIM has a free tier (~40 requests/minute) with Llama, Nemotron and Mistral models — get a key at [build.nvidia.com](https://build.nvidia.com/) |
| **Routines** | Cron-scheduled prompts, so an agent can work while you are away |
| **Skills** | Reusable instruction sets, invoked with `/name` |
| **MCP plugins** | Extend agents with any Model Context Protocol server |
| **Encrypted keys** | API keys are sealed with the OS keychain (DPAPI / Keychain / libsecret) |
| **Streaming chat** | Token-by-token output, collapsible tool cards, stoppable mid-run |
| **Local & offline-capable** | Point it at Ollama or LM Studio and it never touches the internet |

## Install

Requires **Node.js 20+**.

```bash
git clone https://github.com/techartdev/wispcrew
cd wispcrew
npm install
npm run desktop
```

On first launch, open **Settings**, pick a provider, and paste an API key
(or choose Ollama/LM Studio and skip the key entirely).

### Building an installer

```bash
npm run dist:win     # NSIS installer
npm run dist:mac     # DMG
npm run dist:linux   # AppImage
```

## Using it from the terminal

The agent core also runs headless:

```bash
WISPCREW_PROVIDER=openai WISPCREW_API_KEY=sk-... \
  npm run agent --workspace @wispcrew/examples-cli -- "summarize the files here"
```

Omit the prompt for an interactive REPL.

## How it is put together

```
apps/desktop/          Electron app
  src/main/            main process — bridge, agent runs, scheduler, storage
  src/preload/         the single, explicit IPC surface
  src/renderer/        React UI (chat, roster, panels)
packages/
  shared/              protocol + domain types (zero dependencies)
  llm/                 provider adapters and presets
  core/                the agent loop and personas
  tools/               built-in tools + registry
  mcp/                 MCP stdio client
examples/cli-agent/    headless CLI and the offline test suite
```

A message flows: **renderer → preload → bridge-host → agent loop → provider**,
with tool calls gated by the approval policy and results streamed back as
events. There is no polling and no hidden network path.

### Subscription sign-in (optional, and read this first)

WispCrew can sign in with a **Claude Pro/Max** or **ChatGPT** subscription
instead of an API key, either through your browser or by adopting a sign-in
that Claude Code or Codex CLI already holds on your machine. Where the
provider reports it, Settings shows how much of your plan you have used and
when it resets.

**The caveats are real, and they are yours to weigh:**

- **Anthropic prohibits this.** Their Claude Code documentation forbids using
  Free/Pro/Max OAuth tokens in third-party products, and accounts can be
  suspended without warning. The account at risk is yours.
- **OpenAI does not document it for third-party apps.** "Sign in with ChatGPT"
  is a real product, but the subscription-billing path is documented for
  OpenAI's own surfaces. The endpoint WispCrew uses is private and can change
  at any time.

It is off by default, never enabled silently, and the warning appears above
the button rather than under it. **An API key is the supported path**, and the
one we recommend.

### Rate limits

Free tiers throttle. NVIDIA's is roughly 40 requests per minute, and an agent
turn is several requests — think, call a tool, think again — so a busy turn
can brush against it.

WispCrew retries transient failures (429 and 5xx) with exponential backoff
and jitter, honouring `Retry-After` when the provider sends one. It also
catches capacity errors that arrive *inside* a successful response, which
NVIDIA does under load. Permanent failures — a bad key, an unknown model — are
never retried, because retrying them only delays a clear error.

This smooths bursts inside your allowance. It does not rotate keys or work
around a provider's limits, and it never will.

### When something goes wrong

Misconfiguration is the expected first-run state for a bring-your-own-provider
app, so failures explain themselves. A rejected key says to check Settings; an
unknown model names the model; an unreachable local endpoint tells you to
start Ollama or LM Studio. You should never see a raw HTTP dump.

### Security posture

This app runs commands on your machine, so the boundaries are deliberate:

- The renderer is fully sandboxed (`contextIsolation`, no Node, no
  `ipcRenderer`) and reaches main only through an enumerated API.
- A strict CSP forbids remote script, inline script, and outbound connections
  from the UI.
- Markdown from the model is rendered as React elements — never
  `dangerouslySetInnerHTML` — so HTML in a model response cannot execute.
  Only `http(s)` links are clickable.
- File tools are confined to the agent's workspace root; path traversal is
  rejected.
- API keys are encrypted at rest and never sent to the renderer.

Found a problem? Please see [SECURITY.md](SECURITY.md).

## Development

```bash
npm run typecheck                               # everywhere
npm run build                                   # all packages + desktop
npm run test --workspace @wispcrew/examples-cli # 50 offline suites, no API key needed
npm run desktop                                 # build + launch
```

The offline suites cover the agent loop, real HTTP/SSE wire format, MCP
end-to-end (including spawning from a path containing spaces), multi-turn
memory and interrupt safety, the cron scheduler (including DST and timezone
edge cases), the Markdown renderer (including XSS resistance), attachment
handling plus provider routing, agent delegation (depth, cycles, fan-out and
permission narrowing), workspace confinement (traversal, prefix siblings,
case variants, NUL bytes), and conversation branching (every transcript
prefix must rebuild to a provider-valid history). They need no API key and
should stay green.

CI additionally **boots the app headlessly on Linux, macOS and Windows** and
fails if the window does not render.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for depth, and
[docs/HANDOVER.md](docs/HANDOVER.md) for an honest account of what is
verified and what is not.

## Contributing

Contributions are genuinely welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). Ideas that would help most right now:

- macOS and Linux testing (only Windows is verified so far)
- More provider presets
- Additional built-in tools
- Translations

Please read the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) — do what you like, including commercially.

WispCrew is an independent project. It is not affiliated with, endorsed by, or
derived from any commercial AI assistant product. All code in this repository
is original work by its contributors or a permissively licensed dependency.
