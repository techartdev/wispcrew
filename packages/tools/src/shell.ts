/**
 * Shell tool — run a command on the agent's own computer.
 *
 * Safety: by default every shell invocation requires explicit approval
 * (configurable via ToolContext options). Commands are killed on timeout
 * and output is truncated to protect the model context.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Tool, ToolContext, ToolResult } from '@ghostbot/shared';

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
        cwd: { type: 'string', description: 'Working directory; defaults to workspace root' },
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
    const approved =
      args.noApproval === true ||
      (await ctx.requestApproval({
        toolName: 'shell',
        summary: `Run command: ${args.command.slice(0, 200)}`,
        detail: `cwd: ${args.cwd ?? ctx.workspaceRoot ?? process.cwd()}`,
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
    const cwd = args.cwd ?? ctx.workspaceRoot ?? process.cwd();

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

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > 200_000) {
          stdout = stdout.slice(0, 200_000) + '\n...[stdout truncated]';
          timedOut = true;
          try {
            killTree();
          } catch {
            /* noop */
          }
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > 200_000) stderr = stderr.slice(0, 200_000) + '\n...[stderr truncated]';
      });

      child.on('error', (err) => {
        clearTimeout(timer);
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

        const content = [
          timedOut ? `[timed out after ${timeoutMs}ms]` : '',
          stdout ? `--- stdout ---\n${stdout}` : '',
          stderr ? `--- stderr ---\n${stderr}` : '',
          `--- exit code: ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`,
        ]
          .filter(Boolean)
          .join('\n');

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
