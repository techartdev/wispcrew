# Contributing to GhostBot

Thanks for considering a contribution. This project exists because AI agents
should not require a subscription to a single company, and it gets better with
more eyes on it.

Contributions of every size are welcome — a typo fix is a real contribution.

## Ground rules

**Only original or permissively licensed code.** By opening a pull request you
confirm that you wrote the code, or that it comes from a source whose licence
permits redistribution under MIT, and that you have the right to contribute it.
Please do not submit code copied from a proprietary product, decompiled from a
binary, or produced by reverse-engineering a commercial application. This is
not a formality — it protects everyone who uses and forks this project.

## Getting set up

You need **Node.js 20+**. There is no other prerequisite.

```bash
git clone https://github.com/<your-fork>/ghostbot
cd ghostbot
npm install
npm run desktop
```

`npm install` uses **npm workspaces** — not pnpm or yarn. Please keep
`package-lock.json` in the tree.

**Build order matters.** Every package imports `@ghostbot/shared`, and
TypeScript resolves it through that package's generated `.d.ts` files. The
root `typecheck`, `test` and `build` scripts therefore build the packages in
dependency order first. If you add a package, add it to `build:packages` in
the root `package.json` — otherwise a fresh clone fails with `TS2307` while
your machine, which still has stale `dist/` output, looks fine.

## Before you open a pull request

Run these three. All must pass:

```bash
npm run typecheck
npm run build
npm run test --workspace @ghostbot/examples-cli
```

The test suite is fully offline — it needs no API key and makes no external
network calls, so it runs the same way on your machine and in CI.

If you touched anything under `apps/desktop`, also launch it once
(`npm run desktop`) and confirm the app still boots and chats.

## Repository layout

| Path | What lives there |
|---|---|
| `apps/desktop/src/main` | Electron main: IPC bridge, agent runs, scheduler, storage, secrets |
| `apps/desktop/src/preload` | The single IPC surface exposed to the renderer |
| `apps/desktop/src/renderer` | React UI |
| `packages/shared` | Types shared by everything; **no dependencies** |
| `packages/llm` | Provider adapters and presets |
| `packages/core` | The agent loop and personas |
| `packages/tools` | Built-in tools |
| `packages/mcp` | MCP stdio client |
| `examples/cli-agent` | Headless CLI + the offline test suites |

## Things worth knowing

A few constraints exist for real reasons; changing them needs a good one:

- **The renderer is sandboxed and must stay that way.** No Node integration,
  no direct `ipcRenderer`. Anything the UI needs goes through an explicitly
  named method in `preload.ts` and `bridge-host.ts`. There is deliberately no
  generic `invoke(channel, ...)` passthrough.
- **Never render model output as HTML.** `Markdown.tsx` builds React elements
  precisely so that a model response cannot inject markup. Do not introduce
  `dangerouslySetInnerHTML`.
- **API keys never reach the renderer.** `getSettings` reports
  `hasApiKey`/`isEncrypted`, never the value.
- **File tools stay inside the workspace root.** `resolveInRoot` enforces this;
  keep it that way when adding tools.
- **JSON readers tolerate a UTF-8 BOM.** Windows tooling writes them.
- **Dependencies are a security decision.** This app runs shell commands on the
  user's machine. Prefer a small amount of readable code over a new package,
  and please explain the trade-off in your PR if you add one.

## Adding things

**A provider**: add a preset in `packages/llm/src/presets.ts`. If it speaks the
OpenAI chat-completions format, that is usually all that is needed.

**A tool**: implement the `Tool` interface in `packages/tools/src/`, register it
in `registry.ts`, and consider whether it needs approval (anything that writes
or executes does).

**A test**: the suites in `examples/cli-agent/src/` are plain scripts with an
assertion helper — no framework. Add one alongside them and wire it into the
`test` script.

## Commits and pull requests

- Describe *why*, not just *what*. The diff shows what changed.
- Keep unrelated changes in separate PRs.
- Note anything you could not test (for example, macOS behaviour if you are on
  Windows). Honest gaps are far more useful than assumed coverage.

## Reporting bugs

Open an issue with what you expected, what happened, your OS, and which
provider and model you used. If the agent misbehaved, the transcript excerpt
helps — **with any API keys or private paths removed**.

For security issues, please follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.

## Code of Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
