/**
 * Shell tool — run a command on the agent's own computer.
 *
 * Safety: by default every shell invocation requires explicit approval
 * (configurable via ToolContext options). Commands are killed on timeout
 * and output is truncated to protect the model context.
 */
import { spawn } from 'node:child_process';
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
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', args.command] : ['-c', args.command];

    return await new Promise<ToolResult>((resolve) => {
      let child;
      try {
        child = spawn(shell, shellArgs, {
          cwd,
          env: { ...process.env, ...(ctx.env ?? {}) },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
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

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > 200_000) {
          stdout = stdout.slice(0, 200_000) + '\n...[stdout truncated]';
          timedOut = true;
          try {
            child.kill('SIGKILL');
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

      child.on('close', (code, signal) => {
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
      });
    });
  },
};
