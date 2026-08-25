# Ideas worth stealing (and the line we do not cross)

Notes from reading other agent harnesses. **No code is copied from any of
them.** What travels is a *problem statement* — "pids get recycled", "tool
results can be enormous" — which is not anyone's intellectual property.
Implementations here are written from the description of the problem, not
from anyone's source.

That distinction is the whole point of rule 1 in `AGENTS.md`. Reading how a
competitor frames a problem is ordinary engineering literacy. Lifting their
solution is not, and would cost GhostBot the ability to be MIT-licensed.

## DeepSeek Harness

[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
— an "everything is a plugin" harness built on Cordis
([announcement](https://www.deepseek.com/harness/en/)). Its package list is
public and unusually explicit about what each piece is responsible for, which
makes it a good map of problems a mature harness has to solve.

### Adopted

**PID plus start identity.** Their subprocess layer carries "PID plus start
identity, preventing teardown escalation after PID reuse".

We had exactly this bug and had just made it worse: the stale-daemon check
added this week kills a pid read from a file. If a daemon dies and the OS
recycles its number, that file names a stranger's process — and we would
have killed it. Now `isSameProcess` compares the recorded start time, and an
unconfirmed pid is left alone.

Ours is a different implementation (PowerShell `Get-Process` / `ps -o
etimes=`, a one-minute tolerance because the daemon records its own start
after booting). The *idea* is theirs; the code is not.

### Worth considering, not yet built

**Bounded tool output with spill files.** They have `dsh-output-retention`
and `dsh-spill-policy`: oversized tool results are replaced with a retained
preview plus a path to the full text, and a neutral notice saying what was
kept and what was omitted.

Ours truncates at 200 KB and says `[stdout truncated]`. The remainder is
simply gone. A user debugging a long build output cannot get it back, and
the model is told nothing about the shape of what it lost. Their framing —
"what did we keep, what did we omit" — is better.

**Read-before-edit as a policy, not a convention.**
`dsh-fs-observation-policy` enforces "observed-state, read-before-edit, and
version-guarded write". We rely on the model choosing to read first. A
version guard would have prevented at least one class of clobbering during
this project's own development.

**Durability checkpoints.** `dsh-session-checkpoint-policy` writes "semantic
session durability checkpoints before model requests and tool side effects".

We have no such thing, and it cost a real conversation this week: a careless
cleanup removed 33 transcript entries with no way back. A checkpoint before
side effects — or simply keeping the previous version of a transcript on
write — would have made that recoverable.

**Per-tool deadlines as a wrapper.** `dsh-tool-call-timeout-policy` arms a
deadline around *any* tool rather than each tool implementing its own. Our
shell tool handles its own timeout and does it properly now, but nothing
protects a slow MCP call or a web fetch.

### Deliberately not adopted

**A plugin architecture for everything.** Cordis lets them swap the agent
loop, the storage backend, the UI. That is the right shape for a harness
other people build products on. GhostBot is an application: a user wants an
agent that works, not a composition surface. The indirection would cost
readability — which is the thing that makes a security-sensitive codebase
auditable — and buy flexibility nobody asked for.

**Splitting into ~180 packages.** Excellent for a platform with independent
release cycles. For one desktop app it would turn every change into a
cross-package refactor.

## OpenClaw

Referenced by the user as prior art for keeping agents alive on
user-supplied machines. GhostBot's node model arrived at a similar place —
pair your own hardware, no hosted service — but by a different route: the
constraint here was "MIT, no cloud, no accounts", and node pairing is what
falls out of that.
