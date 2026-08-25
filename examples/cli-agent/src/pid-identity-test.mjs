/**
 * pid-identity-test.mjs — a pid alone is not an identity.
 *
 * The stale-daemon restart kills a pid read from a file. Operating systems
 * recycle pids, so an endpoint left by a daemon that died can name a
 * process that now belongs to something else entirely — and signalling that
 * would kill a stranger's work.
 *
 * The idea is borrowed from how DeepSeek Harness models process teardown:
 * it carries "PID plus start identity, preventing teardown escalation after
 * PID reuse". Same reasoning, our own implementation.
 *
 * Offline: local processes only.
 */
import { spawn } from 'node:child_process';
import { isProcessAlive, isSameProcess, parseElapsed, processStartTime } from '@ghostbot/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\n[elapsed parsing] every ps format, on every platform');
{
  /*
   * `ps -o etimes=` gives plain seconds but is a Linux extension: macOS
   * prints nothing for it, so identity checks failed there entirely. CI
   * caught that; these cases cover the portable `etime` format so the
   * parsing cannot regress silently on a platform nobody is sitting at.
   */
  check('mm:ss', parseElapsed('05:30') === 330, String(parseElapsed('05:30')));
  check('hh:mm:ss', parseElapsed('01:05:30') === 3930, String(parseElapsed('01:05:30')));
  check('dd-hh:mm:ss', parseElapsed('2-01:05:30') === 176_730, String(parseElapsed('2-01:05:30')));
  check('leading spaces tolerated', parseElapsed('   00:07 ') === 7);
  check('nonsense is rejected', parseElapsed('not-a-duration') === null);
  check('empty is rejected', parseElapsed('') === null);
}

console.log('\n[start time] readable for a live process');
{
  const mine = processStartTime(process.pid);
  check('our own start time is readable', mine !== null, String(mine));
  if (mine !== null) {
    check('and is in the past', mine <= Date.now() + 5000, new Date(mine).toISOString());
    check('but not absurdly so', mine > Date.now() - 24 * 60 * 60 * 1000);
  }
}

console.log('\n[identity] matches only the process we recorded');
{
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 700));

  const startedAt = processStartTime(child.pid);
  check('a child start time is readable', startedAt !== null, String(startedAt));

  check('the same pid and time matches', isSameProcess(child.pid, startedAt ?? 0));

  // A pid whose recorded start is far in the past is what recycling looks
  // like: same number, different process.
  check(
    'a recycled pid is rejected',
    !isSameProcess(child.pid, (startedAt ?? Date.now()) - 6 * 60 * 60 * 1000),
  );

  // Unknown start time must never be treated as a match: declining to kill
  // is the safe failure.
  check('an unknown start time is rejected', !isSameProcess(child.pid, undefined));

  child.kill();
  await new Promise((r) => setTimeout(r, 500));

  check('a dead pid is not alive', !isProcessAlive(child.pid));
  check('and never matches', !isSameProcess(child.pid, startedAt ?? 0));
}

console.log('\n[nonsense] invalid input is refused, not guessed');
{
  check('pid 0 is rejected', !isSameProcess(0, Date.now()));
  check('a negative pid is rejected', !isSameProcess(-1, Date.now()));
  check('a start time for pid 0 is null', processStartTime(0) === null);
}

console.log('');
if (failures) {
  console.error(`PID-IDENTITY TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('PID-IDENTITY TEST PASSED\n');
