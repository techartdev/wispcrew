# AGENTS.md — Handoff Guide for Coding Agents

Orientation for any AI coding agent (or human) continuing work on
**WispCrew**. Read `README.md`, `CONTRIBUTING.md`, and `docs/ARCHITECTURE.md`
for depth; this file says what the project is, where things live, how to
verify a change, and what not to break.

## Mission

WispCrew is a free, MIT-licensed, **local-first** desktop AI agent. The user
brings their own model (DeepSeek, OpenAI, Anthropic, Ollama, LM Studio, Groq,
OpenRouter, or any OpenAI-compatible endpoint). WispCrew itself has no account
and no cloud component: conversations and credentials stay on the user's
machine.

A Claude or ChatGPT **subscription** can optionally be used instead of an API
key. That is opt-in and carries provider-policy risk — see "Subscription
sign-in" below before touching it.

**All code in this repository is original work.** See "Provenance" below —
this constraint is load-bearing, not decorative.

## Repository map

The engine lives in `packages/runtime` and is **free of Electron**, so the
same code runs in the desktop app or in a headless daemon. That split is the
single most important thing to understand here: `apps/desktop` and
`apps/daemon` are two hosts for one engine.

```
packages/
  runtime/               THE ENGINE — no Electron import anywhere
    engine.ts            runPrompt / runRoutine / runDelegated
    store.ts             durable JSON (agents, transcripts, routines, skills)
    checkpoints.ts       prior transcript versions, for recovery
    scheduler.ts         cron + one-shot follow-ups
    watch.ts             filesystem triggers (debounced)
    watch-manager.ts     keeps watchers in step with routines
    cron.ts              dependency-free cron parser/evaluator
    channels.ts          outbound message queue (the delivery seam)
    channel-telegram.ts  Telegram bot delivery
    notify-host.ts       resolves which channels an agent may use
    schedule-host.ts     turns an agent's request into a real routine
    delegation.ts        agent-to-agent `ask_agent` + its limits
    branching.ts         rewind/fork + transcript -> model history
    oauth-store.ts       encrypted subscription credentials + refresh
    secrets-store.ts     encrypted API keys
    host.ts              the seam: dataDir, crypto, workspace root
    protocol.ts          NDJSON frames between client and node
    node-server.ts       serves the engine over a socket/pipe/TLS
    node-client.ts       connects to one
    node-identity.ts     endpoint file, pid identity, build stamp
    pairing.ts           single-use codes + fingerprint pinning
  shared/                types only, zero deps (index/domain/bridge)
  llm/                   provider adapters + presets
  core/                  agent loop + personas + system prompts
  tools/                 shell, files, edit, search, web, notify, schedule
  mcp/                   MCP stdio client

apps/desktop/            Electron app (the deliverable)
  src/main/
    main.ts              startup, window, daemon link
    bridge-host.ts       every IPC handler (the renderer-facing API)
    daemon-link.ts       spawns/reconnects to the detached daemon
    desktop-notify.ts    native notifications (only a GUI can raise them)
    node-links.ts        routes agent-scoped calls to the owning node
    secrets-handoff.ts   re-encrypts secrets for the daemon
  src/preload/preload.ts the ONLY renderer<->main surface
  src/renderer/          React UI (App, Chat, Sidebar, Panels, Markdown)

apps/daemon/             headless host, and the `wispcrew` CLI
  src/serve.ts           the engine running with no window
  src/methods.ts         the node's method table — what a client may ask for
  src/cli.ts             command dispatch, argument parsing, usage
  src/cli-commands.ts    every command, and the schema that describes them
  src/cli-connect.ts     reaching the engine over the protocol, never the store
  src/cli-output.ts      text for people, `--json` for programs
  src/pending-approvals.ts a headless node can ask, if somebody is listening

examples/cli-agent/      a minimal example agent + the offline test suites
docs/CLI.md              the `wispcrew` binary: what it does and what it will not
docs/CONVERSATIONS.md    where the conversation model is going
docs/GROUP-CHAT.md       who speaks when several agents share a chat
```

## How it works (30 seconds)

1. `main.ts` installs the Electron host (data dir, keychain crypto), then
   **links to a detached daemon**, spawning one if none is running. The daemon
   owns the engine so routines and agents survive the window closing.
2. The renderer talks **only** to `window.wispcrew` (typed as `WispBridge` in
   `packages/shared/src/bridge.ts`), implemented by `bridge-host.ts`. Calls
   about a particular agent are routed to whichever node owns it — the local
   daemon, or a paired machine.
