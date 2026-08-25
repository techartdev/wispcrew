/**
 * File tools — read/write/list within the agent workspace.
 */
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@ghostbot/shared';
import { checkWrite, noteObserved } from './observation.js';

const MAX_READ_BYTES = 300_000;

function resolveInRoot(ctx: ToolContext, p: string): string {
  const root = path.resolve(ctx.workspaceRoot || process.cwd());
  const target = path.resolve(root, p);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new PathOutsideWorkspaceError(target, root);
  }
  return target;
}

class PathOutsideWorkspaceError extends Error {
  constructor(target: string, root: string) {
    super(`Path ${target} is outside the workspace root ${root}`);
    this.name = 'PathOutsideWorkspaceError';
  }
}

/**
 * Turn a filesystem error into something the model (and user) can act on.
 *
 * A raw `ENOENT: no such file or directory, scandir '/very/long/path'` tells
 * the model almost nothing and leads it to retry the identical call. Saying
 * *which* thing is missing — the workspace itself, or just this file — lets
 * it either fix the path or report the real problem.
 */
function describeFsError(err: unknown, ctx: ToolContext, p: string, tool: string): ToolResult {
  const e = err as NodeJS.ErrnoException;
  const root = path.resolve(ctx.workspaceRoot || process.cwd());
  const workspaceGone = !existsSync(root);

  let content: string;
  if (e.code === 'ENOENT' && workspaceGone) {
    content =
      `The workspace folder does not exist: ${root}. ` +
      'Set a valid workspace folder for this agent in its Configure panel.';
  } else if (e.code === 'ENOENT') {
    content = `No such file or directory: ${p}`;
  } else if (e.code === 'EACCES' || e.code === 'EPERM') {
    content = `Permission denied: ${p}`;
  } else if (e.code === 'EISDIR') {
    content = `${p} is a directory, not a file.`;
  } else if (e.code === 'ENOTDIR') {
    content = `${p} is not a directory.`;
  } else if (e.name === 'PathOutsideWorkspaceError') {
    content = (err as Error).message;
  } else {
    content = `${tool} failed: ${(err as Error).message}`;
  }

  return { id: '', name: tool, ok: false, errorCode: e.code ?? 'error', content };
}

interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export const readFileTool: Tool<ReadArgs> = {
  definition: {
    name: 'read_file',
    description:
      'Read a text file from the workspace. Returns the content (truncated to 300KB). ' +
      'Use offset/limit to page through large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root' },
        offset: { type: 'number', description: 'Byte offset to start from' },
        limit: { type: 'number', description: 'Max bytes to read' },
      },
      required: ['path'],
    },
  },
  async run(args: ReadArgs, ctx: ToolContext): Promise<ToolResult> {
    try {
      const full = resolveInRoot(ctx, args.path);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(full);
        return {
          id: '',
          name: 'read_file',
          ok: true,
          content: `[directory]\n${entries.map((e) => `- ${e}`).join('\n')}`,
          data: { entries },
        };
      }
      const offset = Math.max(args.offset ?? 0, 0);
      const limit = Math.min(args.limit ?? MAX_READ_BYTES, MAX_READ_BYTES);
      const buf = Buffer.alloc(limit);
      const handle = await fs.open(full, 'r');
      try {
        const { bytesRead } = await handle.read(buf, 0, limit, offset);
        const text = buf.subarray(0, bytesRead).toString('utf8');
        const truncated = bytesRead >= limit && stat.size > offset + limit;

        /*
         * Only a COMPLETE read counts as having observed the file.
         *
         * A partial or offset read leaves parts unseen, and permitting an
         * overwrite on the strength of it would destroy content the agent
         * never looked at — precisely the failure the guard exists for.
         */
        if (offset === 0 && !truncated) noteObserved(full);

        return {
          id: '',
          name: 'read_file',
          ok: true,
          content: text + (truncated ? `\n...[truncated at ${limit} bytes; file is ${stat.size} bytes]` : ''),
          data: { size: stat.size, bytesRead },
        };
      } finally {
        await handle.close();
      }
    } catch (err) {
      return {
        ...describeFsError(err, ctx, args.path, 'read_file'),
      };
    }
  },
};

