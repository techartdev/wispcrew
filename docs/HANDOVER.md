# Handover

Written at the end of the build-out. This is the honest state of the project:
what is verified, what is assumed, and what to do first.

## What WispCrew is

A free, MIT-licensed, local-first desktop AI agent. The user brings their own
model — DeepSeek, OpenAI, Anthropic, Groq, OpenRouter, Ollama, LM Studio, or
any OpenAI-compatible endpoint. No account, no subscription, no cloud
component. Conversations and API keys stay on the user's machine.

## Two things to do first

1. **Push to GitHub.** The repository is initialised and committed but has
   never been pushed. The remote is not configured.

   ```bash
   git remote add origin https://github.com/techartdev/wispcrew.git
   git push -u origin main
   ```

2. **Destroy the test key.** A live OpenAI key was used throughout
   development. It is gitignored and was never committed (verified before
   every commit), but it exists in two places on this machine:

   - `testkey.txt` in the repository root
   - `%APPDATA%\WispCrew\wispcrew-secrets.enc` (encrypted, but recoverable
     by this OS user)

   It also sat in **plaintext** in the settings file briefly during round 2,
   before that bug was found and fixed. **Treat it as compromised and revoke
   it at platform.openai.com**, rather than merely deleting the files.

## Verified, with evidence

Everything below was confirmed by running it — from a **clean clone**, not the
working tree — during the final round.

| Claim | Evidence |
|---|---|
| Clean clone builds | `git clone` → `npm ci` → `typecheck` → `build`, all exit 0 |
| Tests pass | 52 offline suites, no API key, no network |
| Packages | `npm run pack` → 325 MB, no `vendor/` in the output |
| Packaged app runs | Boots on a **fresh profile**, renders the first-run screen |
| Live provider | Tool call executed and the model used the real result |
| No vendored code | No `vendor/` at any depth; no proprietary identifiers |
| Licensing | Only React, React-DOM, Electron reach users — all MIT. No GPL/AGPL/SSPL anywhere in the tree |
| Secrets | The key string appears in no committed file; absent from a fresh clone |

## Not verified — be honest about this

- **macOS and Linux have never run on real hardware.** CI builds, tests and
  boots the app headlessly on all three platforms, which catches the obvious
  breaks. It cannot judge window chrome, native dialogs, menu placement, font
  rendering, or whether the OS keychain behaves as expected. **This is the
  single most valuable thing an outside contributor can do.**
- **Installers are unsigned.** Windows SmartScreen and macOS Gatekeeper will
  warn. Signing needs certificates the project does not have.
- **No real user has used this.** Every "verified live" above is a scripted
  run by an agent. Three consecutive rounds of testing each found a genuine
  bug purely by trying a *state* nobody had tried before — an empty profile,
  a deleted workspace folder, an empty agent roster. The remaining risk is in
  states neither the author nor I thought of, and only real use will surface
  them.
- **Only OpenAI was live-tested.** The Anthropic adapter and the local
  providers (Ollama, LM Studio) are exercised by offline wire-format tests but
  have not been run against the real services.

## Architecture in one paragraph

The renderer is fully sandboxed and reaches the main process only through an
enumerated IPC surface (`packages/shared/src/bridge.ts`, implemented by
`apps/desktop/src/main/bridge-host.ts`). A message flows
`sendPrompt → runPrompt → @wispcrew/core Agent → provider`, with results
**pushed** back as events rather than polled. Tool calls pass through an
approval policy. Everything durable is plain JSON under `<userData>`, written
atomically. See `docs/ARCHITECTURE.md`.

## Decisions worth knowing before changing things

These are places where the obvious approach is wrong, each learned by hitting
the problem:

- **OpenAI reasoning models use the Responses API.** `/v1/chat/completions`
  refuses function tools for `gpt-5.x` unless `reasoning_effort: "none"`, and
  that flag genuinely disables reasoning — measured on a puzzle where it gave
  the wrong answer with it and the right answer without. Every other
  OpenAI-compatible endpoint keeps chat-completions; nothing else implements
  `/v1/responses`.
- **Markdown is rendered as React elements, never HTML.** Model output is
  untrusted input. There is no `dangerouslySetInnerHTML` and no sanitizer to
  trust.
- **Grants are per agent *and* per tool, never wildcarded**, and a corrupt
  grants file fails closed.
- **Argument-scoped grants were deliberately not built.** "Allow `shell` when
  the command starts with `git`" sounds useful and is where sandbox escapes
  live.
- **The cron parser and Markdown renderer are hand-written.** This app runs
  shell commands; every dependency is a supply-chain decision.
- **Build order is explicit.** Everything imports `@wispcrew/shared` through
  its generated `.d.ts`, so `--workspaces` in arbitrary order breaks a fresh
  clone. If you add a package, add it to `build:packages`.

## Where to start

`AGENTS.md` is the orientation file for both humans and coding agents. It
carries the repository map, the commands, and the hard rules. `docs/STATUS.md`
has the detailed state; `CONTRIBUTING.md` is what a new contributor reads.

The most useful next work, in order:

1. macOS/Linux verification on real hardware.
2. Real-world use, and fixing what it surfaces.
3. Signed installers and an update channel.
4. Live-testing the Anthropic and local providers.

## Provenance

This project previously vendored and reverse-engineered a proprietary desktop
application. **All of it was removed** — 998 files across two locations,
including a copy nested under `apps/` that an initial cleanup missed. The
current UI, IPC contract, storage layer, scheduler, Markdown renderer and
branching logic are original implementations. CI fails the build if a
`vendor/` directory reappears at any depth, or if identifiers from that
codebase are reintroduced.

Do not reinstate that material. Design from the feature you want, not from
another product's internals — that is what makes the MIT licence on this
repository true rather than aspirational.
