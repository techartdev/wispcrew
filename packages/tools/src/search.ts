/**
 * grep tool — regex search across workspace files.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveInRoot, workspaceRootOf, PathOutsideWorkspaceError } from './workspace.js';
import type { Tool, ToolContext, ToolResult } from '@wispcrew/shared';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', '__pycache__']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_RESULTS = 120;

interface GrepArgs {
  pattern: string;
  path?: string;
  ignoreCase?: boolean;
  include?: string;
  maxResults?: number;
}

export const grepTool: Tool<GrepArgs> = {
  definition: {
    name: 'grep',
    description:
      'Search file contents with a regular expression inside the workspace. ' +
      'Returns up to 120 matches as file:line:content. Skips node_modules, .git and build outputs.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for' },
        path: { type: 'string', description: 'File or directory to search (default: workspace root)' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive match' },
        include: { type: 'string', description: 'Only search files whose name matches this glob-ish substring (e.g. ".ts")' },
        maxResults: { type: 'number', description: 'Cap on matches (default 120)' },
      },
      required: ['pattern'],
    },
  },

  async run(args: GrepArgs, ctx: ToolContext): Promise<ToolResult> {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.ignoreCase ? 'i' : '');
    } catch (err) {
      return { id: '', name: 'grep', ok: false, errorCode: 'bad_pattern', content: `Invalid regex: ${(err as Error).message}` };
    }
    const maxResults = Math.min(args.maxResults ?? MAX_RESULTS, MAX_RESULTS);
    const root = workspaceRootOf(ctx);

    /*
     * `path.resolve(root, args.path)` is NOT containment.
     *
     * It discards everything left of an absolute segment, so an absolute
     * `path` argument was honoured in full and `grep` happily searched any
     * directory on the machine. It reads like a containment expression,
     * which is why it survived so long.
     */
    let start: string;
    try {
      start = resolveInRoot(ctx, args.path ?? '.');
    } catch (err) {
      if (!(err instanceof PathOutsideWorkspaceError)) throw err;
      return {
        id: '',
        name: 'grep',
        ok: false,
        errorCode: 'outside_workspace',
        content: err.message,
      };
    }

    const matches: string[] = [];
    let searchedFiles = 0;
    let skippedBytes = 0;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (matches.length >= maxResults || depth > 8) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (matches.length >= maxResults) return;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue;
          await walk(full, depth + 1);
          continue;
        }
        if (args.include && !ent.name.includes(args.include)) continue;
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_FILE_BYTES) {
            skippedBytes += stat.size;
            continue;
          }
          const content = await fs.readFile(full, 'utf8');
          searchedFiles++;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
            const lineText = lines[i] ?? '';
            if (re.test(lineText)) {
              const rel = path.relative(root, full).replace(/\\/g, '/');
              const line = lineText.trim().slice(0, 200);
              matches.push(`${rel}:${i + 1}: ${line}`);
            }
          }
        } catch {
          /* unreadable file */
        }
      }
    };

    try {
      const st = await fs.stat(start);
      if (st.isFile()) {
        // single-file search
        const content = await fs.readFile(start, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          const lineText = lines[i] ?? '';
          if (re.test(lineText)) matches.push(`${path.basename(start)}:${i + 1}: ${lineText.trim().slice(0, 200)}`);
        }
        searchedFiles = 1;
      } else {
        await walk(start, 0);
      }
    } catch (err) {
      return {
        id: '',
        name: 'grep',
        ok: false,
        errorCode: (err as NodeJS.ErrnoException).code ?? 'error',
        content: `grep failed: ${(err as Error).message}`,
      };
    }

    const truncated = matches.length >= maxResults;
    const summary = `[${matches.length} match${matches.length === 1 ? '' : 'es'} across ${searchedFiles} file${searchedFiles === 1 ? '' : 's'}`;
    return {
      id: '',
      name: 'grep',
      ok: true,
      content: `${summary}${skippedBytes ? `; skipped ${(skippedBytes / 1e6).toFixed(1)} MB of large files` : ''}]${truncated ? ' (truncated)' : ''}\n` + matches.join('\n'),
      data: { matches, searchedFiles },
    };
  },
};
