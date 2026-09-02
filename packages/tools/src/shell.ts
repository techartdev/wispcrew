/**
 * Shell tool — run a command on the agent's own computer.
 *
 * Safety: by default every shell invocation requires explicit approval
 * (configurable via ToolContext options). Commands are killed on timeout
 * and output is truncated to protect the model context.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { retainText } from './retention.js';
import { resolveInRoot, workspaceRootOf, PathOutsideWorkspaceError } from './workspace.js';
import type { Tool, ToolContext, ToolResult } from '@wispcrew/shared';

interface ShellArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /** Internal: set by the harness for already-approved re-runs. */
  noApproval?: boolean;
}

export const shellTool: Tool<ShellArgs> = {
  definition: {
    name: 'shell',
    description:
      "Run a shell command on the user's computer. On Windows uses cmd.exe, otherwise /bin/sh. " +
      'Blocks up to timeoutMs (default 30s). Returns stdout, stderr and exit code. ' +
      'Requires user approval unless already granted.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: {
          type: 'string',
          description:
            'Working directory, relative to the workspace root and confined to it. ' +
            'Defaults to the workspace root.',
        },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 30000, max 300000)' },
        noApproval: {
          type: 'boolean',
          description: 'Internal: set by the harness for approved re-runs; models should never set this.',
        },
      },
      required: ['command'],
    },
  },

  async run(args: ShellArgs, ctx: ToolContext): Promise<ToolResult> {
    /*
     * Resolve the working directory BEFORE asking for approval.
     *
     * Two reasons. The approval card quotes the cwd, and a card that showed
     * a directory the command would not actually run in would be asking the
     * user to agree to the wrong thing. And a request that is going to be
     * refused should not cost somebody a decision first.
     *
     * `args.cwd` used to be taken verbatim — a model-supplied absolute path,
     * used with no check, and advertised in this tool's own description. An
     * agent confined to `D:\Mine\OpenClawHomeAssistant` ran `git remote -v`
     * and reported a completely different repository, because the command
     * had run in a completely different folder. It was not hallucinating; it
     * was reading a real answer from outside its boundary.
     */
    let cwd: string;
    try {
      cwd = args.cwd ? resolveInRoot(ctx, args.cwd) : workspaceRootOf(ctx);
    } catch (err) {
      if (!(err instanceof PathOutsideWorkspaceError)) throw err;
      return {
        id: '',
        name: 'shell',
        ok: false,
        errorCode: 'outside_workspace',
        content: err.message,
      };
    }

    const approved =
      args.noApproval === true ||
      (await ctx.requestApproval({
        toolName: 'shell',
        summary: `Run command: ${args.command.slice(0, 200)}`,
        detail: `cwd: ${cwd}`,
        payload: { command: args.command },
      }));
    if (!approved) {
      return {
        id: '',
        name: 'shell',
        ok: false,
        errorCode: 'denied',
        content: 'Command was not approved by the user.',
      };
    }

    const timeoutMs = Math.min(Math.max(args.timeoutMs ?? ctx.defaultTimeoutMs, 100), 300_000);

    // Refuse to run when the working directory does not exist.
    //
    // Two reasons. First, honesty: Windows reports this as
    // "spawn cmd.exe ENOENT", which reads as if the shell were missing
    // rather than the folder. Second, containment: on POSIX the behaviour of
    // spawning with a bad cwd is less predictable, and a command that
    // silently runs somewhere *other* than the workspace would defeat the
    // boundary the workspace root is there to provide.
    if (!existsSync(cwd)) {
      return {
        id: '',
        name: 'shell',
        ok: false,
        errorCode: 'missing_cwd',
        content:
          `The working directory does not exist: ${cwd}. ` +
          'Set a valid workspace folder for this agent in its Configure panel.',
      };
    }

    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    /*
     * Wrap the whole command line in quotes on Windows.
     *
     * `cmd /s /c` has a documented rule: it strips the first and last
     * character of the command string when both are quotes, then runs the
     * rest verbatim. Passing a bare command means a line that *begins* with
     * a quoted path — `"C:\Program Files\...\ssh.exe" -i ...` — loses that
     * opening quote and splits at the first space, giving:
     *
     *   'C:\Program' is not recognized as an internal or external command
     *
     * Adding an outer pair gives /s something to strip, so the command
     * arrives intact. This is the same trick cmd's own documentation
     * describes, and it is why `cmd /s /c ""a b" "c d""` works.
     */
    const shellArgs = isWin
      ? ['/d', '/s', '/c', `"${args.command}"`]
      : ['-c', args.command];

    return await new Promise<ToolResult>((resolve) => {
      let child;
      try {
        child = spawn(shell, shellArgs, {
          cwd,
          // POSIX only: make the child its own group leader so a timeout can
          // signal the whole group. Windows has no groups; taskkill /T is used
          // there instead.
          detached: !isWin,
          env: { ...process.env, ...(ctx.env ?? {}) },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          /*
           * Hand the command line to cmd.exe exactly as written.
           *
           * Windows has no argv array — a process receives one string and
           * parses it itself. Node therefore builds that string, and by
           * default it escapes embedded quotes with backslashes. `cmd.exe`
           * does not use backslash escaping, so a command containing quoted
           * paths arrived as literal \" and failed:
           *
           *   '\"C:\Program Files\nodejs\node.exe\"' is not recognized...
           *
           * Every command with a quoted path was affected, which is most
           * real Windows commands. An agent trying to use an ssh key under
           * "C:\Users\Vanyo Vanev\.ssh" concluded the problem was the space
           * in the path and started copying files to work around it; the
           * space was fine, the escaping was not.
           *
           * `windowsVerbatimArguments` passes the string through untouched,
           * which is what a shell needs. It is safe here precisely *because*
           * this is a shell: the string is already a command line by
           * definition, not a list of arguments being assembled.
           */
          windowsVerbatimArguments: isWin,
        });
      } catch (err) {
        resolve({
          id: '',
          name: 'shell',
          ok: false,
          errorCode: 'spawn_failed',
          content: `Failed to spawn shell: ${(err as Error).message}`,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      // Set when Stop reached us, so the result can say so rather than
      // reporting a bare non-zero exit that looks like the command failed.
      let aborted = false;

      /*
       * Kill the whole process tree, not just the shell we spawned.
       *
       * `child.kill` signals `cmd.exe` or `/bin/sh`, and its descendants
       * survive — an `ssh` still waiting on a host keeps running, and keeps
       * holding the stdio pipes. Beyond hanging the tool, that leaves real
       * processes behind every time a command times out.
       *
       * Windows has no process groups, so `taskkill /T` is the documented
       * way. On POSIX the child is its own group leader (see `detached`
       * below), so a negative pid signals the group.
       */
      const killTree = () => {
        try {
          if (isWin && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
            }).unref();
          } else if (child.pid) {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          // Already gone, or the group vanished between check and signal.
          try {
            child.kill('SIGKILL');
          } catch {
            /* nothing left to kill */
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);

      /*
       * Stop must reach a command that is already running.
       *
       * The abort signal was available on the context and nothing here
       * listened for it, so pressing Stop did nothing until the command
       * finished on its own — up to the full timeout. Reported after a
       * shell call deadlocked: the agent sat at "working", Stop had no
       * effect, and the only way out was to wait or reload.
       *
       * The same kill the timeout uses. Killing the whole tree matters:
       * `child.kill` would signal the shell and leave whatever it spawned
       * running, which is exactly the process somebody is trying to stop.
       */
      const onAbort = () => {
        aborted = true;
        killTree();
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      // Already cancelled before we got here: do not start a command whose
      // only future is being killed.
      if (ctx.signal?.aborted) onAbort();

      /*
       * Collect everything; bound it once, at the end.
       *
       * The previous version cut each stream at 200 KB and threw the rest
       * away, and — separately — set `timedOut` when it did, so a merely
       * chatty command was reported to the model as having timed out. It had
       * not; it had said too much.
       *
       * A hard ceiling still exists so a runaway process cannot exhaust
       * memory, but it is far above the point where output stops being
       * useful inline, and hitting it is a reason to stop reading rather
       * than a failure.
       */
      const HARD_CEILING = 4_000_000;
      let stoppedForVolume = false;

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > HARD_CEILING) {
          stoppedForVolume = true;
          killTree();
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > HARD_CEILING) {
          stoppedForVolume = true;
          killTree();
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve({
          id: '',
          name: 'shell',
          ok: false,
          errorCode: 'spawn_error',
          content: `spawn error: ${err.message}`,
        });
      });

      /*
       * Settle on `exit`, not `close`.
       *
       * `close` waits for every stdio pipe to be closed, which is a
       * different event from the process ending. A command that spawns
       * children — `ssh`, a shell with a background job, anything that
       * daemonises — hands those pipes to descendants that keep them open
       * after the parent is killed.
       *
       * Measured on Windows: killing even a plain `ping` emitted `exit` with
       * no `close` at all. So a timed-out command never resolved, the tool
       * call never returned, and the agent sat on "Running" forever with no
       * way to recover short of restarting. That is what a user saw with an
       * `ssh` waiting on an unreachable host.
       *
       * Resolving here can lose the last few bytes still in flight, which is
       * a small price for a tool call that always returns.
       */
      let settled = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        /*
         * Bound each stream, spilling the rest to a file rather than
         * discarding it. The model gets the head and tail plus a statement
         * of what was omitted and where to find it; the user can open the
         * file. Nothing is destroyed.
         */
        const outRetained = retainText(stdout, { label: 'stdout' });
        const errRetained = retainText(stderr, { label: 'stderr' });

        const content = [
          /*
           * Said first, because otherwise a stopped command reads as a
           * failed one: the model sees a non-zero exit and a kill signal
           * and reasonably concludes the command was broken, then tries
           * again — which is the last thing somebody pressing Stop wants.
           */
          aborted ? '[stopped by the user]' : '',
          timedOut ? `[timed out after ${timeoutMs}ms]` : '',
          stoppedForVolume
            ? '[stopped: the command produced more output than can be collected]'
            : '',
          outRetained.text ? `--- stdout ---\n${outRetained.text}` : '',
          errRetained.text ? `--- stderr ---\n${errRetained.text}` : '',
          `--- exit code: ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`,
        ]
          .filter(Boolean)
          .join('\n');

        /*
         * A non-zero exit is reported as not-ok, and that is a decision.
         *
         * Plenty of commands use a non-zero exit to mean something other
         * than failure: `git merge` returns 1 on conflicts, `git diff
         * --check` on findings, `grep` on no match. All three show as
         * "Failed" in the transcript despite having done exactly what was
         * asked, which was noticed on a real merge.
         *
         * Left as it is, deliberately. There is no way to tell those apart
         * from a genuine failure without a per-command table of exit-code
         * meanings — which would be wrong for anything not in it, and this
         * tool runs arbitrary commands. The exit code and the full output
         * are in `content`, so the model has what it needs to interpret it,
         * and it did: the agent that hit this read the conflict list and
         * carried on correctly.
         *
         * What would be worth building is a status the UI can show that is
         * neither "Done" nor "Failed" — "exit 1" is a fact rather than a
         * judgement. That needs `data` to reach the transcript entry, which
         * it currently does not.
         */
        resolve({
          id: '',
          name: 'shell',
          ok: code === 0 && !timedOut,
          errorCode: timedOut ? 'timeout' : code === 0 ? undefined : 'exit_nonzero',
          content,
          data: { exitCode: code, signal: signal ?? null, timedOut },
        });
      };

      /*
       * Prefer `close` when it arrives, because it guarantees all output has
       * been read. `exit` is the backstop that guarantees we answer at all.
       *
       * The short grace period lets a well-behaved command deliver its last
       * chunk; a command whose descendants hold the pipes simply never fires
       * `close`, and the timer settles it instead.
       */
      child.on('exit', (code, signal) => {
        setTimeout(() => finish(code, signal), 150).unref?.();
      });
      child.on('close', (code, signal) => finish(code, signal));
    });
  },
};
