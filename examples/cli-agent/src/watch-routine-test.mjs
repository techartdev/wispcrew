/**
 * watch-routine-test.mjs — a file change wakes a routine.
 *
 * The third wake source, wired end to end: a routine with a `watchPath`
 * fires through the same runner as a scheduled one, so its run history and
 * failures look identical.
 *
 * Offline: real files, a stub runner, no model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activeWatchCount,
  createAgent,
  createNodeCrypto,
  createRoutine,
  initStore,
  listRoutines,
  setHost,
  stopWatches,
  syncWatches,
  updateRoutine,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-wr-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

const watched = path.join(dir, 'watched');
fs.mkdirSync(watched, { recursive: true });

const agent = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Watcher', workspaceRoot: dir });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fired = [];
const runner = async (routine) => {
  fired.push(routine.prompt);
};

console.log('\n[setup] a watch routine starts a watcher');
{
  createRoutine({
    agentId: agent.id,
    name: 'Log watch',
    cron: '',
    watchPath: watched,
    watchPattern: '*.log',
    prompt: 'Read the new log lines.',
    enabled: true,
  });

  syncWatches(runner);
  check('a watcher is running', activeWatchCount() === 1, String(activeWatchCount()));
}

console.log('\n[trigger] a matching file wakes it');
{
  fs.writeFileSync(path.join(watched, 'server.log'), 'error: something broke');
  await wait(3500);

  check('the routine ran', fired.length === 1, `${fired.length} runs`);
  check('with its own prompt', fired[0]?.includes('Read the new log lines'));
  // The agent needs to know why it woke up, not just that it did.
  check('and what changed', /Files changed under/.test(fired[0] ?? ''), fired[0]?.slice(0, 120));
  check('honest that the list is partial', /full picture/.test(fired[0] ?? ''));
}

console.log('\n[filter] a non-matching file does not');
{
  const before = fired.length;
  fs.writeFileSync(path.join(watched, 'notes.txt'), 'ignore me');
  await wait(3000);
  check('it stayed asleep', fired.length === before, `${fired.length - before} extra runs`);
}

console.log('\n[history] a watch run is recorded like any other');
{
  const routine = listRoutines(agent.id)[0];
  const runs = routine.runs ?? [];
  check('a run was recorded', runs.length > 0, String(runs.length));
  check('and it succeeded', runs.some((r) => r.status === 'ok'), JSON.stringify(runs.map((r) => r.status)));
  // A watch has no clock, so a "next run" would be a fiction.
  check('with no next run time', routine.nextRunAt === undefined, String(routine.nextRunAt));
}

console.log('\n[disable] turning it off stops the watcher');
{
  const routine = listRoutines(agent.id)[0];
  updateRoutine(routine.id, { enabled: false });
  syncWatches(runner);

  check('no watchers remain', activeWatchCount() === 0, String(activeWatchCount()));

  const before = fired.length;
  fs.writeFileSync(path.join(watched, 'after-disable.log'), 'x');
  await wait(3000);
  check('and nothing fires', fired.length === before);
}

console.log('\n[broken path] a watch that cannot start says so');
{
  createRoutine({
    agentId: agent.id,
    name: 'Missing dir',
    cron: '',
    watchPath: path.join(dir, 'does-not-exist'),
    prompt: 'x',
    enabled: true,
  });

  syncWatches(runner);
  const broken = listRoutines(agent.id).find((r) => r.name === 'Missing dir');

  // A routine that looks enabled and silently never fires is the worst
  // outcome: the user believes they are being watched when they are not.
  check('the failure is recorded', (broken?.runs ?? []).some((r) => r.status === 'error'),
    JSON.stringify(broken?.runs?.map((r) => r.status)));
  check('and no watcher was left half-started', activeWatchCount() === 0, String(activeWatchCount()));
}

stopWatches();
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`WATCH-ROUTINE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('WATCH-ROUTINE TEST PASSED\n');
