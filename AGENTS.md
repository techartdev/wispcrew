# AGENTS.md — Handoff Guide for Coding Agents

Orientation for any AI coding agent (or human) continuing work on
**GhostBot**. Read `README.md`, `CONTRIBUTING.md`, and `docs/ARCHITECTURE.md`
for depth; this file says what the project is, where things live, how to
verify a change, and what not to break.

## Mission

GhostBot is a free, MIT-licensed, **local-first** desktop AI agent. The user
brings their own model (DeepSeek, OpenAI, Anthropic, Ollama, LM Studio, Groq,
OpenRouter, or any OpenAI-compatible endpoint). There is no account, no
subscription, and no cloud component: conversations and API keys stay on the
user's machine.

**All code in this repository is original work.** See "Provenance" below —
this constraint is load-bearing, not decorative.

## Repository map

```
apps/desktop/            Electron app (the deliverable)
  src/main/              main process
    main.ts              startup, agent runs, window, menu
    bridge-host.ts       every IPC handler (the renderer-facing API)
    store.ts             durable JSON storage (agents/transcripts/routines/skills)
    scheduler.ts         cron-driven routine execution
    cron.ts              dependency-free cron parser/evaluator
    delegation.ts        agent-to-agent `ask_agent` tool + its safety limits
    attachments.ts       file/image classification for the model
    agent-sessions.ts    one persistent Agent per agentId (memory + Stop)
    mcp-manager.ts       MCP server lifecycle
    secrets-store.ts     safeStorage-encrypted API keys
    settings-file.ts     plaintext settings JSON (never holds a key)
    userdata-migration.ts  imports pre-rename profiles
  src/preload/preload.ts the ONLY renderer<->main surface
  src/renderer/          React UI
    App.tsx              shell, panels, shortcuts, theme
    useGhostbot.ts       all app state; subscribes to pushed events
    Chat.tsx             transcript, tool cards, approvals, composer
    Sidebar.tsx          agent roster
    Panels.tsx           settings / agent / MCP / routines / skills
    Markdown.tsx         safe Markdown renderer (no HTML, ever)
packages/
  shared/                types only, zero deps (index/domain/bridge)
  llm/                   provider adapters + presets
  core/                  agent loop + personas
  tools/                 shell, files, edit, search, web + registry
  mcp/                   MCP stdio client
examples/cli-agent/      headless CLI + eight offline test suites
scripts/make-icons.mjs   build/icon.svg -> app icons
```

## How it works (30 seconds)

1. `main.ts` sets the app name, migrates userData, opens the store, registers
   the bridge, connects MCP servers, starts the scheduler, loads the renderer.
2. The renderer talks **only** to `window.ghostbot` (typed as `GhostBridge` in
   `packages/shared/src/bridge.ts`), implemented by `bridge-host.ts`.
3. A message goes `sendPrompt` -> `runPrompt` -> `@ghostbot/core` `Agent` ->
   provider. Transcript entries are **pushed** back as `gb:event` frames and
   upserted by id, so streaming updates in place.
4. Tool calls hit the approval policy: `readonly` denies, `auto` allows, `ask`
   raises an approval card and waits for `resolveApproval`.

## Commands

```bash
npm install                                     # npm workspaces (NOT pnpm)
npm run typecheck                               # tsc --noEmit everywhere
npm run build                                   # packages + desktop bundles
npm run test --workspace @ghostbot/examples-cli # all eight offline suites
npm run desktop                                 # build + launch
npm run dist:win | dist:mac | dist:linux        # installers
```

**Always** run typecheck + build + the offline suites before finishing. If you
touched `apps/desktop`, launch the app once and confirm it boots and chats.

Config lives in `<userData>/ghostbot-settings.json`
(`%APPDATA%\GhostBot` on Windows). Keys live **only** in
`<userData>/ghostbot-secrets.enc`.

## Debug hooks

