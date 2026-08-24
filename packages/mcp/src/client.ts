/**
 * Minimal MCP (Model Context Protocol) stdio client.
 *
 * Speaks the JSON-RPC 2.0 subset used by MCP over a spawned process's
 * stdio (newline-delimited JSON): initialize → notifications/initialized →
 * tools/list → tools/call. Hand-rolled so GhostBot has zero hard
 * dependencies for the common stdio case; SSE/HTTP transport is a future
 * addition.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { Tool, ToolDefinition, ToolContext, ToolResult } from '@ghostbot/shared';

export interface McpServerConfig {
  /** Stable identifier (also used as a tool-name prefix). */
  name: string;
  /** Executable to spawn. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Optional display label for the UI. */
  label?: string;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'McpError';
  }
}

/**
 * Quote one argv element for `cmd.exe`.
 *
 * Windows has no `execvp`: `spawn(..., { shell: true })` joins argv into a
 * single command string, so any element containing whitespace is re-split by
 * the shell. A perfectly ordinary MCP config —
 * `npx -y @modelcontextprotocol/server-filesystem "C:\Users\me\My Projects"`
 * — therefore reaches the server as three separate arguments.
 *
 * We must quote **arguments as well as the command**. Embedded double quotes
 * are escaped by doubling, which is what `cmd.exe` understands; a trailing
 * backslash run is doubled so it cannot escape the closing quote.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"^&|<>()]/.test(arg)) return arg;
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1""') // backslashes before a quote, then double it
    .replace(/(\\+)$/, '$1$1'); // trailing backslashes must not eat the quote
  return `"${escaped}"`;
}

export class McpStdioClient {
  readonly name: string;
  readonly label: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: RpcResponse) => void; timer: NodeJS.Timeout }>();
  private tools: ToolDefinition[] = [];

  constructor(private readonly config: McpServerConfig) {
    this.name = config.name;
    this.label = config.label ?? config.name;
  }

  /** Spawn the server and complete the MCP initialize handshake. */
  async connect(timeoutMs = 10_000): Promise<void> {
    if (this.child) return;
    // Windows needs `shell: true` so that `npx`/`npm` (which are .cmd
    // shims, not executables) can be launched at all. That in turn means the
    // whole argv is re-tokenized by cmd.exe, so every element must be quoted
    // — the command AND its arguments. On POSIX we spawn directly and the
    // argv array is passed through untouched, which needs no quoting.
    const shell = process.platform === 'win32';
    const rawArgs = this.config.args ?? [];
    const command = shell ? quoteWindowsArg(this.config.command) : this.config.command;
    const args = shell ? rawArgs.map(quoteWindowsArg) : rawArgs;
    const child = spawn(command, args, {
      env: { ...process.env, ...(this.config.env ?? {}) },
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell,
    });
    this.child = child;
    this.rl = createInterface({ input: child.stdout });

    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) console.warn(`[mcp:${this.name}] ${text.slice(0, 500)}`);
    });
    child.on('exit', (code) => {
      this.rejectAll(new McpError(`MCP server "${this.name}" exited with code ${code ?? 'null'}`));
      this.child = null;
      this.rl?.close();
      this.rl = null;
    });

    this.rl.on('line', (line) => {
      let msg: RpcResponse;
      try {
        msg = JSON.parse(line) as RpcResponse;
      } catch {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      entry.resolve(msg);
    });

    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'ghostbot', version: '0.1.0' },
    }, timeoutMs);
    void init;
    this.notify('notifications/initialized', {});

    const listRes = await this.request('tools/list', {}, timeoutMs);
    if (listRes.error) {
      throw new McpError(`tools/list failed: ${listRes.error.message}`, listRes.error.code);
    }
    const list = (listRes.result ?? {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    this.tools = (list.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as ToolDefinition['parameters'],
    }));
  }

  toolsList(): ToolDefinition[] {
    return [...this.tools];
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolResult> {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (res.error) {
      return { id: '', name, ok: false, errorCode: 'mcp_error', content: `MCP error: ${res.error.message}` };
    }
    const result = (res.result ?? {}) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
      .join('\n');
    return {
      id: '',
      name,
      ok: !result.isError,
      errorCode: result.isError ? 'mcp_is_error' : undefined,
      content: text || '(no content)',
    };
  }

  async close(): Promise<void> {
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
    this.rejectAll(new McpError('MCP client closed'));
    this.child = null;
    this.rl?.close();
    this.rl = null;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve, reject) => {
      if (!this.child || !this.rl) {
        reject(new McpError(`MCP server "${this.name}" is not connected`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private rejectAll(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
    }
    this.pending.clear();
  }
}

/** Adapt an MCP client's tools to GhostBot Tool implementations. */
export function mcpToolsToTools(client: McpStdioClient, approval: (toolName: string) => boolean | undefined = () => undefined): Tool[] {
  return client.toolsList().map((def) => ({
    definition: {
      ...def,
      name: `${client.name}__${def.name}`,
      description: `[MCP: ${client.label ?? client.name}] ${def.description}`.trim(),
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const approved = approval(def.name);
      if (approved === false) {
        return { id: '', name: def.name, ok: false, errorCode: 'denied', content: 'MCP tool call denied by policy.' };
      }
      if (approved === undefined) {
        const ok = await ctx.requestApproval({
          toolName: def.name,
          summary: `MCP ${client.name}: ${def.name}`,
          detail: JSON.stringify(args).slice(0, 300),
          payload: args,
        });
        if (!ok) return { id: '', name: def.name, ok: false, errorCode: 'denied', content: 'MCP tool call was not approved.' };
      }
      return await client.callTool(def.name, args);
    },
  }));
}
