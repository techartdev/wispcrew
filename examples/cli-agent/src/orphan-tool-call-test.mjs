/*
 * orphan-tool-call-test.mjs — a conversation must never become unsendable.
 *
 * The failure this pins was reported by a user four times in one session,
 * and it is the worst shape a bug can have: permanent, self-inflicted, and
 * unrecoverable from the UI. Anthropic rejects a request where an assistant
 * `tool_use` block is not answered in the very next message:
 *
 *   messages.232: `tool_use` ids were found without `tool_result` blocks
 *   immediately after: toolu_01LX…
 *
 * Once such a pair is in history, EVERY later message fails the same way.
 * Restarting does not help. Compacting did not help. The error names an
 * opaque id and blames the model, so the user's reasonable conclusion was
 * that the agent was broken beyond use.
 *
 * A turn can end between a tool call and its result in many ways: the user
 * pressed Stop, the step budget ran out, a tool threw, the provider dropped
 * mid-stream, a queued steer arrived at the wrong moment. Settling at each
 * of those sites is what the code used to do, and the list kept growing.
 *
 * So the guarantee is enforced at the choke point instead: nothing becomes a
 * request without passing the check. That is what this test drives — not the
 * repair function in isolation, but a real Agent whose history was poisoned,
 * asserting that what reaches the provider is valid.
 */
import { Agent } from '@wispcrew/core';
import { ToolRegistry } from '@wispcrew/tools';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
};

/** Every assistant tool call answered by results in the NEXT message. */
function unanswered(messages) {
  const bad = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const answered = new Set();
    for (let j = i + 1; j < messages.length; j++) {
      const n = messages[j];
      if (!n || n.role !== 'tool') break;
      if (n.toolCallId) answered.add(n.toolCallId);
    }
    for (const c of m.toolCalls) if (!answered.has(c.id)) bad.push(c.id);
  }
  return bad;
}

/** A provider that records what it was sent and then just answers. */
function recorder() {
  const seen = [];
  return {
    seen,
    async *chat(req) {
      seen.push(req.messages.map((m) => ({ ...m })));
      yield { kind: 'text', text: 'ok' };
      yield { kind: 'done', message: { role: 'assistant', content: 'ok' } };
    },
  };
}

console.log('\n[1] a poisoned history is repaired before it is ever sent');
{
  const provider = recorder();
  const agent = new Agent({ provider, tools: new ToolRegistry(), systemPrompt: 's' });

  /*
   * Exactly the shape the user hit: an assistant turn that called two tools,
   * one answered, one not, and then the conversation carried on. This is
   * what an interrupted parallel step leaves behind.
   */
  agent.setHistory([
    { role: 'user', content: 'do the thing' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'toolu_A', name: 'shell', args: { command: 'echo a' } },
        { id: 'toolu_B', name: 'shell', args: { command: 'echo b' } },
      ],
    },
    { role: 'tool', toolCallId: 'toolu_A', toolName: 'shell', content: 'a' },
    { role: 'assistant', content: 'I did some of it.' },
  ]);

  check('the seeded history is genuinely invalid', unanswered(agent.history).includes('toolu_B'));

  await agent.run('and now this');

  const sent = provider.seen[0];
  check('a request was made', Array.isArray(sent), String(provider.seen.length));
  check('what reached the provider is valid', unanswered(sent).length === 0, unanswered(sent).join(', '));

  const filler = sent.find((m) => m.role === 'tool' && m.toolCallId === 'toolu_B');
  check('the missing result was synthesised', !!filler);
  check(
    'and it says the call did not run',
    !!filler && /not having run|did not|ended before/i.test(filler.content),
    filler?.content,
  );
  check(
    'it sits immediately after the call that lacked it',
    sent.findIndex((m) => m.toolCallId === 'toolu_B') ===
      sent.findIndex((m) => m.toolCallId === 'toolu_A') + 1,
  );
}

console.log('\n[2] a healthy history is left exactly alone');
{
  const provider = recorder();
  const agent = new Agent({ provider, tools: new ToolRegistry(), systemPrompt: 's' });

  const clean = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_C', name: 'shell', args: {} }] },
    { role: 'tool', toolCallId: 'toolu_C', toolName: 'shell', content: 'done' },
    { role: 'assistant', content: 'finished' },
  ];
  agent.setHistory(clean);
  await agent.run('again');

  const sent = provider.seen[0];
  const tools = sent.filter((m) => m.role === 'tool');
  check('no phantom results were added', tools.length === 1, `${tools.length} tool messages`);
  check('still valid', unanswered(sent).length === 0);
}

console.log('\n[3] a result whose call is gone is REMOVED, not kept');
{
  /*
   * The mirror failure, reported by the same user an hour after the first:
   *
   *   messages.490.content.2: unexpected `tool_use_id` found in
   *   `tool_result` blocks: toolu_016s... Each `tool_result` block must
   *   have a corresponding `tool_use` block in the previous message.
   *
   * Filling holes is only half the invariant. A `role:"tool"` message whose
   * assistant call has been lost -- to a rewind that cut between the two, or
   * a history rebuilt from a transcript missing the call entry -- cannot be
   * repaired by adding anything. It has to go.
   */
  const provider = recorder();
  const agent = new Agent({ provider, tools: new ToolRegistry(), systemPrompt: 's' });

  agent.setHistory([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'thinking' },
    { role: 'tool', toolCallId: 'toolu_STRAY', toolName: 'shell', content: 'orphaned output' },
    { role: 'assistant', content: 'done' },
  ]);

  await agent.run('next');
  const sent = provider.seen[0];

  check(
    'the stray result is gone',
    !sent.some((m) => m.role === 'tool' && m.toolCallId === 'toolu_STRAY'),
    JSON.stringify(sent.filter((m) => m.role === 'tool')),
  );
  check('and nothing else was invented', sent.filter((m) => m.role === 'tool').length === 0);
  check('the conversation is still valid', unanswered(sent).length === 0);
}

console.log('\n[4] a mixed step keeps what is real and mends what is not');
{
  const provider = recorder();
  const agent = new Agent({ provider, tools: new ToolRegistry(), systemPrompt: 's' });

  /*
   * One answered call, one unanswered call, and a result belonging to
   * neither -- all in the same step. Each needs a different repair, which is
   * why they are tested together rather than one at a time.
   */
  agent.setHistory([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'A', name: 'shell', args: {} },
        { id: 'B', name: 'shell', args: {} },
      ],
    },
    { role: 'tool', toolCallId: 'A', toolName: 'shell', content: 'a ran' },
    { role: 'tool', toolCallId: 'GHOST', toolName: 'shell', content: 'belongs to nobody' },
    { role: 'assistant', content: 'partial' },
  ]);

  await agent.run('next');
  const sent = provider.seen[0];
  const ids = sent.filter((m) => m.role === 'tool').map((m) => m.toolCallId);

  check('exactly the two real calls are answered', ids.join(',') === 'A,B', ids.join(','));
  check('the real result was preserved', sent.some((m) => m.toolCallId === 'A' && /a ran/.test(m.content)));
  check('the ghost is gone', !ids.includes('GHOST'));
  check('valid overall', unanswered(sent).length === 0);
}

console.log('');
if (failures) {
  console.error(`ORPHAN-TOOL-CALL TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ORPHAN-TOOL-CALL TEST PASSED\n');
