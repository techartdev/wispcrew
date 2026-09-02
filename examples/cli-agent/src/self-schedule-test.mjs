/**
 * self-schedule-test.mjs — an agent waking itself, with the user in control.
 *
 * Two shapes, deliberately different:
 *
 *  - A FOLLOW-UP is one wake-up, soon, and needs no approval: bounded, and
 *    the user is usually still there. Interrupting them to approve "give me
 *    a minute and I'll check" costs more than it is worth.
 *  - A ROUTINE is open-ended authority — running unattended, possibly for
 *    months — so it goes through the same gate as any consequential tool.
 *
 * Offline: store and scheduler only, no model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgent,
  createNodeCrypto,
  initStore,
  installScheduler,
  listRoutines,
  setHost,
} from '@wispcrew/runtime';
import { proposeRoutineTool, scheduleFollowUpTool } from '@wispcrew/tools';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-sched-'));
setHost({
  dataDir: dir,
  defaultWorkspaceRoot: dir,
  nodeName: 'test',
  crypto: createNodeCrypto(dir),
});
initStore(dir);
installScheduler();

const work = path.join(dir, 'workspace');
fs.mkdirSync(work, { recursive: true });
const agent = createAgent({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Watcher', workspaceRoot: work });

/** Records what the user was asked, so the prompt itself can be inspected. */
const asked = [];
const ctx = (approve) => ({
  workspaceRoot: work,
  defaultTimeoutMs: 10_000,
  requestApproval: async (req) => {
    asked.push(req);
    return approve;
  },
});

console.log('\n[follow-up] one wake-up, no approval needed');
{
  const before = asked.length;
  const r = await scheduleFollowUpTool.run(
    { minutes: 20, prompt: 'Check whether the build finished.', reason: 'Build check' },
    ctx(false),
  );

  check('it was scheduled', r.ok === true, String(r.content));
  check('without asking', asked.length === before, 'it prompted for approval');

  const routine = listRoutines(agent.id).find((x) => x.name === 'Build check');
  check('a routine exists', Boolean(routine));
  check('as a one-shot', typeof routine?.runAt === 'number', JSON.stringify(routine?.runAt));
  check('marked as self-scheduled', routine?.selfScheduled === true);
  check('roughly 20 minutes out',
    Math.abs((routine?.runAt ?? 0) - (Date.now() + 20 * 60_000)) < 60_000);
  check('and it knows when it next runs', routine?.nextRunAt === routine?.runAt);
}

console.log('\n[bounds] a nonsense delay is refused');
{
  check('zero minutes', (await scheduleFollowUpTool.run({ minutes: 0, prompt: 'x' }, ctx(true))).ok === false);
  check('negative', (await scheduleFollowUpTool.run({ minutes: -5, prompt: 'x' }, ctx(true))).ok === false);
  check('a year away', (await scheduleFollowUpTool.run({ minutes: 525_600, prompt: 'x' }, ctx(true))).ok === false);
  check('an empty prompt', (await scheduleFollowUpTool.run({ minutes: 5, prompt: '  ' }, ctx(true))).ok === false);
}

console.log('\n[routine] recurring work needs approval');
{
  asked.length = 0;
  const declined = await proposeRoutineTool.run(
    { name: 'Repo watch', cron: '0 * * * *', prompt: 'Check for new issues.' },
    ctx(false),
  );

  check('the user was asked', asked.length === 1);
  check('and it was refused', declined.ok === false && declined.errorCode === 'declined');
  check('nothing was created', !listRoutines(agent.id).some((r) => r.name === 'Repo watch'));
  // Telling the model not to keep asking is what stops a decline loop.
  check('the model is told not to re-propose', /do not propose it again/i.test(String(declined.content)));
}

console.log('\n[the prompt] says what is being agreed to');
{
  const request = asked[0];
  check('the schedule is in plain English', /hour/i.test(request.summary), request.summary);
  check('the cron is not shown raw as the summary', !/^0 \* \* \* \*/.test(request.summary));
  // The consequence a user most needs to understand before agreeing.
  check('it says this runs unattended', /app is closed|on its own/i.test(request.detail ?? ''));
  check('and that it continues until removed', /until you remove it/i.test(request.detail ?? ''));
}

console.log('\n[approved] the routine is created');
{
  const approved = await proposeRoutineTool.run(
    { name: 'Repo watch', cron: '0 * * * *', prompt: 'Check for new issues.' },
    ctx(true),
  );
  check('it succeeded', approved.ok === true, String(approved.content));

  const routine = listRoutines(agent.id).find((r) => r.name === 'Repo watch');
  check('the routine exists', Boolean(routine));
  check('with the schedule', routine?.cron === '0 * * * *');
  check('not as a one-shot', routine?.runAt === undefined);
  check('and it has a next run', typeof routine?.nextRunAt === 'number');
}

console.log('\n[invalid schedule] refused before the user is asked');
{
  asked.length = 0;
  const r = await proposeRoutineTool.run(
    { name: 'Broken', cron: 'not a cron', prompt: 'x' },
    ctx(true),
  );
  check('it failed', r.ok === false, String(r.errorCode));
  // Approving something that can never fire would be a waste of the user's
  // attention and a confusing routine that silently never runs.
  check('and the user was never asked', asked.length === 0);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`SELF-SCHEDULE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('SELF-SCHEDULE TEST PASSED\n');
