/**
 * edit_file tool — surgical find/replace inside a workspace file.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@wispcrew/shared';
import { noteObserved } from './observation.js';
import { resolveInRoot, PathOutsideWorkspaceError } from './workspace.js';

/** Rewrite every line ending in `s` to `eol`. */
function withEol(s: string, eol: '\n' | '\r\n'): string {
  const flat = s.replace(/\r\n/g, '\n');
  return eol === '\n' ? flat : flat.replace(/\n/g, '\r\n');
}

/**
 * Find `oldText` in `content`, tolerating a different line-ending convention.
 *
 * ## Why this is not a nicety
 *
 * `edit_file` matched a literal substring. On Windows, git's default
 * `core.autocrlf=true` checks every file out with CRLF — measured on a real
 * repository: 1490 CRLF lines, not one bare LF — while a model writes `\n`,
 * because that is what it produces no matter what it read. So *every*
 * multi-line edit failed with "oldText not found", and the tool was
 * effectively unusable on the platform this app is developed on.
 *
 * What that looked like: an agent asked to resolve a merge conflict tried
 * the edit, failed, tried it again, then reached for a shell heredoc (cmd.exe
 * has none) and finally base64-encoded Python, exhausting its step budget on
 * a file it could read perfectly well.
 *
 * ## The literal attempt goes first, on purpose
 *
 * When it matches, nothing about this function is observable — the exact
 * bytes the caller asked for are replaced. Only when the literal fails does
 * the text get converted, and only to a convention the FILE already uses, so
 * the replacement region ends up consistent with its surroundings.
 *
 * Nothing outside the matched region is touched. Normalising the whole file
 * would have been simpler and would silently rewrite every line of a file
 * somebody asked to change three characters in — invisible in a diff viewer
 * and enormous in a commit.
 */
function findMatch(
  content: string,
  rawOld: string,
  rawNew: string,
): { oldText: string; newText: string; count: number } {
  const literal = content.split(rawOld).length - 1;
  if (literal > 0) return { oldText: rawOld, newText: rawNew, count: literal };

  /*
   * Try the file's own conventions, most likely first.
   *
   * Both are attempted because a file can be mixed — a CRLF file with an LF
   * region is common in repositories that changed convention part-way — and
   * the point is to match the region actually there.
   */
  for (const eol of ['\r\n', '\n'] as const) {
    const candidate = withEol(rawOld, eol);
    if (candidate === rawOld) continue;

    const count = content.split(candidate).length - 1;
    if (count > 0) {
      return { oldText: candidate, newText: withEol(rawNew, eol), count };
    }
  }

  return { oldText: rawOld, newText: rawNew, count: 0 };
}

/** How this file ends its lines, for a not-found message that helps. */
function describeEols(content: string): string {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/\n/g) ?? []).length - crlf;

  if (crlf > 0 && lf === 0) {
    return 'This file uses Windows line endings (CRLF); that is handled automatically, so the text itself differs.';
  }
  if (crlf > 0 && lf > 0) {
    return `This file has mixed line endings (${crlf} CRLF, ${lf} LF).`;
  }
  return '';
}

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
    // The shared rule, not a third private copy of it. See `workspace.ts`.
    let full: string;
    try {
      full = resolveInRoot(ctx, args.path);
    } catch (err) {
      if (!(err instanceof PathOutsideWorkspaceError)) throw err;
      return {
        id: '',
        name: 'edit_file',
        ok: false,
        errorCode: 'outside_workspace',
        content: err.message,
      };
    }
    if (!args.oldText) {
      return { id: '', name: 'edit_file', ok: false, errorCode: 'bad_args', content: 'oldText must not be empty' };
    }
    try {
      const content = await fs.readFile(full, 'utf8');

      const match = findMatch(content, args.oldText, args.newText);

      if (match.count === 0) {
        /*
         * Say WHY, when the reason is knowable.
         *
         * "oldText not found" sent a model straight into guesswork: it
         * retried the same edit, then a shell heredoc (which cmd.exe does
         * not have), then base64-encoded Python — nine failed calls and its
         * whole step budget, for a file it could see perfectly well. Naming
         * the line-ending convention lets it adapt instead of escalating.
         */
        const detail = describeEols(content);
        return {
          id: '',
          name: 'edit_file',
          ok: false,
          errorCode: 'not_found',
          content:
            `oldText not found in ${args.path}.` +
            (detail ? ` ${detail}` : '') +
            ' Read the file again and copy the exact text you want to replace.',
        };
      }

      const { oldText, newText, count } = match;

      if (count > 1 && !args.replaceAll) {
        return {
          id: '',
          name: 'edit_file',
          ok: false,
          errorCode: 'ambiguous',
          content: `oldText appears ${count} times in ${args.path}; set replaceAll=true or use a more specific oldText`,
        };
      }
      const updated = args.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
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
