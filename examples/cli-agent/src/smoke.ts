/**
 * Smoke test for the GhostBot core loop with a mock provider
 * (no network needed). Run: npm run smoke
 */
import { Agent } from '@ghostbot/core';
import type { ChatProvider, ChatRequest, ProviderChunk } from '@ghostbot/shared';

class MockProvider implements ChatProvider {
  readonly kind = 'openai-compatible' as const;
  readonly label = 'mock';
  private calls = 0;

  validate() {
    return { ok: true as const };
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderChunk> {
    this.calls++;
    if (this.calls === 1) {
      // first call: request a tool call
      yield {
        kind: 'done',
        message: {
          role: 'assistant',
          content: 'I will list the workspace.',
          toolCalls: [{ id: 'c1', name: 'list_dir', args: { path: '.' } }],
        },
      };
      return;
    }
    // second call: final answer (verify tool result came back)
    const lastTool = request.messages.filter((m) => m.role === 'tool').at(-1);
    const sawResult = (lastTool?.content?.length ?? 0) > 0;
    yield { kind: 'text', text: 'Saw tool result: ' + (sawResult ? 'yes' : 'no') };
    yield { kind: 'done', message: { role: 'assistant', content: 'Saw tool result: ' + (sawResult ? 'yes' : 'no') } };
  }
}

async function main() {
  const agent = new Agent({
    provider: new MockProvider(),
    workspaceRoot: process.cwd(),
    onEvent: (e) => {
      if (e.type === 'tool_call_start') console.log(`[event] tool_call_start ${e.call.name}`);
      if (e.type === 'tool_call_result') console.log(`[event] tool_call_result ok=${e.result.ok} len=${e.result.content.length}`);
    },
  });

  const result = await agent.run('what is in the workspace?');
  console.log('FINAL:', result.content);
  const toolMsgs = agent.history.filter((m) => m.role === 'tool');
  if (toolMsgs.length !== 1) throw new Error(`expected 1 tool message, got ${toolMsgs.length}`);
  if (!result.content.includes('Saw tool result: yes')) throw new Error(`final answer unexpected: ${result.content}`);
  console.log('\nSMOKE TEST PASSED');
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
