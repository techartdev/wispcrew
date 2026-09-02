/**
 * roommates-test.mjs — agents seeing each other, and watching files.
 *
 * Two gaps reported together: an agent in a room could not tell whether a
 * colleague was working, and an agent could not ask for a routine triggered
 * by a file change even though the engine has supported one since watches
 * existed.
 *
 * Both were cases of information or machinery that already existed and had
 * no door onto it — the same shape as `routeAgentMessage`, `authorId` and
 * `usage` before them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCheckAgentsTool, proposeRoutineTool, setScheduler } from '@wispcrew/tools';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\n[check_agents] who is here, and who is working');
{
  const now = Date.now();
  const tool = makeCheckAgentsTool({
    others: () => [
      { handle: 'sums', name: 'Sums', busy: true, since: now - 40_000 },
      { handle: 'notes', name: 'Notes', busy: false },
    ],
  });

  const res = await tool.run({}, {});

  check('it succeeds', res.ok);
  check('the busy one is named as working', /@sums \(Sums\) — working/.test(res.content),
    res.content);
  check('with how long', /working \(40s\)/.test(res.content), res.content);
  check('and the idle one as idle', /@notes \(Notes\) — idle/.test(res.content), res.content);

  /*
   * "Working" invites a poll, and a model that polls burns a turn each time
   * and learns nothing new. The alternative is said in the answer, which is
   * the one place it is certain to be read.
   */
  check('polling is discouraged where it matters', /Do not check again in a loop/.test(res.content));
  check('and the alternative is given', /say so in the room/.test(res.content));
}

console.log('\n[check_agents] alone, it says so plainly');
{
  const tool = makeCheckAgentsTool({ others: () => [] });
  const res = await tool.run({}, {});
  check('no invented company', /Nobody else is in this conversation/.test(res.content));
  check('and no loop advice when there is nothing to wait for',
    !/Do not check again/.test(res.content));
}

console.log('\n[no blocking wait] deadlock is designed out, not warned about');
{
  /*
   * Two agents each waiting for the other is a deadlock no turn budget can
   * unwind, and it holds a turn on both sides while it happens. Waiting is
   * expressible without it: ask in the room, and the reply wakes you.
   */
  const src = fs.readFileSync(path.join(repo, 'packages/tools/src/roommates.ts'), 'utf8');
  check('no wait_for_agent tool exists', !/name: 'wait_for_agent'/.test(src));
  check('and the reason is written down', /deadlock/.test(src));
}

console.log('\n[propose_routine] a watch is a trigger, like a schedule');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-watch-'));
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });

  let created = null;
  setScheduler({
    followUp: async () => 'never',
    createRoutine: async (name, cron, prompt, _ctx, watch) => {
      created = { name, cron, prompt, watch };
      return 'rt_1';
    },
    describeCron: (c) => (/^\S+ \S+ \S+ \S+ \S+$/.test(c) ? 'every day' : (() => { throw new Error('not a cron'); })()),
  });

  const ctx = { workspaceRoot: root, defaultTimeoutMs: 5000, requestApproval: async () => true };

  const res = await proposeRoutineTool.run(
    { name: 'Build watch', watch: 'build', prompt: 'Report what changed.' },
    ctx,
  );

  check('it is approved and created', res.ok, res.content);
  check('as a watch, not a schedule', created?.watch?.path !== undefined && !created.cron,
    JSON.stringify(created));
  check('resolved inside the workspace',
    created?.watch?.path === path.join(root, 'build'), created?.watch?.path);
}

console.log('\n[propose_routine] the card describes what it will react to');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-watch2-'));
  let card = null;
  setScheduler({
    followUp: async () => 'never',
    createRoutine: async () => 'rt_2',
    describeCron: () => 'every day',
  });

  await proposeRoutineTool.run(
    { name: 'Logs', watch: '.', pattern: '*.log', prompt: 'Summarise.' },
    {
      workspaceRoot: root,
      defaultTimeoutMs: 5000,
      requestApproval: async (req) => {
        card = req;
        return true;
      },
    },
  );

  /*
   * A routine is open-ended authority. The user is agreeing to something
   * that runs unattended, so the card has to say what wakes it and where.
   */
  check('the summary says what triggers it', /whenever \. changes/.test(card?.summary ?? ''),
    card?.summary);
  check('including the pattern', /matching \*\.log/.test(card?.summary ?? ''), card?.summary);
  check('and the detail names the real path', /Watching: /.test(card?.detail ?? ''), card?.detail);
}

console.log('\n[propose_routine] a watch cannot escape the workspace');
{
  /*
   * This one matters more than most path checks: "watch C:\\Users\\me" in an
   * approval card is exactly the sort of thing that gets waved through.
   */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-watch3-'));
  setScheduler({
    followUp: async () => 'never',
    createRoutine: async () => 'rt_3',
    describeCron: () => 'every day',
  });

  let asked = false;
  const res = await proposeRoutineTool.run(
    { name: 'Escape', watch: path.join(os.homedir(), 'Documents'), prompt: 'Watch everything.' },
    {
      workspaceRoot: root,
      defaultTimeoutMs: 5000,
      requestApproval: async () => {
        asked = true;
        return true;
      },
    },
  );

  check('it is refused', !res.ok, res.content);
  check('with a code that names why', res.errorCode === 'outside_workspace', res.errorCode);
  // Refused BEFORE the user is asked: a card for something impossible is
  // worse than no card, because approving it teaches the wrong lesson.
  check('and the user is never asked', !asked);
}

console.log('\n[propose_routine] one trigger, not two');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-watch4-'));
  setScheduler({
    followUp: async () => 'never',
    createRoutine: async () => 'rt_4',
    describeCron: () => 'every day',
  });

  const both = await proposeRoutineTool.run(
    { name: 'Both', cron: '0 9 * * *', watch: '.', prompt: 'x' },
    { workspaceRoot: root, defaultTimeoutMs: 5000, requestApproval: async () => true },
  );
  check('cron and watch together are refused', !both.ok && both.errorCode === 'ambiguous',
    both.content);

  const neither = await proposeRoutineTool.run(
    { name: 'Neither', prompt: 'x' },
    { workspaceRoot: root, defaultTimeoutMs: 5000, requestApproval: async () => true },
  );
  check('and neither is refused too', !neither.ok && neither.errorCode === 'incomplete',
    neither.content);
}

console.log('\n[watchers] a routine created later still gets watched');
{
  /*
   * The record existing is not enough. `syncWatches` is called once at
   * startup with a runner; a routine approved afterwards needs a re-sync or
   * it sits in the Scheduled list looking scheduled and never fires — which
   * is how a feature that "exists" turns out not to work.
   */
  const manager = fs.readFileSync(
    path.join(repo, 'packages/runtime/src/watch-manager.ts'),
    'utf8',
  );
  check('a re-sync exists', /export function resyncWatches/.test(manager));
  check('and it reuses the installed runner', /if \(runner\) syncWatches\(runner, notify\)/.test(manager));

  const host = fs.readFileSync(path.join(repo, 'packages/runtime/src/schedule-host.ts'), 'utf8');
  check('the host calls it for a watch', /if \(watch\) resyncWatches\(\)/.test(host));
  check('and does not compute a next run for one',
    /else refreshNextRunTime\(routine\.id\)/.test(host));
}

console.log('');
if (failures) {
  console.error(`ROOMMATES TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOMMATES TEST PASSED\n');
