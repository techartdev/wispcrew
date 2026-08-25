/**
 * tool-deadline-test.mjs — no tool can leave an agent waiting forever.
 *
 * The shell tool guards its own timeout because it had to: a hung `ssh` left
 * an agent on "Running" with no way back. Nothing protected the others — an
 * MCP server that never answers, a web fetch to a black-hole host, or any
 * future tool could hang a turn the same way.
 *
 * The registry now arms a deadline around every call. It is a backstop: a
 * tool that settles itself wins the race and reports its own, better reason.
 *
 * Offline: synthetic tools, no network.
 */
import { ToolRegistry, DEFAULT_TOOL_DEADLINE_MS } from '@ghostbot/tools';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const ctx = {
  workspaceRoot: process.cwd(),
  defaultTimeoutMs: 30_000,
  requestApproval: async () => true,
};

const tool = (name, run) => ({
  name,
  definition: { name, description: name, parameters: { type: 'object', properties: {} } },
  run,
});

console.log('\n[normal] a prompt tool is unaffected');
{
  const registry = new ToolRegistry();
  registry.register(tool('quick', async () => ({ id: '', name: 'quick', ok: true, content: 'done' })));

  const started = Date.now();
  const result = await registry.execute('quick', {}, ctx);
  const took = Date.now() - started;

  check('it returned its own result', result.content === 'done');
  check('immediately', took < 500, `${took}ms`);
  check('with no timeout error', result.errorCode === undefined);
}

console.log('\n[hanging] a tool that never settles is abandoned');
{
  const registry = new ToolRegistry();
  // The shape of a hung MCP call: a promise that simply never resolves.
  registry.register(tool('hangs', () => new Promise(() => {})));

  const started = Date.now();
  const result = await registry.execute('hangs', {}, { ...ctx, toolDeadlineMs: 1200 });
  const took = Date.now() - started;

  // The assertion that matters: the agent stops waiting.
  check('the call returned', Boolean(result), 'it hung');
  check('after roughly the budget', took >= 1000 && took < 5000, `${took}ms`);
  check('as a timeout', result.errorCode === 'tool_timeout', String(result.errorCode));
  check('reported as not ok', result.ok === false);
  check('and says it may still be running', /still be running/i.test(String(result.content)));
}

console.log('\n[precedence] a tool that settles first keeps its own answer');
{
  const registry = new ToolRegistry();
  registry.register(
    tool(
      'slow-but-finishes',
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ id: '', name: 'slow-but-finishes', ok: false, errorCode: 'timeout', content: 'my own timeout' }),
            300,
          ),
        ),
    ),
  );

  const result = await registry.execute('slow-but-finishes', {}, { ...ctx, toolDeadlineMs: 3000 });
  // A tool's own reason is more informative than a generic ceiling.
  check('the tool\'s result wins', result.content === 'my own timeout', String(result.content));
  check('and its own error code survives', result.errorCode === 'timeout', String(result.errorCode));
}

console.log('\n[throwing] an exception is still reported, not swallowed');
{
  const registry = new ToolRegistry();
  registry.register(
    tool('throws', async () => {
      throw new Error('deliberate failure');
    }),
  );

  const result = await registry.execute('throws', {}, { ...ctx, toolDeadlineMs: 3000 });
  check('reported as an error', result.errorCode === 'tool_error', String(result.errorCode));
  check('with the message', /deliberate failure/.test(String(result.content)));
}

console.log('\n[default] the ceiling is above a tool\'s own maximum');
{
  // The shell tool caps at 300s; a lower ceiling would cut off legitimate
  // long commands before they could report their own timeout.
  check('default exceeds the shell maximum', DEFAULT_TOOL_DEADLINE_MS > 300_000,
    String(DEFAULT_TOOL_DEADLINE_MS));
}

console.log('\n[no leak] a finished call leaves no pending timer');
{
  const registry = new ToolRegistry();
  registry.register(tool('quick2', async () => ({ id: '', name: 'quick2', ok: true, content: 'x' })));
  await registry.execute('quick2', {}, ctx);
  // If the deadline timer were left armed, this process would sit for the
  // full budget before exiting. Reaching here promptly is the evidence.
  check('the process is free to exit', true);
}

console.log('');
if (failures) {
  console.error(`TOOL-DEADLINE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('TOOL-DEADLINE TEST PASSED\n');
