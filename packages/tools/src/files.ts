/**
 * File tools — read/write/list within the agent workspace.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@ghostbot/shared';

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
        id: '',
        name: 'read_file',
        ok: false,
        errorCode: (err as NodeJS.ErrnoException).code ?? 'error',
        content: `read_file failed: ${(err as Error).message}`,
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
      await fs.mkdir(path.dirname(full), { recursive: true });
      const flags = args.append ? 'a' : 'w';
      await fs.writeFile(full, args.content, { encoding: 'utf8', flag: flags });
      const stat = await fs.stat(full);
      return {
        id: '',
        name: 'write_file',
        ok: true,
        content: `Wrote ${args.append ? '(appended) ' : ''}${args.content.length} bytes to ${args.path}`,
        data: { size: stat.size },
      };
    } catch (err) {
      return {
        id: '',
        name: 'write_file',
        ok: false,
        errorCode: (err as NodeJS.ErrnoException).code ?? 'error',
        content: `write_file failed: ${(err as Error).message}`,
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
        id: '',
        name: 'list_dir',
        ok: false,
        errorCode: (err as NodeJS.ErrnoException).code ?? 'error',
        content: `list_dir failed: ${(err as Error).message}`,
      };
    }
  },
};
