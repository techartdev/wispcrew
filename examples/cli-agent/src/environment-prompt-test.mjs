/**
 * environment-prompt-test.mjs — the agent knows what it is running inside.
 *
 * Asked whether it had cron, an agent answered "No — I don't have an
 * internal persistent scheduler or the ability to wake myself up", and
 * suggested GitHub Actions instead. WispCrew has had a cron scheduler and a
 * Routines panel throughout. The model simply had no way to know, so it
 * reasoned honestly from an incomplete picture and misinformed the user
 * about their own application.
 *
 * A model cannot offer a capability nobody told it about.
 *
 * Offline: prompt construction only.
 */
import { defaultSystemPrompt, personaById } from '@wispcrew/core';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\n[the gap that caused the misinformation]');
{
  const prompt = defaultSystemPrompt({});
  check('scheduling is mentioned', /routine/i.test(prompt));
  check('persistence is mentioned', /saved and reloaded|remember/i.test(prompt));
  // The instruction that actually prevents the wrong answer.
  check(
    'it is told not to suggest an external scheduler',
    /do not suggest an external/i.test(prompt),
    prompt.slice(0, 200),
  );
}

console.log('\n[persistence is stated, not assumed]');
{
  const background = defaultSystemPrompt({ persistent: true });
  check('a daemon-backed agent is told so', /keeps working when the window is closed/i.test(background));

  const foreground = defaultSystemPrompt({ persistent: false });
  check('an in-process agent is told the truth instead',
    /work stops when the user quits/i.test(foreground));
  check('and does not claim to survive', !/keeps working when the window is closed/i.test(foreground));
}

console.log('\n[real state, not boilerplate]');
{
  const withRoutines = defaultSystemPrompt({
    persistent: true,
    routines: ['"Morning digest" (0 8 * * *)', '"Repo watch" (0 * * * *)'],
  });
  check('scheduled routines are named', withRoutines.includes('Morning digest'));
  check('with their schedules', withRoutines.includes('0 8 * * *'));

  const without = defaultSystemPrompt({ persistent: true, routines: [] });
  // An empty list must not become a sentence claiming none exist in a way
  // that reads as a capability statement.
  check('no routines means no such line', !/Already scheduled/i.test(without));
}

console.log('\n[channels]');
{
  const prompt = defaultSystemPrompt({
    persistent: true,
    channels: ['the app', 'desktop notification'],
  });
  check('it knows how it may reach the user', /desktop notification/.test(prompt));

  const silent = defaultSystemPrompt({ persistent: true });
  check('and stays quiet when nothing is configured', !/may reach the user/i.test(silent));
}

console.log('\n[every persona, not just the default]');
{
  for (const id of ['general', 'concise', 'coding']) {
    const persona = personaById(id);
    check(`${id} exists`, Boolean(persona));
  }
  // The general persona is what the environment block is sliced from, so it
  // must contain the markers that slicing depends on.
  const general = personaById('general')?.build({ persistent: true });
  check('general carries the environment heading', /## Your environment/.test(general ?? ''));
  check('and the following heading used as the slice end', /## How to work/.test(general ?? ''));
}

console.log('');
if (failures) {
  console.error(`ENVIRONMENT-PROMPT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ENVIRONMENT-PROMPT TEST PASSED\n');
