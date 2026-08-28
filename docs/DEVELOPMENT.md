# Development Guide

Everything you need to build, run, test, and extend WispCrew. Windows is the
primary development platform so far; macOS and Linux should work but are
**unverified** — reports welcome.

## Setup

Requires Node.js 20+.

```bash
npm install     # npm workspaces — not pnpm, not yarn
npm run desktop # build everything and launch
```

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` across every workspace |
| `npm run build` | Builds packages (tsc) and desktop bundles (esbuild + Vite) |
| `npm run test --workspace @wispcrew/examples-cli` | All 67 offline suites |
| `npm run desktop` | Build + launch Electron |
| `npm run agent --workspace @wispcrew/examples-cli -- "…"` | A minimal example agent, for trying the loop in isolation (needs a key) |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Installers |
| `npm run icons` | Regenerate app icons from `build/icon.svg` |
| `npm run verify` | **Everything above plus the guards** — run this before finishing |

`npm run verify` is the one to remember: typecheck, build, every offline
suite, encoding, the provenance and credential guards, a check that the
README describes what exists, a check that every CLI command reaches a method
the node serves, and a headless boot that fails if the window does not paint.
About two minutes.

## Working on the CLI

```bash
npm run build --workspace @wispcrew/daemon

# a throwaway profile, so nothing touches your real one
node apps/daemon/dist/cli.js serve --listen --data-dir /tmp/probe &
node apps/daemon/dist/cli.js agents --data-dir /tmp/probe
```

Installed, those are `wispcrew serve` and `wispcrew agents`. During
development the built entry point is easier than reinstalling after a change.

Two scripts keep it honest, both run by `verify`:

- `scripts/check-cli-methods.cjs` — every method a command calls must exist
  on the node. This failure is otherwise invisible until someone runs the
  command on a real machine and gets `Unknown method`.
- `scripts/cli-gap.cjs` — how much of the desktop's surface the CLI reaches.
  A report rather than a gate; the number is meant to be checked.

A new command must also appear in `COMMAND_SCHEMA` with its arguments and
return shape, or `test:cli-schema` fails. That is deliberate: an undocumented
command is a capability nobody discovers.

## The offline test suites

58 suites, none of which need an API key or network access. A few worth
knowing about:

| Suite | Covers |
|---|---|
| `smoke` | The agent loop end-to-end with a scripted provider |
| `test:provider` | Real HTTP/SSE wire format against a local fixture server |
| `test:mcp` | MCP stdio client against a fixture server |
| `test:memory` | Multi-turn history + interrupt safety |
| `test:cron` | Cron parsing, POSIX day rules, timezones, DST, `nextRun` |
| `test:markdown` | Markdown rendering **and XSS resistance** |
| `test:single-writer` | Two engines on one store lose data — this proves it, and proves the refusal |
| `test:cli-parsing` | A flag's value never becomes a positional argument |
| `test:pending-approvals` | An unanswered approval is denied, never allowed |
| `test:node-token` | A node keeps its network token across a restart |

They are plain scripts with a small assertion helper — no test framework. To
add one, drop a file in `examples/cli-agent/src/`, give it a `test:*` script,
and add it to the `test` chain.

The `cron` and `markdown` suites each caught real bugs when written (a leap-day
scan horizon, a timezone day-skip error, and intra-word underscores corrupting
identifiers). They are worth keeping green.

### Live testing

Live provider runs need your own key. Pass it by environment variable; never
put it in a file inside the repo.

```bash
WISPCREW_PROVIDER=openai WISPCREW_API_KEY=sk-... \
  npm run agent --workspace @wispcrew/examples-cli -- "list the files here"
```

## Debug hooks

| Variable | Effect |
|---|---|
| `WISPCREW_LOG=<file>` | Append a bridge/protocol log |
| `WISPCREW_CAPTURE=<file.png>` | Screenshot the window, then quit |
| `WISPCREW_CAPTURE_DELAY=<ms>` | How long to wait first (default 8000) |
| `WISPCREW_AUTOSEND='prompt'` | Send one prompt through the real pipeline after boot |
| `WISPCREW_PROVIDER` / `_API_KEY` / `_MODEL` / `_BASE_URL` | Provider fallback |

A scripted end-to-end check looks like:

```bash
cd apps/desktop
WISPCREW_AUTOSEND='Reply with exactly: OK' \
WISPCREW_CAPTURE=../../shot.png \
WISPCREW_CAPTURE_DELAY=14000 \
npx electron .
```

Then inspect `<userData>/transcripts/*.json`.

## Where user data lives

`%APPDATA%\WispCrew` on Windows, `~/Library/Application Support/WispCrew` on
macOS, `~/.config/WispCrew` on Linux.

`app.setName('WispCrew')` runs at **module scope** in `main.ts` — before
anything reads `getPath('userData')`. Electron caches that path on first
access, so setting the name later silently puts data in the wrong folder.

## Adding things

### A provider

Add a preset to `packages/llm/src/presets.ts`. If the endpoint speaks the
OpenAI chat-completions format, that is all that is needed —
`OpenAICompatibleProvider` handles the rest. For a genuinely different wire
format, add an adapter implementing `ChatProvider` (see `anthropic.ts`).

### A tool

Implement `Tool` in `packages/tools/src/`, export it, and register it in
`registry.ts`. Decide whether it needs approval: anything that writes, deletes,
or executes must call `ctx.requestApproval`. Keep filesystem access inside
`resolveInRoot`.

### A bridge method

Three places, in order:

1. `packages/shared/src/bridge.ts` — add it to `WispBridge`.
2. `apps/desktop/src/main/bridge-host.ts` — implement `handle('name', …)`.
3. `apps/desktop/src/preload/preload.ts` — add the matching `invoke`.

TypeScript will tell you if you miss one. Do not add a generic passthrough.

### A UI panel

Add it to `Panels.tsx`, wire a `Panel` variant in `App.tsx`, and surface it
from `Sidebar.tsx`. State belongs in `useWispcrew.ts`, not in the component.

## Gotchas

- **npm workspaces hoist dependencies** to the repo root. `electron-builder`
  therefore runs with `npmRebuild: false`.
- **`electronVersion` in `electron-builder.yml` must be exact.** A `^range`
  from `package.json` cannot be resolved to a platform binary.
- **JSON readers must tolerate a BOM.** PowerShell writes them by default.
- **Store writes must stay atomic.** Temp file plus rename.
- **`writeSettings` treats explicit `undefined` as delete.** That is what stops
  a stale plaintext key from surviving migration into the encrypted store.
- **Any path that accepts an API key must route it through `upsertSecrets`.**
  A debug path once wrote a key straight into the plaintext settings file.

## Release checklist

1. `npm run typecheck && npm run build`
2. `npm run test --workspace @wispcrew/examples-cli`
3. Launch and chat once; confirm tools and approvals still work.
4. `npm run dist:win` (and the other targets if you can test them).
5. Confirm the packaged app boots.
6. Update `docs/STATUS.md`.