interface WriteArgs {
  path: string;
  content: string;
  append?: boolean;
}

export const writeFileTool: Tool<WriteArgs> = {
  definition: {
    name: 'write_file',
    description:
      'Write text content to a file inside the workspace (creates parent dirs). ' +
      'Set append=true to append instead of overwrite.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root' },
        content: { type: 'string', description: 'Full content to write (or append)' },
        append: { type: 'boolean', description: 'Append to the file instead of overwriting' },
      },
      required: ['path', 'content'],
    },
  },
  async run(args: WriteArgs, ctx: ToolContext): Promise<ToolResult> {
    try {
      const full = resolveInRoot(ctx, args.path);

      // Creating parent directories inside the workspace is expected. Silently
      // recreating the *workspace itself* is not: if the user deleted or
      // unmounted that folder, resurrecting it hides the mistake and scatters
      // files where they will not be looked for.
      const root = path.resolve(ctx.workspaceRoot || process.cwd());
      try {
        await fs.access(root);
      } catch {
        return {
          id: '',
          name: 'write_file',
          ok: false,
          errorCode: 'missing_workspace',
          content:
            `The workspace folder does not exist: ${root}. ` +
            'Set a valid workspace folder for this agent in its Configure panel.',
        };
      }

      /*
       * A full replacement of an existing file must be earned by reading it.
       *
       * Appending adds without removing, and creating a new file destroys
       * nothing — both proceed freely. Only overwriting is guarded, because
       * that is the operation that silently discards content nobody looked
       * at. Two incidents in this project's own history were exactly this.
       */
      if (!args.append) {
        const verdict = checkWrite(full);
        if (!verdict.allowed) {
          return {
            id: '',
            name: 'write_file',
            ok: false,
            errorCode: verdict.errorCode,
            content: verdict.reason,
          };
        }
      }

      await fs.mkdir(path.dirname(full), { recursive: true });
      const flags = args.append ? 'a' : 'w';
      await fs.writeFile(full, args.content, { encoding: 'utf8', flag: flags });
      const stat = await fs.stat(full);

      // What is on disk is now exactly what we just wrote, so a follow-up
      // write needs no fresh read.
      noteObserved(full, args.append ? undefined : args.content);

      return {
        id: '',
        name: 'write_file',
        ok: true,
        content: `Wrote ${args.append ? '(appended) ' : ''}${args.content.length} bytes to ${args.path}`,
        data: { size: stat.size },
      };
    } catch (err) {
      return {
        ...describeFsError(err, ctx, args.path, 'write_file'),
      };
    }
  },
};

interface ListArgs {
  path: string;
  recursive?: boolean;
}

export const listDirTool: Tool<ListArgs> = {
  definition: {
    name: 'list_dir',
    description: 'List files and directories inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root (default ".")' },
        recursive: { type: 'boolean', description: 'List recursively (can be large)' },
      },
      required: [],
    },
  },
  async run(args: ListArgs, ctx: ToolContext): Promise<ToolResult> {
    try {
      const full = resolveInRoot(ctx, args.path || '.');
      const out: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const ent of entries) {
          const rel = path.relative(ctx.workspaceRoot || process.cwd(), path.join(dir, ent.name)).replace(/\\/g, '/');
          if (ent.isDirectory()) {
            out.push(`${rel}/`);
            if (args.recursive && depth < 4) await walk(path.join(dir, ent.name), depth + 1);
          } else {
            out.push(rel);
          }
        }
      };
      await walk(full, 0);
      const content = out.length ? out.join('\n') : '(empty directory)';
      return { id: '', name: 'list_dir', ok: true, content, data: { entries: out } };
    } catch (err) {
      return {
        ...describeFsError(err, ctx, args.path || '.', 'list_dir'),
      };
    }
  },
};