| Var | Effect |
|---|---|
| `GHOSTBOT_LOG=<file>` | Protocol/bridge log |
| `GHOSTBOT_CAPTURE=<file.png>` | Screenshot then quit |
| `GHOSTBOT_CAPTURE_DELAY=<ms>` | Delay before that capture (default 8000) |
| `GHOSTBOT_AUTOSEND='prompt'` | Drive one real turn headlessly |
| `GHOSTBOT_PROVIDER/API_KEY/MODEL/BASE_URL` | Provider fallback (env) |

## Hard rules

1. **Provenance.** Only original or permissively licensed code. Never vendor a
   third-party application tree, decompile a binary, or copy proprietary code
   into this repo. CI fails if a `vendor/` directory appears. This is why the
   project can be MIT at all.
2. **The renderer stays sandboxed.** `contextIsolation: true`, `sandbox: true`,
   no `nodeIntegration`. Everything it needs is an explicitly named method in
   `preload.ts`. **Never** add a generic `invoke(channel, ...args)` — that
   would hand the whole IPC surface to anything running in the page.
3. **Never render model output as HTML.** `Markdown.tsx` emits React elements
   on purpose. No `dangerouslySetInnerHTML`, no sanitize-and-inject pattern.
   Only `http(s)` links are clickable. `markdown-test.ts` enforces this.
4. **Keys never cross to the renderer.** `getSettings` returns
   `hasApiKey`/`isEncrypted` only. `writeSettings` treats an explicit
   `undefined` as *delete*, which is what keeps a stale plaintext key from
   surviving migration.
5. **Any new code path that accepts an API key must route it through
   `upsertSecrets`.** A debug path once wrote a key into the plaintext settings
   file; that is exactly the bug class this rule exists for.
6. **File tools stay inside the workspace root** (`resolveInRoot`).
7. **JSON readers are BOM-tolerant** — Windows tooling writes BOMs.
8. **Store writes are atomic** (temp file + rename). A truncated
   `agents.json` loses the user's whole roster.
9. **Dependencies are a security decision.** This app runs shell commands.
   Prefer readable local code (that is why the cron parser and Markdown
   renderer are hand-written) and justify additions.
10. Do not commit screenshots, `boot*.log`, or anything matching the key
    patterns in `.gitignore`.

## Current state

**Working and verified live** (OpenAI, real key): streaming chat; tool calls
with approval gating; multi-turn memory; Stop/interrupt; encrypted key storage
with plaintext migration; MCP servers; agent roster with per-agent overrides;
routines (cron); skills; settings UI; **file/image attachments** (vision);
**agent-to-agent delegation**. Confirmed with screenshots and transcript
inspection, not assumed.

**Provider routing:** OpenAI reasoning models (`gpt-5.x`, o-series) go to the
**Responses API**, because `/v1/chat/completions` refuses function tools for
them unless `reasoning_effort: "none"` — and that flag genuinely disables the
reasoning (measured: wrong answer with it, right answer without). Every other
OpenAI-compatible endpoint keeps chat-completions. `test:attachments` pins the
routing, including that a local server borrowing an OpenAI model name is not
rerouted.

**Test coverage**: eight offline suites (`smoke`, `provider`, `mcp`, `memory`,
`cron`, `markdown`, `attachments`, `delegation`) — no API key, no network.
Several caught real bugs when written; keep them green.

**Not yet done / known gaps**
- macOS and Linux are **untested**. Only Windows has been verified.
- No conversation branching.
- Installers are unsigned.
- `docs/STATUS.md` carries the detailed status list.

## Provenance

Earlier iterations of this project vendored and reverse-engineered a
proprietary desktop application. **All of that has been removed** — the
vendored tree, the protocol shim that spoke its IPC format, the branding
scripts, and the reverse-engineering notes. The current UI, IPC contract,
storage, scheduler, and Markdown renderer are original implementations.

If you are extending this project: do not reintroduce that material. Design
from the feature you want, not from another product's internals.
