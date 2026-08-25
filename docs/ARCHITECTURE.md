# Architecture

WispCrew is an Electron desktop app with a React renderer, a Node main
process, and a set of framework-free TypeScript packages that hold the actual
agent logic.

There is **no WispCrew service**: no account, no cloud component, nothing
belonging to this project between the user and their model. What leaves a
machine leaves it because the user configured it to:

- the request to whichever **LLM provider** they chose;
- **Telegram**, if they connected a bot, so a conversation is reachable from
  a phone;
- a **paired node** they own — another machine of theirs, over TLS with a
  pinned fingerprint;
- the **OAuth endpoint** of a subscription they signed into.

Each is opt-in and visible in the interface. This paragraph used to read
"everything runs on the user's machine", which stopped being a complete
description once nodes, channels and subscription sign-in existed — worth
correcting rather than leaving as a comfortable half-truth.

## Process layout

```
+---------------------------- Electron ----------------------------+
|                                                                  |
|  Renderer (sandboxed)                Main (Node)                 |
|  +------------------------+          +------------------------+  |
|  | App.tsx                |          | main.ts                |  |
|  |  |- Sidebar (roster)   |          |  |- runPrompt()        |  |
|  |  |- Chat (transcript)  |          |  |- runRoutine()       |  |
|  |  +- Panels (settings)  |          |  +- window / menu      |  |
|  | useWispcrew.ts (state) |          | bridge-host.ts (IPC)   |  |
|  +-----------+------------+          | store.ts (persistence) |  |
|              |                       | scheduler.ts + cron.ts |  |
|      window.wispcrew                 | agent-sessions.ts      |  |
|              |                       | mcp-manager.ts         |  |
|  +-----------v------------+          | secrets-store.ts       |  |
|  | preload.ts             |<-------->+-----------+------------+  |
|  | (the only IPC surface) |  gb:* / gb:event     |               |
|  +------------------------+                      |               |
+---------------------------------------------------+--------------+
                                                    |
                    +-------------------------------v--------------+
                    | @wispcrew/core   Agent loop                  |
                    | @wispcrew/llm    provider adapters           |
                    | @wispcrew/tools  shell/files/edit/grep/web   |
                    | @wispcrew/mcp    MCP stdio client            |
                    | @wispcrew/shared types (no dependencies)     |
                    +-------------------+--------------------------+
                                        | HTTPS
                                +-------v--------+
                                | LLM provider   |
                                +----------------+
```

## The IPC contract

`packages/shared/src/bridge.ts` defines `WispBridge` — the complete set of
methods the renderer may call, and the `BridgeEvent` union main may push. It
is a single typed interface rather than loose channel strings, which means:

- The attack surface is enumerable in one file.
- The renderer and main cannot drift apart without a type error.
- There is no generic `invoke(channel, ...)` escape hatch.

**Requests return plain values and reject on failure.** An earlier design used
`{ok, value} | {ok, failure}` envelopes; whenever a shape drifted the UI
silently rendered nothing. A rejected promise cannot be misread.

**Streaming is pushed, not polled.** Main sends `gb:event` frames; the
renderer upserts transcript entries by id. The assistant message keeps one
stable id and is rewritten as tokens arrive, so the UI updates in place at
token speed with no polling interval to tune.

## A message, end to end

1. `Chat.tsx` calls `sendPrompt(agentId, text)`.
2. `bridge-host.ts` appends a user entry, pushes it, and calls `runPrompt`
   without awaiting — the call returns as soon as the prompt is accepted.
3. `runPrompt` (main.ts) resolves the **effective config**: per-agent overrides
   win over global settings; the API key comes from the encrypted store.
4. A skill reference (`/name`) is expanded here, so routines get the same
   behaviour as the UI.
5. `getSession` returns the persistent `Agent` for that agentId, rebuilding it
   only if a config fingerprint changed (so a model switch takes effect while
   preserving history).
6. The agent streams: `delta` events append to the assistant entry;
   `tool_call_start`/`tool_call_result` become tool cards.
7. Tool calls consult the approval policy — `readonly` denies, `auto` allows,
   `ask` raises an approval card and blocks on `resolveApproval`.
8. On completion the assistant entry is flushed with `isStreaming: false` and
   run state returns to `idle`.

## Persistence

`store.ts` writes plain JSON under `<userData>`:

| File | Contents |
|---|---|
| `wispcrew-settings.json` | Global settings. **Never** an API key. |
| `wispcrew-secrets.enc` | API keys, encrypted via Electron `safeStorage`. |
| `agents.json` | The agent roster. |
| `transcripts/<agentId>.json` | Per-agent conversation history. |
| `routines.json` | Scheduled routines and recent run records. |
| `skills.json` | Reusable instruction sets. |

Two properties matter: writes are **atomic** (temp file + rename, so a crash
cannot truncate the roster), and readers are **BOM-tolerant** (Windows tooling
writes UTF-8 BOMs that would otherwise break `JSON.parse`).

Plain JSON is a deliberate choice over SQLite: at this scale it is fast enough,
adds no native dependency, and a user can read, diff, back up, or hand-edit
their own data — which matters for an open-source tool.

## Scheduling

`cron.ts` parses standard 5-field expressions and evaluates them in a named
IANA timezone using `Intl.DateTimeFormat`, so DST is handled by the platform's
own rules rather than a bundled tz database.

`scheduler.ts` runs **one** timer aligned to the wall-clock minute. On each
tick it fires any matching routine, with three deliberate behaviours:

- **Missed ticks are not replayed.** A machine asleep for six hours does not
  wake to six agent runs — that costs real money and is rarely wanted.
- **A routine never overlaps itself.** A tick arriving while the previous run
  is still going is recorded as `skipped`.
- **Failures are contained.** A throwing routine records an `error` run; the
  timer keeps going.

## Security boundaries

The app runs shell commands by design, so the boundaries are explicit:

| Boundary | Mechanism |
|---|---|
| Renderer isolation | `sandbox: true`, `contextIsolation: true`, no `nodeIntegration` |
| IPC surface | Only the named methods in `preload.ts` |
| Remote content | Strict CSP: no remote/inline script, no outbound connections from the UI; external links open in the OS browser |
| Model output | Rendered as React elements, never HTML; only `http(s)` links are clickable |
| Filesystem | `resolveInRoot` confines file tools to the workspace root |
| Destructive actions | Approval policy gates writes and commands |
| Credentials | OS keychain encryption; never sent to the renderer |

See [SECURITY.md](../SECURITY.md) for the threat model.

## Package boundaries

`packages/shared` has **zero dependencies** and contains only types. Everything
else depends on it and not on each other, except: `core` uses `tools` and
`shared`; `llm` and `mcp` use `shared` alone. The desktop app composes them.

This keeps the agent loop reusable — `examples/cli-agent` runs the same
`Agent` headlessly, which is why the offline suites can test real behaviour
without Electron.
