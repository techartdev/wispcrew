/**
 * Tool registry — maps tool names to implementations.
 */
import type { Tool, ToolDefinition, ToolContext, ToolResult } from '@wispcrew/shared';
import { shellTool } from './shell.js';
import { readFileTool, writeFileTool, listDirTool } from './files.js';
import { webFetchTool, webSearchTool } from './web.js';
import { notifyTool } from './notify.js';
import { proposeRoutineTool, scheduleFollowUpTool } from './schedule.js';
import { grepTool } from './search.js';
import { editFileTool } from './edit.js';

export * from './shell.js';
export * from './files.js';
export * from './web.js';
export * from './search.js';
export * from './edit.js';
export * from './room.js';

export const defaultTools: Tool<any>[] = [
  notifyTool,
  scheduleFollowUpTool,
  proposeRoutineTool,
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

/** The `required` names a call did not supply. */
function missingRequired(def: ToolDefinition, args: Record<string, unknown>): string[] {
  const schema = def.parameters as
    | { required?: unknown; properties?: Record<string, unknown> }
    | undefined;

  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  const supplied = args ?? {};

  return required.filter((key) => supplied[key] === undefined);
}

/** "`path` (string)" — enough for a model to fix the call without guessing. */
function describeRequired(def: ToolDefinition): string {
  const schema = def.parameters as
    | { required?: unknown; properties?: Record<string, { type?: string }> }
    | undefined;

  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  if (!required.length) return 'no arguments';

  return required
    .map((key) => {
      const type = schema?.properties?.[key]?.type;
      return type ? `\`${key}\` (${type})` : `\`${key}\``;
    })
    .join(', ');
}

/**
 * A concrete call, because a shape is easier to copy than a description.
 *
 * The model that hit this had emitted `{}` a dozen times; an abstract
 * explanation of the schema is exactly what it had already failed to act on.
 */
function exampleCall(def: ToolDefinition): string {
  const schema = def.parameters as
    | { required?: unknown; properties?: Record<string, { type?: string }> }
    | undefined;

  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];

  const sample = Object.fromEntries(
    required.map((key) => {
      const type = schema?.properties?.[key]?.type;
      return [key, type === 'number' ? 1 : type === 'boolean' ? true : '…'];
    }),
  );

  return JSON.stringify(sample);
}

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
     * Say plainly when a required argument is missing.
     *
     * Without this the tool ran anyway and failed somewhere inside itself,
     * so the model was told `The "paths[1]" argument must be of type
     * string. Received undefined` — Node's internals, naming nothing the
     * model can act on. It could not tell that its ARGUMENTS had not
     * arrived, so it retried the identical call and failed identically.
     *
     * That mattered far more than it looks. Every failed call stays in the
     * transcript, and the next turn sees a run of its own empty calls and
     * copies the pattern: measured on a real conversation, a fresh agent on
     * the same model, build and daemon called the same tool correctly while
     * the poisoned one kept sending `{}` even after the underlying
     * serialisation bug was fixed. A confusing error does not just fail a
     * call — it teaches the model to keep failing.
     *
     * Checked here rather than in each tool because it is the one place
     * that has both the arguments and the schema.
     */
    const missing = missingRequired(tool.definition, args);
    if (missing.length) {
      return {
        id: '',
        name,
        ok: false,
        errorCode: 'bad_arguments',
        content:
          `${name} was called without ${missing.map((m) => `\`${m}\``).join(', ')}. ` +
          `It requires ${describeRequired(tool.definition)}. ` +
          'Send the arguments as a JSON object, for example ' +
          `${exampleCall(tool.definition)}.`,
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
