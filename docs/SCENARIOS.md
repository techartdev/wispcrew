# What has actually been run

Not a test plan — a record of paths exercised end to end, and what happened.
The distinction matters: a passing suite proves a function behaves, and this
proves the software does.

Anything unverified says so, with the reason. A gap named is a gap someone
can close; a gap glossed is a gap the next person rediscovers.

## Verified

| Scenario | What happened |
|---|---|
| **Desktop chat** | Streams token by token, updates in place, keeps memory across restarts |
| **A room with two agents** | Both joined, handles distinct, `@handle` reaches one and `@all` reaches both |
| **Interrupting a turn** | Keeps the partial reply — 92 characters of a paragraph — and the model's memory matches what the transcript shows |
| **A cron routine firing** | Scheduled for the minute after next, fired unattended on a real clock, agent answered, turn recorded as `completed` |
| **An approval from the CLI** | An agent on the VPS asked for the shell, `approvals allow` answered from a second terminal, and the command ran |
| **A paired VPS** | Paired from the desktop and from the CLI; an agent created there stays routable |
| **Node restart** | Restarted with no pairing window open; the desktop reconnected with the credential it already held |
| **Daemon restart** | Agents, task history, routines, settings and the stored key all intact — 5 tasks before, 5 after |
| **`WISPCREW_LOG` headlessly** | Writes a real file, and a canary key configured through the CLI never appears in it: `[keys] stored key for nvidia` |
| **A wrong API key** | "NVIDIA NIM rejected the API key. Open Settings and check the key is correct and still active" |
| **A retired model** | HTTP 410 surfaced with the provider's own explanation, not a stack trace |
| **An unreachable node** | Named the machine and said it was not connected, rather than failing silently |
| **A deleted agent** | Removed from its own room, from rooms it had joined, and its transcript deleted |
| **Telegram, unconfigured** | "No bot token saved on this machine" — names the missing piece rather than reporting a generic failure |

## Not verified, and why

**A Telegram round-trip.** Verified earlier in development against the real
API — placeholder-edit streaming, MarkdownV2 escaping, inline approval
buttons, topic routing — but the bot token used for it was revoked after
appearing in development transcripts, so it cannot be re-run here. What is
checked now is the unconfigured path, which is the state most users are in.

**A genuinely clean first run.** Not testable on a machine that has ever run
this: WispCrew migrates a profile from its two former names, so a fresh
`--user-data-dir` still imported 19 files. That migration is correct and
wanted — it is how an existing user keeps their agents across a rename — and
it means the live route measures an upgrade. The pieces are pinned in
`test:first-run` instead, where the profile is empty because the test made
it.

**macOS and Linux.** CI builds, tests and boots the app on both, but nobody
has run it on real hardware. Window chrome, native dialogs and keychain
behaviour are unknown there.

**Claude inference through a subscription.** The token exchange is confirmed
against the real endpoint; inference is not, because the test account has
been rate-limited throughout. A 429 for a valid token and a 401 for an
invalid one is enough to prove authentication and nothing about the model.

## How to re-run these

Most are ordinary use. The two worth scripting:

```bash
# a routine on a real clock — schedule for the minute after next,
# because "the next minute" may be milliseconds away
wispcrew routines create <agent> "<mm> <hh> * * *" "Reply with: fired"
wispcrew tasks                     # it should appear as completed

# an approval, from two terminals
wispcrew ask <agent> "run df -h"   # blocks, prints the id to allow
wispcrew approvals allow <id>      # in the other terminal
```

`scripts/vps.ps1` runs a script file on the remote machine, because
PowerShell mangles inline shell commands containing quotes — that cost hours
before it existed.
