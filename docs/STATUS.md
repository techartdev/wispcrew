# Status & Roadmap

Last verified: **2026-09-03**, from a clean build on Windows 11, a real
Hetzner VPS, and a live Telegram bot.

**Where we are.** The engine, the three clients (desktop, daemon+CLI,
Telegram) and the conversation model are built and exercised daily against
real providers. The last several sessions have been almost entirely about
the seams between them — the places where something was written but never
announced, declared but never read, or implemented on one host and not the
other. That is where nearly every reported bug has lived, and the guards
listed below exist to make each class fail the build instead of reaching a
user.

**87 offline suites**, no API key and no network. `npm run verify` runs them
plus typecheck, build, encoding, and the provenance and credential guards.

## What a new reader should know first

Three facts explain most of the design:

1. **The daemon owns the profile.** The desktop is a client of it, and so is
   the CLI, and so is the Telegram host. A method implemented on only one
   host fails at the moment of use — which is why
   `scripts/check-bridge-methods.cjs` and `scripts/check-cli-methods.cjs`
   both exist.
2. **Everything an agent changes must be announced from where it changes
   it.** The client-facing doors announce their own mutations; an agent
   editing room instructions or scheduling a routine goes through neither.
   Four separate "I had to reload" bugs were this.
3. **What the transcript records is not automatically what the model sees.**
   `rebuildHistory` is the seam, and three fields were being dropped there
   (`authorId`, `via`, and the age of a tool result). Each one produced a
   plausible-looking wrong answer.

## Verified working

Confirmed by running it — screenshots, transcript inspection, or a passing
assertion — not by reading the code.

| Area | Evidence |
|---|---|
| App boots and renders | Screenshot of the running window (roster, chat, panels) |
| Streaming chat | Live OpenAI turn; assistant entry updates in place |
| Tool calls | Executed live; card shows `Done`; model used the real output |
| Approval gating | Denial respected; `auto` and `readonly` policies honoured |
| Workspace confinement | 30 assertions: traversal, absolute paths, prefix siblings, case variants, NUL bytes, writes and listings |
| Multi-turn memory | Turn 2 recalled turn 1's tool use; `test:memory` asserts history growth |
| Memory across restarts | Live: a fact stated in one process was recalled by a **separate** process |
| Interrupt (Stop) | Aborts the turn and leaves a provider-valid history |
| Encrypted keys | Key present only in `wispcrew-secrets.enc` (DPAPI `v10`), unreadable in ciphertext, absent from settings |
| Skills | `/canary` expanded in main; model received the body, transcript kept the literal |
| Cron scheduler | 50+ assertions; cross-checked against a naive scan over 144 cases in 6 timezones |
| Markdown safety | Script tags, `javascript:`/`data:`/`file:` links neutralised |
| Attachments | Live: text file read by the model; image described correctly (vision) |
| Agent delegation | Live: one agent asked another and relayed its answer; a deliberately cyclic pair terminated after exactly one hop |
| Conversation rewind / branch | Branch leaves the original untouched; every transcript prefix rebuilds to a provider-valid history |
| Standing tool grants | Persist across restarts, listed and revocable in Settings, dropped with their agent, fail closed on a corrupt file |
| Actionable provider errors | A wrong key, model, or base URL produces advice, not an HTTP dump |
| First run on a clean profile | Empty userData dir: onboarding banner, guided composer, a missing key reported as "needs an API key", never as "rejected" |
| Accessibility | Live-region announcements, `aria-expanded` tool cards, modal focus trap with focus restore, visible focus rings |
| ChatGPT subscription sign-in | Browser OAuth end to end: sign-in, token exchange, streaming, tool call, refresh with rotation |
| The CLI, on a real server | `configure`, `agents create`, `ask`, `rooms`, `tasks`, `capabilities` on a Hetzner VPS over SSH |
| Headless approval | `wispcrew ask` raised a shell request; `approvals allow` answered from a second terminal |
| Paired remote nodes | Pairing without a desktop, surviving a node restart, an agent created on one machine staying routable from another |
| **Rooms** | Two agents in one conversation, addressed by handle; a mention by one agent wakes the other, bounded by a turn budget |
| **Context measurement** | Per-agent meters against the provider's own `inputTokens`; no percentage where the window is unknown |
| **Compaction** | Measured on a real conversation: 114 → 31 entries, 41,616 → 19,592 tokens, kept turns byte-identical, all 114 restorable |
| **Watch-triggered routines** | Live on a real filesystem: proposed, approved, watcher started, file written, routine fired |
| **Telegram, both directions** | `/connect` binds a chat to a room, `/who` lists the handles, a message from the phone runs a real turn, and desktop activity is mirrored back |
| **Daemon reconnect** | Killed the daemon under a running window; the desktop detected the drop, spawned a replacement and relinked |
| Offline suites | All 87 pass with no API key and no network |
| Fresh-clone workflow | `git clone` → `npm ci` → typecheck → build → tests → `pack` → packaged app boots |

## Recently fixed, and worth knowing about

