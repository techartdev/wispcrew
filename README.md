<div align="center">

# GhostBot

**A free, open-source desktop AI agent. Bring your own model.**

No account. No subscription. No vendor lock-in.
Runs locally, talks to whichever LLM provider you choose.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

</div>

---

## What it is

GhostBot is a desktop agent that can actually *do* things on your computer —
read and write files, run shell commands, search code, fetch web pages — while
you stay in control of every action that touches your system.

It is deliberately **local-first** and **provider-agnostic**. Your conversations
and your API key live on your machine. The only network traffic is the request
you asked for, sent to the provider you chose.

### Why it exists

Most capable desktop agents are tied to one company's model, one subscription,
and one cloud. GhostBot keeps the useful parts of that experience — durable
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
| **Permission gates** | Every write or command asks first — or set an agent to read-only, or let it run free |
| **Routines** | Cron-scheduled prompts, so an agent can work while you are away |
| **Skills** | Reusable instruction sets, invoked with `/name` |
| **MCP plugins** | Extend agents with any Model Context Protocol server |
| **Encrypted keys** | API keys are sealed with the OS keychain (DPAPI / Keychain / libsecret) |
| **Streaming chat** | Token-by-token output, collapsible tool cards, stoppable mid-run |
| **Local & offline-capable** | Point it at Ollama or LM Studio and it never touches the internet |

## Install

Requires **Node.js 20+**.

```bash
git clone https://github.com/ghostbot-app/ghostbot
cd ghostbot
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
GHOSTBOT_PROVIDER=openai GHOSTBOT_API_KEY=sk-... \
  npm run agent --workspace @ghostbot/examples-cli -- "summarize the files here"
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
npm run test --workspace @ghostbot/examples-cli # six offline suites, no API key needed
npm run desktop                                 # build + launch
```

The offline suites cover the agent loop, real HTTP/SSE wire format, MCP
end-to-end (including spawning from a path containing spaces), multi-turn
memory and interrupt safety, the cron scheduler (including DST and timezone
edge cases), the Markdown renderer (including XSS resistance), attachment
handling plus provider routing, agent delegation (depth, cycles, fan-out and
permission narrowing), and workspace confinement (traversal, prefix siblings,
case variants, NUL bytes). They need no API key and should stay green.

CI additionally **boots the app headlessly on Linux, macOS and Windows** and
fails if the window does not render.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for depth.

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

GhostBot is an independent project. It is not affiliated with, endorsed by, or
derived from any commercial AI assistant product. All code in this repository
is original work by its contributors or a permissively licensed dependency.
