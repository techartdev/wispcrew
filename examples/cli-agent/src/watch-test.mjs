/**
 * watch-test.mjs — waking an agent on a file change, without a runaway.
 *
 * The third wake source, alongside cron and follow-ups. Debouncing is the
 * whole problem: a single save produces several filesystem events, and a
 * build produces thousands. An agent woken once per event would run
 * continuously, cost money, and be useless.
 *
 * Offline: real files, no model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeWatch, matchesPattern, watchDirectory } from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-watch-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n[patterns] what a user types, not a full glob');
{
  check('extension matches', matchesPattern('server.log', '*.log'));
  check('and nested', matchesPattern('logs/server.log', '*.log'));
  check('a different extension does not', !matchesPattern('server.txt', '*.log'));
  check('a path segment matches', matchesPattern('src/index.ts', 'src/*.ts'));
  check('a single character wildcard', matchesPattern('a1.log', 'a?.log'));
  // A dot is a literal in a filename, not "any character".
  check('dots are literal', !matchesPattern('serverXlog', '*.log'));
  check('no pattern matches everything', matchesPattern('anything.at.all'));
}

console.log('\n[debounce] one save wakes the agent once');
{
  const wakes = [];
  const watcher = watchDirectory({
    directory: dir,
    onChange: (paths) => wakes.push(paths),
  });

  // An editor save is several events: write, rename, touch the directory.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'three');

  await wait(3500);
  check('woken exactly once', wakes.length === 1, `${wakes.length} times`);
  check('told what changed', wakes[0]?.includes('a.txt'), JSON.stringify(wakes[0]));
  watcher.stop();
}

console.log('\n[burst] a build does not wake it once per file');
{
  const wakes = [];
  const watcher = watchDirectory({
    directory: dir,
    onChange: (paths) => wakes.push(paths),
  });

  // The shape of a build: many files, quickly.
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(dir, `build-${i}.tmp`), String(i));
  }

  await wait(3500);
  check('one wake-up, not two hundred', wakes.length === 1, `${wakes.length} times`);

  /*
   * The path list is a hint, not an inventory.
   *
   * Windows coalesces aggressively: writing 200 files produced TWO events,
   * one of them with a null filename. Measured, not assumed. So a caller
   * must treat the list as "something under here changed, here is part of
   * what" and look at the directory itself if it needs the full picture.
   *
   * That is fine for the purpose — the agent is being woken to go and look —
   * but a test asserting the full list would pass on Linux and fail here.
   */
  check('at least one path is named', (wakes[0]?.length ?? 0) >= 1, String(wakes[0]?.length));
  watcher.stop();
}

console.log('\n[filter] only the files asked for');
{
  const wakes = [];
  const watcher = watchDirectory({
    directory: dir,
    pattern: '*.log',
    onChange: (paths) => wakes.push(paths),
  });

  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'no');
  await wait(2600);
  check('an unmatched file is ignored', wakes.length === 0, `${wakes.length} wake-ups`);

  fs.writeFileSync(path.join(dir, 'server.log'), 'yes');
  await wait(3000);
  check('a matched file wakes it', wakes.length === 1, `${wakes.length} wake-ups`);
  check('and only that file is reported',
    wakes[0]?.every((p) => p.endsWith('.log')), JSON.stringify(wakes[0]));
  watcher.stop();
}

console.log('\n[stopped] a stopped watcher stays quiet');
{
  const wakes = [];
  const watcher = watchDirectory({ directory: dir, onChange: (p) => wakes.push(p) });
  watcher.stop();
  // Stopping twice must be safe: routines are removed and re-added.
  watcher.stop();

  fs.writeFileSync(path.join(dir, 'after-stop.txt'), 'x');
  await wait(2600);
  check('nothing fires after stop', wakes.length === 0, `${wakes.length} wake-ups`);
}

console.log('\n[description] reads as a peer of a schedule');
{
  check('with a pattern', describeWatch('/tmp/logs', '*.log') === 'When *.log changes in logs',
    describeWatch('/tmp/logs', '*.log'));
  check('without one', describeWatch('/tmp/logs') === 'When anything changes in logs',
    describeWatch('/tmp/logs'));
}

console.log('\n[missing directory] fails loudly rather than never firing');
{
  try {
    watchDirectory({ directory: path.join(dir, 'does-not-exist'), onChange: () => {} });
    check('a missing directory is refused', false, 'it was accepted');
  } catch (err) {
    check('a missing directory is refused', /could not watch/i.test(err.message), err.message);
  }
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`WATCH TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('WATCH TEST PASSED\n');