Each of these shipped and was found in use. They are listed because the
*class* matters more than the instance.

| Symptom | Cause |
|---|---|
| "The agent thinks it is in the wrong repository" | `shell` used `args.cwd` verbatim; `grep` resolved an absolute path against the root and discarded it. Now one `resolveInRoot` helper |
| "I had to reload for the routine to appear" | `routines-changed` was emitted only by the two client-facing doors, and an agent scheduling for itself goes through neither |
| "The other agent simply didn't get the task" | `routeAgentMessage` was written, exported, tested — and called from nowhere |
| "Find my chat does nothing" | No token had ever been stored: the node's `saveSettings` wrote `telegramToken` to the **plaintext settings file** and never to the encrypted store. `writeSettings` now refuses credentials outright |
| "Unknown method discoverChatId" | Implemented only in the desktop bridge, which forwards to the daemon. Eleven more were in the same state |
| "Nothing appears in the desktop app" | The daemon restarts itself on a newer build; the desktop only logged the drop and never reconnected |
| "Nowhere have I seen an approval card" | The downgrade notice was sent to the model, which asked for permission in prose instead of calling its tool — so no approval was ever raised |
| An agent answering from seven-hour-old tool output | `rebuildHistory` emitted no time information at all, and the prompt never stated the date |

## Guards

Each was added after something reached a user.

| Guard | What it prevents |
|---|---|
| `check-bridge-methods.cjs` | A bridge method the daemon lacks — `Unknown method` at the moment of use |
| `check-cli-methods.cjs` | The same, for CLI commands |
| `writeSettings` credential refusal | A key or token reaching the plaintext settings file |
| `test:platform-audit` | Windows-only path handling, and the two provenance greps drifting apart |
| `test:announce` | An engine-side mutation that no client is told about |
| The `*-ui` suites | A panel rendering a CSS class that does not exist |
| `test:observation` | Overwriting a file that was never read |
| `test:single-writer` | Two engines on one JSON store |

## Provider notes

OpenAI's reasoning models (`gpt-5.x`, o-series) are routed to the **Responses
API** rather than chat-completions. `/v1/chat/completions` rejects function
tools for those models unless you also send `reasoning_effort: "none"`, and
that flag genuinely turns the reasoning off — measured on the rising-tide
ladder puzzle, it answers **7** (wrong) against the Responses API's **10**
(right). Every other OpenAI-compatible endpoint keeps chat-completions,
which is the only thing they implement.

**Reasoning effort** is per agent and offered only where the pairing accepts
it. The values are model-dependent, not merely provider-dependent: the
o-series takes three levels and rejects `xhigh`. Anthropic has no effort enum
at all — extended thinking is a token budget, and the panel says so. NVIDIA,
DeepSeek and local runtimes are offered nothing, because a control that
silently does nothing costs trust in every other control.

## Known gaps

1. **macOS and Linux are not verified on real hardware.** CI builds,
   typechecks, runs every offline suite and boots the app headlessly on all
   three platforms, so obvious breaks are caught. What it cannot judge is how
   the app *feels*: window chrome, menu placement, font rendering, native
   dialogs, keychain behaviour. Hands-on reports remain the most useful
   outside contribution.
2. **Installers are unsigned.** SmartScreen and Gatekeeper will warn.
3. **No auto-update channel.**
4. **The Claude browser sign-in's browser half is unverified**, as is Claude
   inference — the test account has been rate-limited throughout. The token
   endpoint itself is confirmed by a real grant exchange.
5. **A group chat cannot bootstrap its own Telegram binding.** The bot
   accepts messages from the configured chat, or from one already bound, so
   `/connect` typed in a fresh group is refused for want of a binding. Using
   a group means making it the configured chat first.
6. **Standing approval is per agent, not per room.** With two agents in a
   room the per-channel policy is set twice, and the Telegram card offers
   only Allow and Deny — a standing grant must be made at the desktop.
   Whether that is the right trade is an open question, not a settled one.
7. **Web search quality depends on the configured backend.** See
   `packages/tools/src/web.ts`.

## Roadmap

Roughly in order of value to a new user:

1. **macOS/Linux verification** and any fixes that fall out.
2. **Approval ergonomics** — see gap 6. Now that cards are actually raised,
   this can be judged from use rather than guessed at.
3. **Per-agent sandboxing** — stronger isolation than a workspace root.
4. **Signed installers + an update channel.**
5. **i18n.**
6. **Per-tool argument scoping** for grants. Deliberately not built:
   argument matching is exactly where sandbox escapes live, so it needs a
   design rather than a regex.

## Architecture note

The app is **entirely original work**. An earlier iteration vendored a
proprietary desktop application (797 files) and spoke its reverse-engineered
IPC protocol. That tree, the protocol shim, the branding scripts and the
reverse-engineering notes have all been removed. The UI, IPC contract,
storage layer, scheduler and Markdown renderer are our own implementations,
which is what makes the MIT licence accurate. CI fails the build if a
`vendor/` directory reappears.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md). The offline suites must stay green,
and all contributions must be original or permissively licensed work.
