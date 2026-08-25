/**
 * MCP integration test: connects to a real spawned stdio MCP server,
 * adapts its tools, and runs a full agent turn where the model calls the
 * MCP tool and receives the result.
 * Run: npm run test:mcp
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { McpStdioClient, mcpToolsToTools, quoteWindowsArg } from '@wispcrew/mcp';
import { Agent } from '@wispcrew/core';
import { ToolRegistry } from '@wispcrew/tools';
import type { ChatProvider, ChatRequest, ProviderChunk, ToolResult } from '@wispcrew/shared';

const fixturePath = fileURLToPath(new URL('./mcp-server-fixture.mjs', import.meta.url));

class McpMockProvider implements ChatProvider {
  readonly kind = 'openai-compatible' as const;
  readonly label = 'mock-mcp';
  private calls = 0;

  validate() {
    return { ok: true as const };
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderChunk> {
    this.calls++;
    if (this.calls === 1) {
      yield {
        kind: 'done',
        message: {
          role: 'assistant',
          content: 'I will compute 20 + 22 via MCP.',
          toolCalls: [{ id: 'm1', name: 'fixture__add', args: { a: 20, b: 22 } }],
        },
      };
      return;
    }
    const lastTool = request.messages.filter((m) => m.role === 'tool').at(-1);
    const content = lastTool?.content ?? '';
    yield {
      kind: 'done',
      message: {
        role: 'assistant',
        content: content.includes('42') ? 'MCP result 42 confirmed.' : `unexpected tool content: ${content}`,
      },
    };
  }
}

async function main() {
  const client = new McpStdioClient({
    name: 'fixture',
    label: 'Fixture MCP Server',
    command: process.execPath,
    args: [fixturePath],
  });
  await client.connect();
  console.log(`[mcp] connected, tools: ${client.toolsList().map((t) => t.name).join(', ')}`);

  // direct call
  const direct = await client.callTool('add', { a: 2, b: 3 });
  console.log('[mcp] direct add(2,3):', direct.content);

  // agent roundtrip
  const registry = new ToolRegistry([]);
  for (const t of mcpToolsToTools(client, () => true)) registry.register(t);
  console.log('[mcp] registry tools:', registry.definitions().map((d) => d.name).join(', '));

  const agent = new Agent({
    provider: new McpMockProvider(),
    tools: registry,
    workspaceRoot: process.cwd(),
    onEvent: (e) => {
      if (e.type === 'tool_call_start') console.log(`[event] tool_call_start ${e.call.name}`);
      if (e.type === 'tool_call_result') console.log(`[event] tool_call_result ok=${e.result.ok} content=${e.result.content}`);
    },
  });

  const result = await agent.run('add 20 and 22');
  console.log('FINAL:', result.content);
  await client.close();

  if (!result.content.includes('42')) throw new Error(`unexpected final: ${result.content}`);
  const toolMsgs = agent.history.filter((m) => m.role === 'tool');
  if (toolMsgs.length !== 1) throw new Error(`expected 1 tool message, got ${toolMsgs.length}`);

  await testArgQuoting();
  await testSpacedPathSpawn();

  console.log('\nMCP INTEGRATION TEST PASSED');
}

/**
 * Unit-check the Windows argv quoter.
 *
 * On Windows an MCP server must be spawned through the shell (npx/npm are
 * .cmd shims), which re-tokenizes the command line. Arguments containing
 * spaces — a filesystem server rooted at "C:\Users\me\My Projects" is the
 * canonical case — were previously split into several arguments.
 */
async function testArgQuoting(): Promise<void> {
  const cases: Array<[string, string]> = [
    ['plain', 'plain'],
    ['-y', '-y'],
    ['with space', '"with space"'],
    ['C:\\Program Files\\x', '"C:\\Program Files\\x"'],
    ['a&b', '"a&b"'],
    ['has"quote', '"has""quote"'],
  ];
  for (const [input, expected] of cases) {
    const actual = quoteWindowsArg(input);
    if (actual !== expected) {
      throw new Error(`quoteWindowsArg(${JSON.stringify(input)}) = ${actual}, expected ${expected}`);
    }
  }
  console.log(`[mcp] arg quoting: ${cases.length} cases OK`);
}

/**
 * End-to-end guard: spawn a real MCP server from a directory whose path
 * contains a space, and confirm the handshake and a tool call still work.
 * This is the actual failure users hit, so it is worth the real spawn.
 */
async function testSpacedPathSpawn(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb mcp '));
  try {
    const target = path.join(dir, 'server fixture.mjs');
    fs.copyFileSync(fixturePath, target);

    const client = new McpStdioClient({
      name: 'spaced',
      command: process.execPath, // may itself live under "Program Files"
      args: [target],
    });
    await client.connect();
    const res = await client.callTool('add', { a: 40, b: 2 });
    await client.close();

    if (!res.content.includes('42')) {
      throw new Error(`spaced-path MCP call returned: ${res.content}`);
    }
    console.log(`[mcp] spawned from a path with spaces OK (${path.basename(dir)})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('MCP INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
