# Quickstart

Fifteen minutes from nothing to an agent that does something useful. Every
step here has been run on a clean machine; where something commonly goes
wrong, the fix is next to it rather than in a separate document.

## What you need

| | |
|---|---|
| **Node.js 20 or newer** | `node --version` |
| **A model** | An API key, a subscription, or Ollama running locally |
| **Disk** | About 700 MB for `node_modules`, plus your conversations |
| **Windows, macOS or Linux** | Windows is the most tested; see the honesty note at the end |

You do **not** need an account, a WispCrew login, or a network connection to
anything we run. There is nothing we run.

## 1. Install

```bash
git clone https://github.com/techartdev/wispcrew
cd wispcrew
npm install
npm run desktop
```

`npm install` takes a few minutes and downloads Electron, which is most of
the 700 MB.

**If it fails**, the usual cause is Node being too old — this uses features
from Node 20. `nvm install 20` or your platform's equivalent.

## 2. Choose a model

Open **Settings**. Three routes, in order of how quickly you can start:

**Free, no card.** [build.nvidia.com](https://build.nvidia.com/) gives you a
key and a catalogue of open models. Pick a chat model — the catalogue moves,
so if one returns 404 or 410 it has been retired; choose another.

**Your own API key.** DeepSeek, OpenAI, Anthropic, Groq, OpenRouter, or any
OpenAI-compatible endpoint. Paste the key; it is encrypted with your OS
keychain and never leaves the machine.

**Entirely offline.** Point it at [Ollama](https://ollama.com/) or LM Studio
and skip the key. Nothing touches the internet.

Then press **Test connection**. This is the difference between *configured*
and *working*: a key can be present, well-formed, and wrong.

## 3. Say something

Type in the box. The first agent, "Assistant", already exists.

Ask it to do something real — *"what files are in this folder?"* — and you
will see the second half of what makes this different from a chat window: it
asks permission before running the command, and shows you exactly what it
wants to run.

## 4. Give it a job while you are away

**Settings → Routines**, or from a terminal:

```bash
wispcrew routines create Assistant "0 9 * * *" "Summarise yesterday's commits"
wispcrew routines run <name>     # try it now rather than waiting until nine
```

A background daemon runs these whether or not the window is open.

## 5. Reach it from your phone

Create a bot with [@BotFather](https://t.me/botfather), paste the token into
**Settings → Channels**, then message your bot:

```
/connect Assistant
```

Now that conversation is reachable from either place. A reply typed on a
train is *your own turn* in the same room — not a message to a separate bot
with separate memory.

---

# Troubleshooting

Every entry here is a failure that actually happened during development, and
what it turned out to mean.

### "No WispCrew daemon is running for this profile"

A CLI command needs an engine to talk to. Start one:

```bash
wispcrew serve
```

Deliberately not automatic: a command that silently spawns a daemon leaves a
process you never asked for and will not think to stop.

### The provider says the model is gone (HTTP 410 or 404)

Free catalogues retire models, sometimes with no notice — NVIDIA retired
`llama-3.3-70b-instruct` in the middle of a development session. Pick another
from the provider's list and update the model in Settings, or:

```bash
wispcrew configure --model <another-model>
```

### "needs an API key" for a provider that has one

Almost always a *different profile* than you think. The desktop and a daemon
share one profile; a `--data-dir` flag points somewhere else entirely.

```bash
wispcrew status      # shows the resolved paths, not the defaults
wispcrew settings    # what this profile actually has
```

### A paired machine says "wrong token, or it is not accepting clients"

It used to mean the node had restarted and forgotten every client — fixed, so
a paired machine now survives a restart. If you see it on a version before
that fix, re-pair:

```bash
# on the other machine
wispcrew serve --listen --network --pair

# here
wispcrew pair <address> <code> --fingerprint <what it printed>
```

Compare the fingerprint. It is the one moment in this protocol with nothing
established to trust.

### An agent on another machine does nothing

Cross-machine rooms are relayed by the desktop, so they need it connected.
Single-machine agents and routines are unaffected. `docs/NODES-MODEL.md`
explains why, and what would lift the limitation.

### An agent stops and nothing happens

Something is waiting for permission. On the desktop it is a card in the
conversation; headlessly:

```bash
wispcrew approvals               # what is waiting
wispcrew approvals allow <id>
```

An unanswered request is **denied** after five minutes, so an unattended
agent fails safe rather than hanging forever.

### An agent answers, but does something odd first

Small models follow instructions loosely — one delegated *"what is 3 + 4?"*
to another agent rather than answering. Where that mattered, the wrong option
was removed rather than discouraged; see hard rule 11 in `AGENTS.md`. If your
model does something strange that is not covered, that is worth an issue.

### Windows: a command fails with quoting errors

PowerShell mangles inline shell commands containing quotes, backticks or
parentheses. Put the command in a file and run the file. This cost several
hours during development; `scripts/vps.ps1` exists because of it.

---

## Honestly, what is not proven

- **macOS and Linux** are built, tested and booted by CI, but never run on
  real hardware. Window chrome, native dialogs and keychain behaviour are
  unverified there.
- **Installers are unsigned**, so your OS will warn about an unknown
  publisher.
- **Claude inference** through a subscription is unconfirmed — the test
  account has been rate-limited throughout. The token exchange is verified.

If you hit any of these, an issue with what you saw is genuinely useful.
