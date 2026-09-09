/**
 * steer-queue-test.mjs — speaking while the agent works.
 *
 * The desktop blocked this outright, and the reason it had to was worse than
 * the block: sending mid-turn called `Agent.run()` a second time on the same
 * session. Measured with the fake provider below — two concurrent provider
 * streams, a history of `user, user, assistant, assistant`, and
 * `this.abortController` overwritten so Stop reached only the newer turn
 * while the older one ran on uninterruptible.
 *
 * `isRunning()` in agent-sessions was documented as the guard against
 * exactly that, and was dead code called from nowhere.
 *
 * So a mid-turn message is QUEUED and injected at a step boundary, where the
 * history is well-formed: every tool call in the step has its result, and
 * the next request has not been built yet. These are the properties that
 * makes that safe, pinned so they cannot quietly regress.
 */
import { Agent } from '@wispcrew/core';
import { ToolRegistry } from '@wispcrew/tools';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** A provider that asks for one tool, then answers. Tracks concurrency. */
function makeProvider({ toolSteps = 1 } = {}) {
  const state = { active: 0, maxConcurrent: 0, calls: 0, seen: [] };
  return {
    state,
    provider: {
      label: 'fake',
      async *chat(req) {
        state.active++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
        const n = ++state.calls;
        // What the model was shown this call, so injection can be located.
        state.seen.push(req.messages.map((m) => `${m.role}:${String(m.content).slice(0, 30)}`));
        try {
          await new Promise((r) => setTimeout(r, 30));
          if (n <= toolSteps) {
            yield {
              kind: 'done',
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: `t${n}`, name: 'slow', args: {} }],
              },
            };
          } else {
            yield { kind: 'text', text: `answer-${n}` };
            yield { kind: 'done', message: { role: 'assistant', content: `answer-${n}` } };
          }
        } finally {
          state.active--;
        }
      },
    },
  };
}

const tools = new ToolRegistry([
  {
    definition: {
      name: 'slow',
      description: 'takes a moment',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { id: '', name: 'slow', ok: true, content: 'tool done' };
    },
  },
]);

console.log('\n[1] a message sent mid-turn is queued, not a second turn');
{
  const { provider, state } = makeProvider();
  const events = [];
  const agent = new Agent({
    provider,
    tools,
    systemPrompt: 't',
    approvalPolicy: () => true,
    onEvent: (e) => events.push(e),
  });

  const turn = agent.run('do the thing');
  await new Promise((r) => setTimeout(r, 80)); // while the tool runs

  check('the agent reports itself running', agent.isRunning === true);
  check('steer is accepted', agent.steer('actually, do it differently') === true);
  check('and is visible while it waits', agent.queuedSteer.length === 1, JSON.stringify(agent.queuedSteer));

  const reply = await turn;

  check('ONE provider stream at a time', state.maxConcurrent === 1, `max ${state.maxConcurrent}`);
  check('the queue is emptied', agent.queuedSteer.length === 0);
  check('and the turn still answers', /answer-/.test(reply.content), reply.content);

  const applied = events.filter((e) => e.type === 'steer_applied').map((e) => e.text);
  check('it was announced as applied', applied.length === 1 && /differently/.test(applied[0]),
    JSON.stringify(applied));
}

console.log('\n[2] the history stays well-formed: after the tool result, never inside');
{
  const { provider } = makeProvider();
  const agent = new Agent({ provider, tools, systemPrompt: 't', approvalPolicy: () => true });

  const turn = agent.run('first');
  await new Promise((r) => setTimeout(r, 80));
  agent.steer('steered');
  await turn;

  const roles = agent.history.map((m) => m.role);
  const iTool = roles.indexOf('tool');
  const iSteer = agent.history.findIndex((m) => m.content === 'steered');

  check('a tool result exists', iTool !== -1, roles.join(','));
  check('the steer lands after it', iSteer > iTool, `tool@${iTool} steer@${iSteer} — ${roles.join(',')}`);

  /*
   * The shape that broke providers: two user messages in a row, from two
   * loops pushing onto one history.
   */
  const doubled = roles.some((r, i) => r === 'user' && roles[i + 1] === 'user');
  check('no two user messages in a row', !doubled, roles.join(','));

  // Every assistant tool call must have a matching tool result.
  const calls = agent.history.filter((m) => m.toolCalls?.length).flatMap((m) => m.toolCalls);
  const results = agent.history.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
  check('every tool call was answered',
    calls.every((c) => results.includes(c.id)), `${calls.length} calls, ${results.length} results`);
}

console.log('\n[3] a queue that arrives after the answer still gets through');
{
  /*
   * The model finishes with no tool call, so there is no step boundary left
   * to inject at. This used to strand the message: it sat in the composer
   * with no turn to join, and the next thing typed went in ahead of it.
   */
  const { provider, state } = makeProvider({ toolSteps: 0 });
  const events = [];
  const agent = new Agent({
    provider,
    tools,
    systemPrompt: 't',
    approvalPolicy: () => true,
    onEvent: (e) => events.push(e),
  });

  // Queued before the turn's single model call resolves.
  const turn = agent.run('answer directly');
  agent.steer('one more thing');
  await turn;

  const applied = events.filter((e) => e.type === 'steer_applied');
  check('the late message was applied, not dropped', applied.length === 1, JSON.stringify(applied));
  check('which cost another model call', state.calls === 2, `${state.calls} calls`);
  check('and the queue is empty', agent.queuedSteer.length === 0);
}

console.log('\n[4] the queue is the user\u2019s until the model reads it');
{
  const { provider } = makeProvider();
  const agent = new Agent({ provider, tools, systemPrompt: 't', approvalPolicy: () => true });

  const turn = agent.run('go');
  await new Promise((r) => setTimeout(r, 80));

  agent.steer('first draft');
  agent.steer('second');
  check('both are held', agent.queuedSteer.length === 2);

  agent.setQueuedSteer(['edited before sending']);
  check('editing replaces them', agent.queuedSteer.length === 1 && agent.queuedSteer[0] === 'edited before sending',
    JSON.stringify(agent.queuedSteer));

  agent.setQueuedSteer([]);
  check('and it can be emptied', agent.queuedSteer.length === 0);

  await turn;
  check('nothing was injected after clearing',
    !agent.history.some((m) => /edited before sending|first draft/.test(String(m.content))));
}

console.log('\n[5] with no turn running there is nothing to steer');
{
  const { provider } = makeProvider();
  const agent = new Agent({ provider, tools, systemPrompt: 't' });

  check('idle agents refuse', agent.steer('hello') === false);
  check('so the caller sends it normally', agent.queuedSteer.length === 0);
  check('and blank text is never queued', agent.steer('   ') === false);
}

console.log('');
if (failures) {
  console.error(`STEER-QUEUE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('STEER-QUEUE TEST PASSED\n');
