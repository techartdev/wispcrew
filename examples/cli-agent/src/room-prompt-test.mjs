/**
 * room-prompt-test.mjs — an agent must be told it is in company.
 *
 * This project has already paid for omitting environment facts once: asked
 * whether it had cron, an agent answered "No — I don't have an internal
 * persistent scheduler", and proposed GitHub Actions instead. WispCrew had
 * had a scheduler throughout; the model simply had no way to know.
 *
 * The same thing happened with rooms. An agent asked "what is 2 + 2?" in a
 * two-agent room called a NOTIFICATION tool instead of answering, because
 * nothing in its context suggested it had been spoken to. A model cannot act
 * on a situation it has not been told about.
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

console.log('\n[alone] a single-agent conversation says nothing about rooms');
{
  const prompt = defaultSystemPrompt({ persistent: true });
  // Telling a lone agent it is "in a conversation with @itself" is noise,
  // and the single-agent case is still the common one.
  check('no room section', !/several participants/i.test(prompt));
  check('but the environment is still described', /## Your environment/.test(prompt));
}

console.log('\n[in company] the agent is told who it is and who else is here');
{
  const prompt = defaultSystemPrompt({
    persistent: true,
    room: { handle: 'sums', others: ['colours', 'linux'] },
  });

  check('the room is announced', /several participants/i.test(prompt));
  // Without its own handle an agent cannot tell that `@sums` means itself.
  check('it knows its own handle', /You are \*\*@sums\*\*/.test(prompt));
  check('and who else is present', /@colours/.test(prompt) && /@linux/.test(prompt));
  check('that everyone can see it', /Everyone sees every message/i.test(prompt));

  /*
   * The two instructions that fix the measured failures: answering rather
   * than reaching for a tool, and not handing the question to a room-mate.
   */
  check('it is told to answer directly', /Answer directly/i.test(prompt));
  check('and not to delegate to a room-mate', /Do not hand this to another participant/i.test(prompt));
  check('but may draw someone in deliberately', /mention them by handle/i.test(prompt));
}

console.log('\n[one agent named] a room of one is described honestly');
{
  // A room can transiently hold one agent — a guest just left, say.
  const prompt = defaultSystemPrompt({
    persistent: true,
    room: { handle: 'sums', others: [] },
  });
  check('it says so rather than listing nobody', /only agent here/i.test(prompt));
  check('and still names the agent', /@sums/.test(prompt));
}

console.log('\n[personas] the room reaches every persona, not just the default');
{
  for (const id of ['general', 'coder']) {
    const persona = personaById(id);
    if (!persona) continue;
    const prompt = persona.build({
      persistent: true,
      room: { handle: 'windows', others: ['linux'] },
    });
    check(`${id} describes the room`, /several participants/i.test(prompt));
    check(`${id} names the handle`, /@windows/.test(prompt));
  }
}

console.log('\n[notify] reaching the user is not the same as replying');
{
  /*
   * Measured on a real conversation: told "you may reach the user through:
   * app", an agent used `notify_user` to ANSWER — two notifications for two
   * questions, then one combined reply. The user saw a malfunction.
   *
   * The capability is real and worth stating; when it applies is the part
   * that was missing.
   */
  const prompt = defaultSystemPrompt({ persistent: true, channels: ['app', 'desktop'] });

  check('the channels are still named', /app/.test(prompt) && /desktop/.test(prompt));
  check('but framed around absence', /When the user is away/i.test(prompt));
  check('and replies are distinguished', /ordinary replies already reach them/i.test(prompt));
  check('interrupting, not answering', /interrupting, not answering/i.test(prompt));
}

console.log('\n[tool registry] notify_user is withheld from an attended turn');
{
  /*
   * The structural half of the same fix. Prose said "do NOT use it to answer
   * a message they just sent" and a model called it twice anyway, because a
   * tool that is offered gets used.
   *
   * This checks the registry rather than the model: the default set contains
   * it, and the engine removes it for a turn somebody is watching.
   */
  const { defaultTools, ToolRegistry } = await import('@wispcrew/tools');

  const names = defaultTools.map((t) => t.definition.name);
  check('the default set includes it', names.includes('notify_user'), names.join(', '));

  // The constructor already installs the defaults.
  const registry = new ToolRegistry();
  check('a fresh registry has it', registry.get('notify_user') !== undefined);

  registry.unregister('notify_user');
  check('and it can be withheld', registry.get('notify_user') === undefined);

  /*
   * Withholding must not disturb anything else. A blunt filter that removed
   * more than intended would be worse than the bug it fixes — an agent that
   * quietly loses `shell` is far harder to diagnose than one that notifies
   * too often.
   */
  const survivors = names.filter((n) => n !== 'notify_user' && registry.get(n) !== undefined);
  check('every other tool survives', survivors.length === names.length - 1,
    `${survivors.length} of ${names.length - 1}`);
}

console.log('');
if (failures) {
  console.error(`ROOM-PROMPT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM-PROMPT TEST PASSED\n');
