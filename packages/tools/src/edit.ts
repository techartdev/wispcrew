/**
 * edit_file tool — surgical find/replace inside a workspace file.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@wispcrew/shared';
import { noteObserved } from './observation.js';

interface EditArgs {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export const editFileTool: Tool<EditArgs> = {
  definition: {
    name: 'edit_file',
    description:
      'Replace text inside a file. oldText must appear exactly once unless replaceAll=true. ' +
      'Returns a short diff-style confirmation. Prefer this over write_file for targeted changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        oldText: { type: 'string', description: 'Exact text to find' },
        newText: { type: 'string', description: 'Replacement text' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },

  async run(args: EditArgs, ctx: ToolContext): Promise<ToolResult> {
    const root = path.resolve(ctx.workspaceRoot || process.cwd());
    const full = path.resolve(root, args.path);
    if (full !== root && !full.startsWith(root + path.sep)) {
      return { id: '', name: 'edit_file', ok: false, errorCode: 'outside_workspace', content: `Path ${args.path} is outside the workspace root` };
    }
    if (!args.oldText) {
      return { id: '', name: 'edit_file', ok: false, errorCode: 'bad_args', content: 'oldText must not be empty' };
    }
    try {
      const content = await fs.readFile(full, 'utf8');
      const count = content.split(args.oldText).length - 1;
      if (count === 0) {
        return { id: '', name: 'edit_file', ok: false, errorCode: 'not_found', content: `oldText not found in ${args.path}` };
      }
      if (count > 1 && !args.replaceAll) {
        return {
          id: '',
          name: 'edit_file',
          ok: false,
          errorCode: 'ambiguous',
          content: `oldText appears ${count} times in ${args.path}; set replaceAll=true or use a more specific oldText`,
        };
      }
      const updated = args.replaceAll ? content.split(args.oldText).join(args.newText) : content.replace(args.oldText, args.newText);
      await fs.writeFile(full, updated, 'utf8');
      // An edit reads the file, replaces a known substring and writes the
      // result — the contents are known exactly, so record them.
      noteObserved(full, updated);
      const added = updated.length - content.length;
      return {
        id: '',
        name: 'edit_file',
        ok: true,
        content: `Edited ${args.path}: replaced ${args.replaceAll ? `${count} occurrences` : '1 occurrence'} (${added >= 0 ? '+' : ''}${added} bytes)`,
        data: { occurrences: args.replaceAll ? count : 1, deltaBytes: added },
      };
    } catch (err) {
      return {
        id: '',
        name: 'edit_file',
        ok: false,
        errorCode: (err as NodeJS.ErrnoException).code ?? 'error',
        content: `edit_file failed: ${(err as Error).message}`,
      };
    }
  },
};
