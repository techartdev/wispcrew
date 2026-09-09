/**
 * anthropic-cache-test.mjs — Claude re-bills the whole prompt unless we ask it not to.
 *
 * Anthropic's prompt caching is opt-in: a content block is cached only when
 * it carries `cache_control: { type: 'ephemeral' }`. WispCrew sent none, so
 * the agent loop's habit of re-sending the entire conversation every step —
 * a 92k-token history, mostly tool results — was billed at full write price
 * on every single step.
 *
 * The marker goes on the END of the stable prefix (the last system block,
 * the last tool, the last message block), so everything before it becomes a
 * cache read, billed at roughly a tenth of a write.
 *
 * Offline: `fetch` is stubbed to capture the request body; no network.
 */
import { AnthropicProvider, createProvider } from '@wispcrew/llm';

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function isCached(block: unknown): boolean {
  return Boolean(
    block &&
      typeof block === 'object' &&
      (block as { cache_control?: { type?: string } }).cache_control?.type === 'ephemeral',
  );
}

async function captureBody(apiKey: string): Promise<Record<string, unknown>> {
  const realFetch = globalThis.fetch;
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;

  try {
    const provider = new AnthropicProvider({
      model: 'claude-opus-5',
      apiKey,
      baseUrl: 'https://api.anthropic.com',
    });
    for await (const _ of provider.chat({
      system: 'You are a coding agent.',
      messages: [
        { role: 'user', content: 'read the file' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'x' } }] },
        { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: 'file contents' },
      ],
      toolDefs: [
        { name: 'read_file', description: 'read', parameters: { type: 'object' } },
        { name: 'shell', description: 'run', parameters: { type: 'object' } },
      ],
      maxTokens: 100,
      stream: true,
    })) {
      /* drain */
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

async function main(): Promise<void> {
  console.log('\n[subscription] the identity and the prompt are cached');
  {
    const body = await captureBody('sk-ant-oat01-fake');
    const system = body.system as Array<{ text?: string; cache_control?: { type: string } }> | undefined;

    check('the system is an array of blocks', Array.isArray(system));
    check('the identity block is present',
      system?.[0]?.text?.includes('Claude Code') === true);
    check('the AGENT prompt is also present',
      system?.some((b) => b.text?.includes('You are a coding agent.')) === true,
      JSON.stringify(system));
    check('the last system block carries the marker', isCached(system?.[system.length - 1]));
  }

  console.log('\n[api key] the prompt is cached as a single block');
  {
    const body = await captureBody('sk-ant-api03-fake');
    const system = body.system as Array<{ text?: string; cache_control?: { type: string } }> | undefined;
    check('the single system block carries the prompt',
      system?.length === 1 && system[0]?.text?.includes('You are a coding agent.') === true);
    check('and is cached', isCached(system?.[0]));
  }

  console.log('\n[the system prompt] reaches every adapter, not just the subscriptions');
  {
    // The same prompt dropped for openai-compatible and anthropic: they read
    // `request.messages` for a `system` role the agent loop never emits, while
    // only the ChatGPT/Responses backends read `request.system`. Reported as
    // "Claude did not know it could tag, GPT did" — the same prompt, one
    // adapter dropping it. This is the assertion that stops a future adapter
    // from repeating it.
    const realFetch = globalThis.fetch;
    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const provider = createProvider({
        id: 'nvidia', kind: 'openai-compatible', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'k', model: 'nvidia/x',
      });
      for await (const _ of provider.chat({ system: 'You are a coding agent.', messages: [{ role: 'user', content: 'hi' }], stream: false })) { /* drain */ }
    } finally {
      globalThis.fetch = realFetch;
    }
    const first = (captured.messages as Array<{ role?: string; content?: string }>)?.[0];
    check('openai-compatible sends it as the first system message',
      first?.role === 'system' && first?.content?.includes('You are a coding agent.') === true,
      JSON.stringify(first));
  }

  console.log('\n[tools] the schema is cached');
  {
    const body = await captureBody('sk-ant-api03-fake');
    const tools = body.tools as Array<{ cache_control?: { type: string } }> | undefined;
    check('the last tool carries the marker', isCached(tools?.[tools.length - 1]));
  }

  console.log('\n[messages] the end of the stable prefix is marked');
  {
    const body = await captureBody('sk-ant-api03-fake');
    const messages = body.messages as Array<{ content: Array<{ cache_control?: { type: string } }> }>;
    const last = messages[messages.length - 1];
    const lastBlock = last.content[last.content.length - 1];
    check('the last message block carries the marker', isCached(lastBlock));
  }

  console.log('');
  if (failures > 0) {
    console.error(`ANTHROPIC-CACHE TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('ANTHROPIC-CACHE TEST PASSED\n');
}

main().catch((err) => {
  console.error('ANTHROPIC-CACHE TEST FAILED:', err);
  process.exit(1);
});
