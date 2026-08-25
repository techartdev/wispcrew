/**
 * Multi-turn memory + interrupt regression test (offline, no API key).
 *
 * Covers the two guarantees the desktop app depends on but that a live
 * provider call cannot check deterministically:
 *
 *   1. A reused Agent accumulates history across turns, so turn N sees every
 *      earlier user/assistant message (the model actually remembers).
 *   2. An interrupted turn leaves history in a VALID state: every assistant
 *      tool call must have a matching `role:"tool"` message. OpenAI and
 *      Anthropic reject a conversation with an unanswered tool call, so a
 *      Stop press must not permanently break the chat.
 *
 * Run: npm run test:memory --workspace @wispcrew/examples-cli
 */
import { Agent } from '@wispcrew/core';
import type { ChatMessage, ChatProvider, ChatRequest, ProviderChunk } from '@wispcrew/shared';

/** Provider that replays a scripted sequence and records what it was sent. */
class ScriptedProvider implements ChatProvider {
  readonly kind = 'openai-compatible' as const;
  readonly label = 'scripted';
  /** Snapshot of `messages` for every call, so we can assert on history. */
  readonly seen: ChatMessage[][] = [];
  private turn = 0;

  constructor(private readonly script: ProviderChunk[][]) {}

  validate() {
    return { ok: true as const };
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderChunk> {
    this.seen.push(request.messages.map((m) => ({ ...m })));
    const chunks = this.script[Math.min(this.turn, this.script.length - 1)] ?? [];
    this.turn++;
    for (const c of chunks) yield c;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

/** 1. History accumulates across turns on a reused Agent. */
async function testMultiTurnMemory(): Promise<void> {
  const provider = new ScriptedProvider([
    [{ kind: 'done', message: { role: 'assistant', content: 'Nice to meet you, Vanyo.' } }],
    [{ kind: 'done', message: { role: 'assistant', content: 'Your name is Vanyo.' } }],
    [{ kind: 'done', message: { role: 'assistant', content: 'Still Vanyo.' } }],
  ]);
  const agent = new Agent({ provider, workspaceRoot: process.cwd() });

  await agent.run('Hi, my name is Vanyo.');
  await agent.run('What is my name?');
  await agent.run('Are you sure?');

  // The 2nd call must have been shown turn 1's user + assistant messages.
  const second = provider.seen[1]!;
  assert(second.length === 3, `turn 2 should see 3 prior messages, saw ${second.length}`);
  assert(second[0]!.content.includes('Vanyo'), 'turn 2 lost the first user message');
  assert(second[1]!.role === 'assistant', 'turn 2 lost the first assistant reply');

  // The 3rd call must see everything from turns 1 and 2.
  const third = provider.seen[2]!;
  assert(third.length === 5, `turn 3 should see 5 prior messages, saw ${third.length}`);

  console.log(`[memory] turn2 saw ${second.length} msgs, turn3 saw ${third.length} msgs`);
  console.log('[memory] multi-turn history OK');
}

/** 2. An interrupted tool turn leaves a provider-valid history. */
async function testInterruptLeavesValidHistory(): Promise<void> {
  // The model asks for two tool calls; we abort before they run.
  const provider = new ScriptedProvider([
    [
      {
        kind: 'done',
        message: {
          role: 'assistant',
          content: 'Working on it.',
          toolCalls: [
            { id: 'call_a', name: 'list_dir', args: { path: '.' } },
            { id: 'call_b', name: 'list_dir', args: { path: '.' } },
          ],
        },
      },
    ],
    [{ kind: 'done', message: { role: 'assistant', content: 'Resumed fine.' } }],
  ]);

  const agent = new Agent({
    provider,
    workspaceRoot: process.cwd(),
    // Abort as soon as the first tool asks for approval — simulates the user
    // hitting Stop mid-turn.
    onApprovalRequired: async () => {
      agent.abort();
      return false;
    },
  });

  await agent.run('List the directory twice.');

  // Every assistant tool call must have a matching tool result in history.
  const calls = agent.history
    .filter((m) => m.role === 'assistant' && m.toolCalls?.length)
    .flatMap((m) => m.toolCalls!);
  const answered = new Set(
    agent.history.filter((m) => m.role === 'tool').map((m) => m.toolCallId),
  );
  assert(calls.length > 0, 'expected the aborted turn to have recorded tool calls');
  for (const c of calls) {
    assert(answered.has(c.id), `tool call ${c.id} has no matching tool result — next request would be rejected`);
  }
  console.log(`[interrupt] ${calls.length} tool calls, all ${answered.size} answered`);

  // And the conversation must still be usable afterwards.
  const resumed = await agent.run('Are you still there?');
  assert(resumed.content.includes('Resumed'), `expected a usable follow-up turn, got: ${resumed.content}`);
  console.log('[interrupt] conversation still usable after Stop');
}

async function main(): Promise<void> {
  await testMultiTurnMemory();
  await testInterruptLeavesValidHistory();
  console.log('\nMEMORY + INTERRUPT TEST PASSED');
}

main().catch((err) => {
  console.error('MEMORY + INTERRUPT TEST FAILED:', err);
  process.exit(1);
});
