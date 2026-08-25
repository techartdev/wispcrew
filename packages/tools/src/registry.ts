/**
 * Tool registry — maps tool names to implementations.
 */
import type { Tool, ToolDefinition, ToolContext, ToolResult } from '@ghostbot/shared';
import { shellTool } from './shell.js';
import { readFileTool, writeFileTool, listDirTool } from './files.js';
import { webFetchTool, webSearchTool } from './web.js';
import { grepTool } from './search.js';
import { editFileTool } from './edit.js';

export * from './shell.js';
export * from './files.js';
export * from './web.js';
export * from './search.js';
export * from './edit.js';

export const defaultTools: Tool<any>[] = [
  shellTool,
  readFileTool,
  writeFileTool,
  listDirTool,
  grepTool,
  editFileTool,
  webFetchTool,
  webSearchTool,
];

/**
 * Ceiling for any single tool call.
 *
 * Deliberately well above a normal tool's own timeout — the shell tool caps
 * at 300s — so this only fires for a tool that has no timeout of its own, or
 * whose timeout failed to settle it.
 */
export const DEFAULT_TOOL_DEADLINE_MS = 330_000;

export class ToolRegistry {
  private tools = new Map<string, Tool<any>>();

  constructor(tools: Tool<any>[] = defaultTools) {
    for (const t of tools) this.register(t);
  }

  register(tool: Tool<any>): void {
    this.tools.set(tool.definition.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        id: '',
        name,
        ok: false,
        errorCode: 'unknown_tool',
        content: `Unknown tool: ${name}. Available: ${[...this.tools.keys()].join(', ')}`,
      };
    }
    /*
     * Every tool gets a deadline, here rather than in each implementation.
     *
     * The shell tool enforces its own timeout carefully, because it had to:
     * a hung `ssh` left an agent on "Running" with no way back. Nothing
     * protected the others. An MCP server that never answers, a web fetch to
     * a black-hole host, or any future tool could hang a turn exactly the
     * same way, and each would have to remember to guard itself.
     *
     * This is a backstop, not a replacement: a tool that owns its timeout
     * settles first and reports its own reason, which is more informative
     * than a generic deadline. The ceiling only fires when nothing else did.
     *
     * Losing the race does NOT cancel the tool — that needs cooperation the
     * seam does not have. What it guarantees is that the *agent* stops
     * waiting, which is the failure the user actually experiences.
     */
    const budget = ctx.toolDeadlineMs ?? DEFAULT_TOOL_DEADLINE_MS;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeout = new Promise<ToolResult>((resolve) => {
        deadline = setTimeout(() => {
          resolve({
            id: '',
            name,
            ok: false,
            errorCode: 'tool_timeout',
            content:
              `${name} did not finish within ${Math.round(budget / 1000)}s and was abandoned. ` +
              'It may still be running in the background.',
          });
        }, budget);
      });

      return await Promise.race([tool.run(args as never, ctx), timeout]);
    } catch (err) {
      return {
        id: '',
        name,
        ok: false,
        errorCode: 'tool_error',
        content: `${name} threw: ${(err as Error).message}`,
      };
    } finally {
      // Always clear it: a pending timer keeps the event loop alive, which is
      // how a CLI ends up hanging after its work is done.
      if (deadline) clearTimeout(deadline);
    }
  }
}
