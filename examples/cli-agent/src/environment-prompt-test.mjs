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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSystemPrompt, personaById } from '@wispcrew/core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
  check('a daemon-backed agent is told so', /keeps you working when the window is closed/i.test(background));

  const foreground = defaultSystemPrompt({ persistent: false });
  check('an in-process agent is told the truth instead',
    /work stops when the user quits/i.test(foreground));
  check('and does not claim to survive', !/keeps you working when the window is closed/i.test(foreground));
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

console.log('\n[the workspace it is told about is the one it is confined to]');
{
  /*
   * Found live, and worth a suite of its own.
   *
   * The prompt read `agent.workspaceRoot ?? host default` and skipped the
   * GLOBAL workspace setting, while `effectiveConfig` — what the file and
   * shell tools actually receive — reads the setting first. So on an
   * installation with a global workspace, every agent was told it lived in
   * `~/.wispcrew/workspace` and could then read and write somewhere else
   * entirely.
   *
   * The symptom was an agent asked about its room searching a source tree
   * it had just been told it could not see. The sandbox was correct; the
   * prompt was lying about where the boundary was, which is the same class
   * of failure as claiming a capability that does not exist.
   */
  const engine = fs.readFileSync(
    path.join(repo, 'packages/runtime/src/engine.ts'),
    'utf8',
  );

  check('there is one resolver', /function resolveWorkspaceRoot/.test(engine));
  check('and it consults the global setting', /settings\.workspaceRoot/.test(engine));

  /*
   * Both callers must use it. Counted rather than merely present: the bug
   * was two call sites resolving the same fact two different ways, so one
   * of them still doing so is exactly what this must catch.
   */
  const uses = engine.match(/resolveWorkspaceRoot\(agent\)/g) ?? [];
  check('used by the prompt and by the tools', uses.length === 2, `${uses.length} call(s)`);
  check('and nothing resolves it the old way',
    !/agent\?\.workspaceRoot \?\? host\(\)\.defaultWorkspaceRoot/.test(engine));

  // The line itself must still be produced, or none of the above matters.
  const prompt = defaultSystemPrompt({ persistent: true, workspace: 'D:\\Projects\\thing' });
  check('the prompt names the root', prompt.includes('D:\\Projects\\thing'));
  check('and says a path outside is refused', /a path outside is refused/.test(prompt));

  /*
   * And says it of the FILE tools only.
   *
   * This used to claim "your file and shell tools are confined", which is
   * false of a shell: `cd`, `git -C` and an absolute path all still reach
   * the machine, and containing that needs the operating system rather than
   * a string check. An agent that believed the stronger claim ran
   * `git remote -v`, got a repository from another folder, and reasoned
   * confidently from it. See `test:containment`.
   */
  check('the shell is described honestly', /working directory, not a sandbox/.test(prompt));
  check('and not as confined', !/file and shell tools are confined/.test(prompt));
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
  check('general carries the environment heading', /## Where you are running/.test(general ?? ''));
  check('and the following heading used as the slice end', /## Tool use/.test(general ?? ''));
}

console.log('');
if (failures) {
  console.error(`ENVIRONMENT-PROMPT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ENVIRONMENT-PROMPT TEST PASSED\n');
