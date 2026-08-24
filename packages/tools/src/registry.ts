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
    try {
      return await tool.run(args as never, ctx);
    } catch (err) {
      return {
        id: '',
        name,
        ok: false,
        errorCode: 'tool_error',
        content: `${name} threw: ${(err as Error).message}`,
      };
    }
  }
}
