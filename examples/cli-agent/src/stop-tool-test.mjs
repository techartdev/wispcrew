/**
 * stop-tool-test.mjs — Stop reaches a command that is already running.
 *
 * Reported: an agent sat at "working", Stop had no effect, and the only way
 * out was to wait for a thirty-second timeout or reload the window. The
 * shell call it was stuck in was itself waiting for something that would
 * never arrive.
 *
 * The cause was structural, not a slip. The agent loop checks for an abort
 * BETWEEN tool calls, so the one thing Stop could never reach was the call
 * currently awaiting — which is precisely the case somebody presses Stop
 * for. The signal was on the context; nothing listened.
 *
 * Real processes, no network.
 */
import { shellTool } from '@wispcrew/tools';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const ctx = (signal) => ({
  workspaceRoot: process.cwd(),
  defaultTimeoutMs: 30_000,
  maxToolCallMs: 60_000,
  env: {},
  requestApproval: async () => true,
  signal,
});

/** A command that will not finish on its own within the test's patience. */
const SLEEP =
  process.platform === 'win32'
    ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 30"'
    : 'sleep 30';

console.log('\n[stop] a running command is killed');
{
  const controller = new AbortController();
  const started = Date.now();

  const running = shellTool.run(
    { command: SLEEP, timeoutMs: 30_000 },
    ctx(controller.signal),
  );

  // Long enough for the child to be spawned and settled into waiting.
  await new Promise((r) => setTimeout(r, 1200));
  controller.abort();

  const result = await running;
  const elapsed = Date.now() - started;

  /*
   * The number is the whole point. Before this, the call ran its full
   * thirty seconds regardless: Stop did nothing a person could see.
   */
  check('it returns promptly', elapsed < 10_000, `${elapsed}ms`);
  check('and does not wait for the timeout', elapsed < 25_000, `${elapsed}ms`);

  /*
   * And it SAYS it was stopped. Otherwise the model sees a non-zero exit
   * with a kill signal, reasonably concludes the command was broken, and
   * tries again — the last thing somebody pressing Stop wants.
   */
  check('the result says it was stopped', result.content.includes('[stopped by the user]'),
    result.content.slice(0, 120));
  check('and is not reported as a plain failure',
    !/timed out/.test(result.content), result.content.slice(0, 120));
}

console.log('\n[already stopped] a cancelled call does not start work');
{
  const controller = new AbortController();
  controller.abort();

  const started = Date.now();
  const result = await shellTool.run({ command: SLEEP, timeoutMs: 30_000 }, ctx(controller.signal));
  const elapsed = Date.now() - started;

  check('it returns immediately', elapsed < 5_000, `${elapsed}ms`);
  check('and says so', result.content.includes('[stopped by the user]'),
    result.content.slice(0, 120));
}

console.log('\n[no signal] a tool without one still works');
{
  // Most callers do not pass a signal, and a missing one must not throw.
  const quick = process.platform === 'win32' ? 'cmd /c echo hello' : 'echo hello';
  const result = await shellTool.run({ command: quick }, ctx(undefined));

  check('it runs normally', result.ok, result.content.slice(0, 100));
  check('and reports its output', result.content.includes('hello'));
  check('with no stop marker', !result.content.includes('[stopped by the user]'));
}

console.log('');
if (failures) {
  console.error(`STOP-TOOL TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('STOP-TOOL TEST PASSED\n');
