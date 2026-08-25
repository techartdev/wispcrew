/**
 * Provider integration test: runs the full agent stack against a local mock
 * HTTP server that speaks the OpenAI chat.completions wire format (SSE +
 * fragmented tool-call deltas). No API key or network needed.
 * Run: npm run test:provider
 */
import http from 'node:http';
import { createProvider } from '@wispcrew/llm';
import { Agent } from '@wispcrew/core';
import type { ChatProvider } from '@wispcrew/shared';

function sse(chunks: string[]): string {
  return chunks.map((c) => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n';
}

function startMockServer(requests: ((body: unknown) => string[])[]) {
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { stream?: boolean };
      const handler = requests[Math.min(i, requests.length - 1)]!;
      i++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(handler(parsed)));
    });
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

async function main() {
  // Request 1: fragmented tool call for list_dir
  const req1 = (body: unknown): string[] => {
    const b = body as { tools?: unknown[] };
    if (!Array.isArray(b.tools) || b.tools.length === 0) throw new Error('expected tools in request');
    return [
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Let me list"}}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_dir","arguments":"{\\"pa"}}]}}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\".\\"}"}}]}}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    ];
  };
  // Request 2: final answer; verify tool result present
  const req2 = (body: unknown): string[] => {
    const b = body as { messages?: Array<{ role: string; content?: string }> };
    const lastTool = [...(b.messages ?? [])].reverse().find((m) => m.role === 'tool');
    if (!lastTool || !lastTool.content) throw new Error('tool result missing from conversation');
    return [
      JSON.stringify({
        id: 'chatcmpl-2',
        choices: [{ index: 0, delta: { content: `OK. Tool result length: ${lastTool.content.length}` } }],
      }),
    ];
  };

  const mock = await startMockServer([req1, req2]);
  const provider: ChatProvider = createProvider({
    id: 'mock',
    label: 'mock-http',
    kind: 'openai-compatible',
    baseUrl: mock.url,
    apiKey: 'test-key',
    model: 'mock-model',
  });

  const agent = new Agent({
    provider,
    workspaceRoot: process.cwd(),
    onEvent: (e) => {
      if (e.type === 'tool_call_start') console.log(`[event] tool_call_start ${e.call.name}`);
      if (e.type === 'tool_call_result') console.log(`[event] tool_call_result ok=${e.result.ok}`);
    },
  });

  const result = await agent.run('what files are here?');
  console.log('FINAL:', result.content);
  if (!result.content.includes('Tool result length:')) throw new Error(`unexpected final: ${result.content}`);
  const toolMsgs = agent.history.filter((m) => m.role === 'tool');
  if (toolMsgs.length !== 1) throw new Error(`expected 1 tool message, got ${toolMsgs.length}`);
  mock.close();
  console.log('\nPROVIDER INTEGRATION TEST PASSED (real HTTP/SSE wire format)');
}

main().catch((err) => {
  console.error('PROVIDER INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
