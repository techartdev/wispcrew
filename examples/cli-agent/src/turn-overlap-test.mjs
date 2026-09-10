/**
 * turn-overlap-test — one agent, one loop, always.
 *
 * ## What went wrong
 *
 * Typing while an agent worked called `runPrompt` a second time, which
 * started a SECOND loop on the same `Agent` object. Both loops share one
 * `history` array and one transcript, and three separate faults follow:
 *
 *  - **Shredded text.** Both loops stream prose into the same conversation,
 *    each holding its own segment id, so sentences interleave at character
 *    granularity. Found on disk: "...the token endpoint sits behCommitted
 *    asind the same infrastructure..." — one message spliced through
 *    another mid-word.
 *
 *  - **Duplicate answers.** Two loops answer one question, neither having
 *    seen the other's reply.
 *
 *  - **"This model does not support assistant message prefill."** Loop A
 *    appends its assistant reply; loop B then builds a request from the same
 *    array and finds it ending in `assistant`. Anthropic reads a trailing
 *    assistant message as a prefill and refuses. The error blames the model
 *    and suggests removing attachments; both are wrong.
 *
 * `agent.ts` predicted all of it — "two loops on one Agent corrupt the
 * history and orphan the abort handle... measured, not theorised" — and
 * `agent-sessions.ts` shipped `setRunning`/`isRunning` as the guard. The
 * engine set the flag faithfully on every turn and never once read it.
 *
 * The fix is not refusal: a message typed mid-turn belongs to the loop that
 * is running. It steers, reaching the same loop at its next step boundary,
 * which is what the user meant by typing while it worked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@wispcrew/core';
import { ToolRegistry } from '@wispcrew/tools';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

/** A provider that answers with prose and records what it was sent. */
function recordingProvider(seen) {
  return {
    validate: () => ({ ok: true }),
    async *chat(request) {
      seen.push(request.messages.map((m) => m.role));
      for (const ch of 'answer') yield { kind: 'text', text: ch };
      /* `done` carries the settled message; the agent reads it for tool calls. */
      yield {
        kind: 'done',
        usage: {},
        message: { role: 'assistant', content: 'answer' },
      };
    },
  };
}

console.log('[1] a second run would corrupt a shared history');
{
  /*
   * The shape Anthropic rejects, demonstrated on the array itself. This is
   * what loop B sees when loop A has already appended its reply and nobody
   * pushed a user message in between.
   */
  const shared = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ];
  check(
    'a history ending in assistant is a prefill request',
    shared[shared.length - 1].role === 'assistant',
    'the provider refuses this, blaming the model',
  );

  const steered = [...shared, { role: 'user', content: 'typed mid-turn' }];
  check(
    'steering leaves it ending in user',
    steered[steered.length - 1].role === 'user',
  );
}

console.log('\n[2] steer reaches the running loop');
{
  const seen = [];
  const applied = [];
  const agent = new Agent({
    provider: recordingProvider(seen),
    tools: new ToolRegistry(),
    systemPrompt: 's',
    maxSteps: 6,
    onEvent: (e) => {
      if (e.type === 'steer_applied') applied.push(e.text);
    },
  });

  const turn = agent.run('first question');
  const accepted = agent.steer('typed while it worked');
  check('the queue accepts it while running', accepted === true);

  await turn;

  check('it reached the model', applied.includes('typed while it worked'), JSON.stringify(applied));
  check('the queue is empty afterwards', agent.queuedSteer.length === 0);
  check('and it took a second model call', seen.length === 2, `${seen.length} call(s)`);

  /*
   * The point of the whole exercise: every request the provider saw ended
   * with a user message. One trailing assistant is the prefill refusal.
   */
  const bad = seen.filter((roles) => roles[roles.length - 1] !== 'user');
  check('every request ended with a user message', bad.length === 0, JSON.stringify(bad));
}

console.log('\n[3] steer refuses when no turn is live');
{
  const agent = new Agent({
    provider: recordingProvider([]),
    tools: new ToolRegistry(),
    systemPrompt: 's',
    maxSteps: 6,
  });

  /*
   * Refusing is correct here and the caller must run normally instead. A
   * queue that silently swallowed a message with no loop to inject it into
   * would lose the user's words entirely.
   */
  check('an idle agent refuses the queue', agent.steer('hello') === false);
  check('and nothing is queued', agent.queuedSteer.length === 0);
}

console.log('\n[4] the engine enforces one loop per agent');
{
  /*
   * Source-checked because reaching this through `runPrompt` needs a store,
   * a provider and a live session — and the failure mode is a missing
   * guard, not a wrong value. That is exactly the shape that shipped: the
   * flag was written on every turn and read nowhere.
   */
  const engine = fs.readFileSync(path.join(root, 'packages/runtime/src/engine.ts'), 'utf8');

  check('runPrompt checks whether a turn is live', /if \(!opts\?\.steerRetry && isRunning\(agentId\)\)/.test(engine));
  check('and steers instead of starting a loop', /const accepted = steerSession\(agentId, rawPrompt\)/.test(engine));
  check('returning without a second run', /if \(accepted\) \{[\s\S]{0,400}?return '';/.test(engine));
  check(
    'a refused steer falls through to a normal run',
    /steer refused, turn already ended/.test(engine),
    'a turn that ended mid-check must still run',
  );
  check('isRunning is imported, not merely written', /\bisRunning,/.test(engine));

  const sessions = fs.readFileSync(
    path.join(root, 'packages/runtime/src/agent-sessions.ts'),
    'utf8',
  );
  check('the session tracks run state', /export function isRunning/.test(sessions));
}

console.log('');
if (failures) {
  console.log(`TURN-OVERLAP TEST FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('TURN-OVERLAP TEST PASSED');
process.exit(0);
