/**
 * anthropic-tool-results-test.mjs — a step's tool results travel together.
 *
 * Anthropic requires every `tool_use` block to be answered by a
 * `tool_result` in the message IMMEDIATELY after. The agent loop emits one
 * assistant message carrying several tool calls, then one `tool` message per
 * result — and the adapter used to map each of those to its own `user`
 * message:
 *
 *   assistant: tool_use(A), tool_use(B)
 *   user:      tool_result(A)     <- only A is "immediately after"
 *   user:      tool_result(B)
 *
 * The API rejects that outright:
 *
 *   messages.508: `tool_use` ids were found without `tool_result` blocks
 *   immediately after: toolu_013az2KBRDUmRZgGWFvesUFT
 *
 * Reported by a user, and the surfaced message blamed the model or the
 * attachments — neither of which had anything to do with it. Any turn using
 * two or more tools in one step hit this, which is most real work.
 */
import { AnthropicProvider } from '@wispcrew/llm';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Run one request through the real adapter and capture the wire body. */
async function wireFor(messages) {
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    };
  };
  try {
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-test',
      model: 'claude-opus-5',
      baseUrl: 'https://example.invalid',
    });
    for await (const _ of provider.chat({ messages, toolDefs: [], system: 'sys' })) {
      /* drain */
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

/** Anthropic's own rule, applied to a captured body. */
function unanswered(body) {
  const out = [];
  for (let i = 0; i < body.messages.length; i++) {
    const content = body.messages[i].content;
    const uses = (Array.isArray(content) ? content : [])
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id);
    if (!uses.length) continue;
    const next = body.messages[i + 1]?.content;
    const answered = new Set(
      (Array.isArray(next) ? next : [])
        .filter((b) => b.type === 'tool_result')
        .map((b) => b.tool_use_id),
    );
    out.push(...uses.filter((u) => !answered.has(u)));
  }
  return out;
}

console.log('\n[several tools in one step] every result is in the next message');
{
  const body = await wireFor([
    { role: 'user', content: 'do three things' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'toolu_A', name: 'shell', args: {} },
        { id: 'toolu_B', name: 'read_file', args: {} },
        { id: 'toolu_C', name: 'list_dir', args: {} },
      ],
    },
    { role: 'tool', toolCallId: 'toolu_A', content: 'A' },
    { role: 'tool', toolCallId: 'toolu_B', content: 'B' },
    { role: 'tool', toolCallId: 'toolu_C', content: 'C' },
  ]);

  check('nothing is left unanswered', unanswered(body).length === 0, unanswered(body).join(', '));

  const results = body.messages.filter(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
  );
  check('they share ONE user message, not three', results.length === 1, `${results.length} messages`);
  check('carrying all three blocks', results[0]?.content.length === 3,
    JSON.stringify(results[0]?.content.map((b) => b.tool_use_id)));
}

console.log('\n[one tool] the simple case still works');
{
  const body = await wireFor([
    { role: 'user', content: 'one thing' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_X', name: 'shell', args: {} }] },
    { role: 'tool', toolCallId: 'toolu_X', content: 'X' },
  ]);
  check('answered immediately after', unanswered(body).length === 0);
}

console.log('\n[separate steps] results are not merged across a model turn');
{
  /*
   * Two steps, each with its own tool call. Merging these would put step
   * two's result in step one's message and leave step two's `tool_use`
   * unanswered — the same rejection, arrived at from the other direction.
   */
  const body = await wireFor([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'shell', args: {} }] },
    { role: 'tool', toolCallId: 'toolu_1', content: '1' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_2', name: 'shell', args: {} }] },
    { role: 'tool', toolCallId: 'toolu_2', content: '2' },
  ]);

  check('both steps answered', unanswered(body).length === 0, unanswered(body).join(', '));
  const results = body.messages.filter(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
  );
  check('kept as two separate messages', results.length === 2, `${results.length}`);
}

console.log('\n[a user message between] does not get swallowed');
{
  const body = await wireFor([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'shell', args: {} }] },
    { role: 'tool', toolCallId: 'toolu_1', content: '1' },
    { role: 'user', content: 'actually, stop' },
  ]);

  check('the steer survives', body.messages.some(
    (m) => Array.isArray(m.content)
      ? m.content.some((b) => b.type === 'text' && /actually, stop/.test(b.text ?? ''))
      : /actually, stop/.test(String(m.content)),
  ));
  check('and nothing is unanswered', unanswered(body).length === 0);
}

console.log('');
if (failures) {
  console.error(`ANTHROPIC-TOOL-RESULTS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ANTHROPIC-TOOL-RESULTS TEST PASSED\n');
