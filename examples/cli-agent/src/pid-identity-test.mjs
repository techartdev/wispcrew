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
import { isProcessAlive, isSameProcess, parseElapsed, processStartTime } from '@wispcrew/runtime';

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

console.log('\n[agreement] our start time matches what the OS reports');
{
  /*
   * `Get-Process().StartTime` returned an EMPTY string on a Windows CI
   * runner, so every identity check failed there. WMIC reads the same value
   * without the permission that property needs, and is tried first.
   *
   * This pins that whichever path is taken, the answer agrees with the OS:
   * a start time from a different clock would silently break the one-minute
   * tolerance in isSameProcess.
   */
  const mine = processStartTime(process.pid);

  /*
   * A start time is not guaranteed. A locked-down Windows CI runner refused
   * BOTH `Get-Process().StartTime` and WMIC, and demanding one here failed
   * the build for a host behaving within its rights.
   *
   * The contract is what matters, and it is safe either way: null means
   * "cannot confirm", `isSameProcess` returns false, and the caller declines
   * to signal a pid it cannot identify. The cost is a stale endpoint left
   * alone rather than a stranger killed — the right way round.
   */
  /*
   * Whatever this host can do, the answer must be CONSISTENT.
   *
   * Reading a start time shells out, and a command can succeed once then
   * fail under load or policy. CI caught exactly that: one call returned
   * null and a later one returned a time, so `isSameProcess` disagreed with
   * itself about the same pid. Values are cached now, which is both correct
   * — a start time cannot change — and what makes this assertion meaningful.
   */
  const again = processStartTime(process.pid);
  check('the same pid gives the same answer', mine === again, `${mine} then ${again}`);

  if (mine === null) {
    console.log('  --   this host reports no start time; identity checks decline to match');
    check('so an unconfirmable pid never matches', !isSameProcess(process.pid, Date.now()));
  } else {
    check('a start time was read', typeof mine === 'number');
  }

  if (mine !== null && process.platform === 'win32') {
    const { execFileSync } = await import('node:child_process');
    let reference = null;
    try {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc()`],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      ).trim();
      if (out) reference = Math.round(Number(out) / 10_000 - 11_644_473_600_000);
    } catch {
      // The exact failure the fallback exists for.
    }

    if (reference === null) {
      console.log('  --   PowerShell cannot report it here; the fallback is what is in use');
    } else {
      check(
        'it agrees with the OS to within a second',
        Math.abs(mine - reference) < 1000,
        `${Math.abs(mine - reference)}ms apart`,
      );
    }
  }
}

console.log('\n[start time] sane when the host reports one');
{
  const mine = processStartTime(process.pid);
  if (mine === null) {
    console.log('  --   not available on this host');
  } else {
    check('it is in the past', mine <= Date.now() + 5000, new Date(mine).toISOString());
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

  if (startedAt === null) {
    /*
     * Without a start time nothing can be confirmed, and the safe answer is
     * "not ours" — which is exactly what must be asserted here, because the
     * alternative would be signalling a pid we cannot identify.
     */
    check('an unconfirmable pid never matches', !isSameProcess(child.pid, Date.now()));
  } else {
    check('the same pid and time matches', isSameProcess(child.pid, startedAt));

    // A pid whose recorded start is far in the past is what recycling looks
    // like: same number, different process.
    check(
      'a recycled pid is rejected',
      !isSameProcess(child.pid, startedAt - 6 * 60 * 60 * 1000),
    );
  }

  // Unknown start time must never be treated as a match: declining to kill
  // is the safe failure.
  check('an unknown start time is rejected', !isSameProcess(child.pid, undefined));

  child.kill();
  await new Promise((r) => setTimeout(r, 500));

  check('a dead pid is not alive', !isProcessAlive(child.pid));
  check('and never matches', !isSameProcess(child.pid, startedAt ?? Date.now()));
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