3. A message goes `sendPrompt` -> `runPrompt` -> `@wispcrew/core` `Agent` ->
   provider. Transcript entries are **pushed** back as `wc:event` frames and
   upserted by id, so streaming updates in place.
4. Tool calls hit the approval policy: `readonly` denies, `auto` allows, `ask`
   raises an approval card and waits for `resolveApproval`. **A daemon asks
   whoever is attached** — a desktop over TLS, or a CLI on its own machine —
   through the `ask`/`decision` frames, and denies only when nobody is
   connected. An unanswered request is still a denial, and so is a
   disconnect mid-request.
5. An agent can also be woken with nobody watching: a cron routine, a one-shot
   follow-up it scheduled itself, or a file change under its workspace. It
   reports back through the channels the user enabled.

**One engine per profile.** Two writers on one JSON store lose updates — this
was measured, not assumed — so the desktop refuses to run its own scheduler
when a daemon owns the profile.

## Commands

```bash
npm install                                     # npm workspaces (NOT pnpm)
npm run typecheck                               # tsc --noEmit everywhere
npm run build                                   # packages + desktop bundles
npm run test --workspace @wispcrew/examples-cli # every offline suite (no key, no network)
npm run desktop                                 # build + launch
npm run dist:win | dist:mac | dist:linux        # installers
npm run verify                                  # everything above, plus the guards
```

**The CLI is the third client**, alongside the desktop and the Telegram host.
Fifty commands, all through the daemon protocol:

```bash
wispcrew serve                    # the engine, with no window
wispcrew agents                   # what lives on this machine
wispcrew ask Builder "..."        # send a message, wait for the reply
wispcrew approvals allow <id>     # a headless node can ask a person
wispcrew capabilities --json      # the whole surface, for another agent
```

Two scripts keep it honest, both run by `verify`:
`scripts/check-cli-methods.cjs` (every method a command calls must exist on
the node — otherwise it fails only on a real machine, with `Unknown method`)
and `scripts/cli-gap.cjs` (how much of the desktop's surface the CLI
reaches).

**Run `npm run verify` before finishing.** It performs every check CI does
that a local machine can: typecheck, build, all offline suites, encoding, and
the provenance and credential guards. About two minutes, and it costs
nothing. If you touched `apps/desktop`, also launch the app once and confirm
it boots and chats.

**CI is a final gate, not a test loop.** A round trip takes ten minutes and
spends GitHub Actions minutes, which are a hard monthly allowance on a free
account. Exhausting them stops *all* CI until the quota resets — which
happened during development, from running CI after individual commits when
`npm run verify` would have caught the same things.

So: push and watch CI **once**, at the end of a body of work. The only thing
it judges that this machine cannot is **macOS and Linux** — window painting,
native dialogs, platform process behaviour. If a change does not touch that,
local verification is the whole story.

Config lives in `<userData>/wispcrew-settings.json`
(`%APPDATA%\WispCrew` on Windows). Keys live **only** in
`<userData>/wispcrew-secrets.enc`.

## Debug hooks

| Var | Effect |
|---|---|
| `WISPCREW_LOG=<file>` | Protocol/bridge log |
| `WISPCREW_CAPTURE=<file.png>` | Screenshot then quit |
| `WISPCREW_CAPTURE_DELAY=<ms>` | Delay before that capture (default 8000) |
| `WISPCREW_AUTOSEND='prompt'` | Drive one real turn headlessly |
| `WISPCREW_PROVIDER/API_KEY/MODEL/BASE_URL` | Provider fallback (env) |

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
11. **Make the wrong choice unavailable rather than discouraged.** Users
    bring their own model, including small self-hosted ones that follow
    instructions loosely. Measured on Llama 3.3 70B: an agent delegated
    "what is 3 + 4?" to another agent, and used `notify_user` to answer a
    question the user was already reading. Three separate prompt edits fixed
    neither, because **a tool that is offered gets used**. Removing the
    option worked: the default general-purpose agent is no longer a
    delegate, and `notify_user` is withheld from attended turns. This costs
    a strong model nothing and is the difference between working and not on
    a small one.

## Current state

**Working and verified live** (OpenAI, real key): streaming chat; tool calls
with approval gating; multi-turn memory; Stop/interrupt; encrypted key storage
with plaintext migration; MCP servers; agent roster with per-agent overrides;
routines (cron); skills; settings UI; **file/image attachments** (vision);
**agent-to-agent delegation**; **conversation rewind/branch**; **memory across
app restarts**. Confirmed with screenshots and transcript inspection, not
assumed.

