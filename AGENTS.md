# AGENTS.md — Handoff Guide for Coding Agents

Orientation for any AI coding agent (or human) continuing work on
**GhostBot**. Read `README.md`, `CONTRIBUTING.md`, and `docs/ARCHITECTURE.md`
for depth; this file says what the project is, where things live, how to
verify a change, and what not to break.

## Mission

GhostBot is a free, MIT-licensed, **local-first** desktop AI agent. The user
brings their own model (DeepSeek, OpenAI, Anthropic, Ollama, LM Studio, Groq,
OpenRouter, or any OpenAI-compatible endpoint). GhostBot itself has no account
and no cloud component: conversations and credentials stay on the user's
machine.

A Claude or ChatGPT **subscription** can optionally be used instead of an API
key. That is opt-in and carries provider-policy risk — see "Subscription
sign-in" below before touching it.

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
    branching.ts         rewind/fork + transcript -> model-history rebuild
    oauth-store.ts       encrypted subscription credentials + refresh
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
examples/cli-agent/      headless CLI + thirteen offline test suites
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
npm run test --workspace @ghostbot/examples-cli # all thirteen offline suites
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
**agent-to-agent delegation**; **conversation rewind/branch**; **memory across
app restarts**. Confirmed with screenshots and transcript inspection, not
assumed.

**Provider routing:** OpenAI reasoning models (`gpt-5.x`, o-series) go to the
**Responses API**, because `/v1/chat/completions` refuses function tools for
them unless `reasoning_effort: "none"` — and that flag genuinely disables the
reasoning (measured: wrong answer with it, right answer without). Every other
OpenAI-compatible endpoint keeps chat-completions. `test:attachments` pins the
routing, including that a local server borrowing an OpenAI model name is not
rerouted.

**Test coverage**: thirteen offline suites (`smoke`, `provider`, `mcp`,
`memory`, `cron`, `markdown`, `attachments`, `delegation`, `sandbox`,
`branching`, `grants`, `errors`, `oauth`) — no API key, no network. Several
caught real bugs when written; keep them green. CI additionally boots the app
headlessly on all three platforms and fails if the window does not paint.

## Subscription sign-in

GhostBot can use a **Claude Pro/Max** or **ChatGPT** subscription instead of
an API key, either through a browser OAuth flow or by adopting a sign-in that
Claude Code / Codex CLI already holds. Read this before changing any of it.

**The policy risk is the user's, so the UI must stay honest.** Anthropic
prohibits third-party tools from using Claude subscription tokens and can
suspend accounts without warning; OpenAI does not document subscription
billing for third-party apps. The feature is opt-in, off by default, and the
warning renders *above* the sign-in button. Do not soften, move or bury it,
and do not enable any of it automatically.

**Facts that were expensive to establish** (all verified live; none are
documented for third-party use):

| Thing | Value / behaviour |
|---|---|
| Claude token endpoint | `platform.claude.com/v1/oauth/token` — **not** `console.anthropic.com`, which an early draft guessed and which silently never works |
| Claude redirect | One registered non-loopback URI; localhost is rejected, hence the paste-back step |
| Claude auth header | `sk-ant-oat…` needs `Authorization: Bearer` + OAuth beta + Claude Code identity headers. Sent as `x-api-key` it returns 401 |
| ChatGPT endpoint | `chatgpt.com/backend-api/codex/responses`. `api.openai.com` returns 401 for these tokens |
| ChatGPT required fields | `instructions` **and** `store: false`. Omit either and the backend returns HTTP 400 with an **empty body** |
| ChatGPT redirect | Loopback on port **1455** — fixed by the client registration, not free choice |
| Usage data | Response headers only. `/codex/usage`, `/rate_limits`, `/credits` and `/accounts/check` all return 403, and the SSE stream has no rate-limit events |

**Invariants worth keeping:**

- Refresh is **single-flight per vendor**. Refresh tokens rotate, so two
  concurrent turns racing would persist a token the server already retired —
  signing the user out of their CLI as well as GhostBot.
- A failed refresh **clears** the credential, so the UI says "signed out"
  instead of every turn failing with an auth error.
- Never invent usage numbers. Anthropic reports no percentage and no reset
  time on this path; the UI says so rather than showing a plausible figure.
- Adopting a CLI sign-in **reads** its credential file; GhostBot's own
  credentials live in its encrypted store, never written back to the CLI's.

**Verified live:** the ChatGPT browser flow end to end (sign-in → token
exchange → streaming → tool call → refresh with rotation), CLI adoption
through the real IPC handlers, and DPAPI encryption at rest. **Not verified:**
the Claude *browser* flow's code exchange — the test account was rate-limited,
so only its authentication was confirmed (429 for a valid token vs 401 for an
invalid one).

## Not yet done / known gaps

- macOS and Linux are **not verified on real hardware**. CI builds, tests and
  boots the app there, but cannot judge window chrome, native dialogs or
  keychain behaviour.
- The Claude browser sign-in's code exchange is unverified (see above).
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
