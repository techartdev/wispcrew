/**
 * shell-timeout-test.mjs — a shell command always returns.
 *
 * Reported: an `ssh` to an unreachable host sat on "Running" forever and the
 * agent could not be recovered.
 *
 * Cause: the tool resolved on `close`, which fires when every stdio pipe is
 * closed — a different event from the process ending. Measured on Windows,
 * killing even a plain `ping` emitted `exit` with no `close` at all, so any
 * timed-out command hung the agent permanently.
 *
 * Offline: local processes only, no network.
 */
import { shellTool } from '@ghostbot/tools';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const shell = shellTool;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-shtimeout-'));
const ctx = {
  workspaceRoot: dir,
  defaultTimeoutMs: 30_000,
  // Auto-approve: this suite is about whether a command *returns*, not about
  // the approval gate, which grants-test already covers.
  requestApproval: async () => true,
};
const isWin = process.platform === 'win32';

/** Never let a hang become a hung test: that is the bug under examination. */
const withDeadline = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ __hung: true, label }), ms)),
  ]);

console.log('\n[normal] a quick command still works');
{
  const result = await withDeadline(
    shell.run({ command: isWin ? 'echo hello' : 'echo hello' }, ctx),
    10_000,
    'echo',
  );
  check('it returned', !result.__hung);
  check('with its output', String(result.content ?? '').includes('hello'));
  check('and reported success', result.ok === true);
}

console.log('\n[timeout] a slow command is cut off and RETURNS');
{
  const started = Date.now();
  const result = await withDeadline(
    shell.run(
      { command: isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30', timeoutMs: 1500 },
      ctx,
    ),
    15_000,
    'sleeper',
  );
  const took = Date.now() - started;

  // This is the assertion that was failing in the wild.
  check('the tool call returned at all', !result.__hung, 'still hung');
  check('promptly after the timeout', took < 8000, `${took}ms`);
  check('marked as a timeout', result.errorCode === 'timeout', String(result.errorCode));
  check('and reported as not ok', result.ok === false);
  check('the message says so', /timed out/i.test(String(result.content ?? '')));
}

console.log('\n[descendants] a command whose child holds the pipes still returns');
{
  // The shape of `ssh` waiting on a host: the shell exits, a grandchild
  // keeps the inherited stdio open, and `close` never fires.
  const nested = isWin
    ? 'start /b ping -n 40 127.0.0.1 & ping -n 40 127.0.0.1'
    : 'sleep 40 & sleep 40';

  const started = Date.now();
  const result = await withDeadline(
    shell.run({ command: nested, timeoutMs: 1500 }, ctx),
    15_000,
    'nested',
  );
  const took = Date.now() - started;

  check('it returned despite the open pipes', !result.__hung, 'still hung');
  check('promptly', took < 8000, `${took}ms`);
  check('as a timeout', result.errorCode === 'timeout', String(result.errorCode));
}

console.log('\n[failure] a failing command reports its code, not a hang');
{
  const result = await withDeadline(
    shell.run({ command: isWin ? 'exit 3' : 'exit 3' }, ctx),
    10_000,
    'exit3',
  );
  check('it returned', !result.__hung);
  check('with a non-zero code', result.data?.exitCode === 3, String(result.data?.exitCode));
  check('and did not claim a timeout', result.errorCode === 'exit_nonzero');
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`SHELL-TIMEOUT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('SHELL-TIMEOUT TEST PASSED\n');