**Also working, added since:**

- **A detached daemon** the desktop spawns and reconnects to, so agents and
  routines survive the window closing. It restarts itself when the app ships
  newer engine code (compared by build stamp).
- **Paired remote nodes** over TLS with per-node tokens and pinned
  fingerprints. An agent belongs to exactly one node; its conversation, files
  and keys live there. No central service.
- **Reaching the user**: an outbound queue with in-app, desktop-notification
  and Telegram delivery, chosen globally or per agent. Telegram is verified
  against the real API, including that punctuation-heavy agent output
  survives MarkdownV2 escaping.
- **Waking itself**: cron routines, one-shot follow-ups an agent schedules
  for itself, and debounced filesystem watches. A recurring routine needs the
  user's approval; a single follow-up does not.
- **Recovering a conversation**: any write that removes entries keeps the
  previous version, reachable from a History panel.

**Guards worth knowing about**, each added after something went wrong:
read-before-overwrite with version checks, bounded tool output with spill
files rather than silent truncation, a deadline on every tool call, and
process-identity checks so a recycled pid is never signalled.

**Provider routing:** OpenAI reasoning models (`gpt-5.x`, o-series) go to the
**Responses API**, because `/v1/chat/completions` refuses function tools for
them unless `reasoning_effort: "none"` — and that flag genuinely disables the
reasoning (measured: wrong answer with it, right answer without). Every other
OpenAI-compatible endpoint keeps chat-completions. `test:attachments` pins the
routing, including that a local server borrowing an OpenAI model name is not
rerouted.

**Test coverage**: 66 offline suites — no API key, no network.
Several caught real bugs when written, and a few caught bugs that had already
shipped; keep them green. Notable ones: `single-writer` (two engines on one
store), `shell-timeout` (a killed process emits `exit` with no `close` on
Windows), `pid-identity` (a recycled pid must not be signalled),
`observation` (no overwriting a file you have not read), `channels` (delivery
survives the process that queued it), and the `*-ui` suites, which check that
every CSS class a panel renders actually exists — that one caught a modal
which typechecked while looking broken.

A few suites need real credentials and are excluded from `npm test`:
`test:daemon`, `test:detached`, `test:live-remote`, `test:desktop-client`.

CI additionally boots the app headlessly on all three platforms and fails if
the window does not paint.

## Subscription sign-in

WispCrew can use a **Claude Pro/Max** or **ChatGPT** subscription instead of
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
  signing the user out of their CLI as well as WispCrew.
- A failed refresh **clears** the credential, so the UI says "signed out"
  instead of every turn failing with an auth error.
- Never invent usage numbers. Anthropic reports no percentage and no reset
  time on this path; the UI says so rather than showing a plausible figure.
- Adopting a CLI sign-in **reads** its credential file; WispCrew's own
  credentials live in its encrypted store, never written back to the CLI's.
- **A borrowed CLI credential is stored without its refresh token, on
  purpose.** The token is readable, but refreshing it would rotate it
  server-side and instantly invalidate the CLI's own copy — signing the user
  out of a tool they never asked WispCrew to touch, with a bare 401 that
  gives no hint why. This happened once during development on a real account.
  A borrowed sign-in is therefore read-only: when it expires it is cleared,
  and the user re-imports or uses WispCrew's own flow, which owns its
  credential and may rotate freely. `oauth-test.ts` pins this.

**Verified live:** the ChatGPT browser flow end to end (sign-in → token
exchange → streaming → tool call → refresh with rotation), CLI adoption
through the real IPC handlers, and DPAPI encryption at rest.

For Claude, the **token endpoint is confirmed working**: a real grant exchange
against `platform.claude.com/v1/oauth/token` returned a new access token with
a rotated refresh token, which proves the endpoint, client id, request shape
and response parsing. What remains unconfirmed is only the *browser half* —
opening the authorize page and pasting the code back — and Claude inference
itself, because the test account has been rate-limited throughout (429 for a
valid token vs 401 for an invalid one, so authentication is proven).

## Not yet done / known gaps

- macOS and Linux are **not verified on real hardware**. CI builds, tests and
  boots the app there, but cannot judge window chrome, native dialogs or
  keychain behaviour.
- The Claude browser sign-in's *browser half* (authorize page + paste-back) is
  unverified, as is Claude inference — the test account is rate-limited. The
  token endpoint itself is confirmed (see above).
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
