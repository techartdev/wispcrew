# Status & Roadmap

Last verified: **2026-08-24**, from a clean build on Windows 11 with a live
OpenAI key.

## Verified working

Everything below was confirmed by running it — screenshots, transcript
inspection, or a passing assertion — not by reading the code.

| Area | Evidence |
|---|---|
| App boots and renders | Screenshot of the running window (roster, chat, panels) |
| Streaming chat | Live OpenAI turn; assistant entry updates in place |
| Tool calls | `list_dir` executed live; card shows `Done`; model used the real output |
| Approval gating | Denial respected (shell blocked); `auto` and `readonly` policies honoured |
| Workspace confinement | Path traversal outside the workspace root rejected |
| Multi-turn memory | Turn 2 recalled turn 1's tool use; `test:memory` asserts history growth |
| Interrupt (Stop) | Aborts the turn and leaves a provider-valid history |
| Encrypted keys | Key present only in `ghostbot-secrets.enc` (DPAPI `v10`), unreadable in ciphertext, absent from settings |
| Plaintext migration | A legacy plaintext key is moved into the encrypted store on next boot |
| Skills | `/canary` expanded in main; model received the body, transcript kept the literal |
| Cron scheduler | 50+ assertions; cross-checked against a naive scan over 144 cases in 6 timezones |
| Markdown safety | Script tags, `javascript:`/`data:`/`file:` links neutralised |
| Attachments | Live: text file read by the model; image described correctly (vision) |
| Current OpenAI models | Live tool calls + reasoning on `gpt-5.6-luna`/`-sol`, `gpt-5.5`, `gpt-5.4-mini` |
| Agent delegation | Live: one agent asked another and relayed its answer; a deliberately cyclic pair terminated after exactly one hop |
| Workspace confinement | 30 assertions: traversal, absolute paths, prefix siblings, case variants, NUL bytes, writes and listings |
| Conversation rewind / branch | Branch leaves the original untouched; every transcript prefix rebuilds to a provider-valid history |
| Memory across restarts | Live: a fact stated in one process was recalled by a **separate** process |
| Standing tool grants | Persist across restarts, listed and revocable in Settings, dropped with their agent, fail closed on a corrupt file |
| Actionable provider errors | A wrong key, model, or base URL produces advice, not an HTTP dump; verified live against each failure |
| First run on a clean profile | Verified with an empty userData dir: onboarding banner, guided composer, and a missing key reported as "needs an API key", never as "rejected" |
| Accessibility | Live-region announcements, `aria-expanded` tool cards, modal focus trap with focus restore, visible focus rings |
| ChatGPT subscription sign-in | Browser OAuth verified end to end: sign-in, token exchange, streaming, tool call, refresh with rotation |
| Claude subscription sign-in | Authentication proven (valid token 429 vs invalid 401); the browser code exchange is **unverified** — the test account was rate-limited |
| Subscription credentials | Stored DPAPI-encrypted (`v10`), absent from the ciphertext and from settings; verified through the real app's IPC handlers |
| Plan usage display | Live: "0% of your premium limit used · resets in 7 days". No usage endpoint exists, so this appears only after a turn |
| Offline suites | All thirteen pass with no API key and no network |
| **Fresh-clone workflow** | `git clone` → `npm ci` → typecheck → build → tests → `pack` → packaged app boots and renders. Verified from a real clone, not the working tree |
| Typecheck / build | Clean across all workspaces |

## Architecture note

The app is **entirely original work**. An earlier iteration vendored a
proprietary desktop application (797 files) and spoke its reverse-engineered
IPC protocol. That tree, the protocol shim, the branding scripts, and the
reverse-engineering notes have all been removed. The UI, IPC contract,
storage layer, scheduler, and Markdown renderer are our own implementations,
which is what makes the MIT licence accurate.

CI fails the build if a `vendor/` directory reappears.

## Provider notes

OpenAI's reasoning models (`gpt-5.x`, o-series) are routed to the **Responses
API** (`/v1/responses`) rather than chat-completions. This is not a
preference: `/v1/chat/completions` rejects function tools for those models
unless you also send `reasoning_effort: "none"`, and that flag genuinely turns
the reasoning off. Measured on the rising-tide ladder puzzle,
`reasoning_effort:"none"` answers **7** (wrong) while the Responses API with
default reasoning answers **10** (right). Every other OpenAI-compatible
endpoint — DeepSeek, Ollama, LM Studio, Groq, OpenRouter — keeps using
chat-completions, which is the only thing they implement. A routing test in
`test:attachments` pins this, including that a local server borrowing an
OpenAI model name is *not* rerouted.

## Known gaps

1. **macOS and Linux are not verified on real hardware.** CI now builds,
   typechecks, runs every offline suite, and **boots the app headlessly** on
   ubuntu/macOS/windows runners, failing if the window does not paint — so the
   obvious platform breaks are caught automatically. What CI cannot judge is
   how the app *feels*: window chrome, menu placement, font rendering, native
   dialogs, and whether the OS keychain behaves as expected. Hands-on reports
   from macOS and Linux users remain the most useful outside contribution.
   A source audit found no hardcoded platform paths, and one real Windows-only
   bug was fixed: MCP server arguments containing spaces were split by
   `cmd.exe`.
2. **Installers are unsigned.** Windows SmartScreen and macOS Gatekeeper will
   warn. Signing needs certificates the project does not have.
3. **No auto-update channel.**
5. **Web search quality depends on the configured backend.** See
   `packages/tools/src/web.ts`.

## Agent delegation

An agent can hand a self-contained task to another agent via the `ask_agent`
tool, and the delegate's work lands in *its own* transcript — the user can
open that agent and read exactly what was asked and done, rather than the
delegation being an invisible side effect.

The limits exist because this is the easiest feature to turn into a
money-burning loop:

| Guard | Value | Why |
|---|---|---|
| Depth | 3 | Bounds a chain that keeps handing work down |
| Cycle detection | — | An agent already in the chain is not offered as a target |
| Fan-out | 5 per turn | A model that decides to "ask everyone" cannot |
| Self-delegation | blocked | Always a bug |
| Timeout | 5 min | One stuck delegate cannot hang the chain |
| Policy inheritance | narrowing only | A `readonly` agent cannot escalate by asking a permissive agent to act for it |

That last row is a real privilege-escalation guard, not a nicety. When a
delegate has no remaining capacity it is told so explicitly — without that,
an agent instructed to "always delegate" would echo the request back instead
of answering (observed live before the fix).

## Roadmap

Roughly in order of value to a new user:

1. **macOS/Linux verification** and any fixes that fall out.
2. **Per-agent sandboxing** — stronger isolation than a workspace root; would
   be a genuine improvement over products whose agents share one environment.
3. **Signed installers + an update channel.**
4. **i18n.**
5. **Per-tool argument scoping** for grants — e.g. allow `shell` only for
   commands matching a pattern. Deliberately not built yet: argument matching
   is exactly where sandbox escapes live, so it needs a careful design rather
   than a regex.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md). The offline suites must stay green,
and all contributions must be original or permissively licensed work.
