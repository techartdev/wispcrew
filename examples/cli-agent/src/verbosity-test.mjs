/*
 * verbosity-test.mjs — how much an agent says is a setting, and it arrives.
 *
 * Two agents in one room were both told "keep replies short" in the room
 * instructions. Over one evening one wrote 122 messages and the other 19.
 * The room read as a monologue with occasional interjections, and the
 * quieter agent's contributions were unfindable between walls of narration.
 *
 * A preference in prose is not a mechanism. This pins the mechanism:
 *
 *  - the level reaches the assembled system prompt, for every level;
 *  - the rules are concrete acts, not adjectives, because a model can check
 *    itself against "never narrate reading a file" and cannot check itself
 *    against "be concise";
 *  - a room tightens it further, and says WHY -- every message is context
 *    for every other member, which is true and is what makes it persuasive;
 *  - `quiet` and `full` actually differ.
 *
 * The wiring half matters as much as the wording. The system prompt itself
 * was silently dropped for every non-subscription provider until 6c27be0,
 * and `via`, `authorId` and tool-result ages were each recorded and never
 * read. Declared-but-unused is this codebase's most repeated fault, so the
 * assertion is that the text is PRESENT in the built prompt.
 */
import { defaultSystemPrompt, PERSONAS } from '@wispcrew/core';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
};

const room = {
  participants: [
    { kind: 'agent', name: 'Claude', handle: 'claude', self: true },
    { kind: 'agent', name: 'Local GPT', handle: 'local-gpt' },
    { kind: 'human', name: 'You', handle: 'you' },
  ],
  mode: 'open',
};

console.log('\n[1] every level reaches the prompt');
{
  const quiet = defaultSystemPrompt({ verbosity: 'quiet' });
  const normal = defaultSystemPrompt({ verbosity: 'normal' });
  const full = defaultSystemPrompt({ verbosity: 'full' });

  check('quiet says results only', /results only/i.test(quiet), quiet.slice(0, 0));
  check('normal is the follow-along level', /enough to follow/i.test(normal));
  check('full narrates', /narrate your work/i.test(full));

  check('the three differ', quiet !== normal && normal !== full, 'two levels produced identical prompts');
}

console.log('\n[2] unset behaves as normal');
{
  const unset = defaultSystemPrompt({});
  const normal = defaultSystemPrompt({ verbosity: 'normal' });
  check('same as normal', unset === normal, 'an unset agent got a different prompt');
}

console.log('\n[3] the rules are checkable acts, not adjectives');
{
  const normal = defaultSystemPrompt({ verbosity: 'normal' });
  /*
   * Each of these names something the model can observe itself doing. That
   * is the whole difference between this and the instruction that failed.
   */
  check('names reading a file', /never narrate reading a file/i.test(normal));
  check('names the batch rule', /one message per batch/i.test(normal));
  check('says to skip intermediate steps', /skip the steps/i.test(normal));
}

console.log('\n[4] a room tightens it, and says why');
{
  const alone = defaultSystemPrompt({ verbosity: 'normal' });
  const together = defaultSystemPrompt({ verbosity: 'normal', room });

  check('the room adds a rule', together.length > alone.length);
  check(
    'it explains the cost to others',
    /context/i.test(together) && /other member/i.test(together),
    'the room clause does not say why it matters',
  );
  check('alone, that clause is absent', !/other member's context/i.test(alone));
}

console.log('\n[5] a solo agent is not lectured about a room');
{
  const solo = defaultSystemPrompt({
    verbosity: 'quiet',
    room: {
      participants: [
        { kind: 'agent', name: 'Only', handle: 'only', self: true },
        { kind: 'human', name: 'You', handle: 'you' },
      ],
      mode: 'open',
    },
  });
  check('no room clause for one agent', !/other member/i.test(solo));
}

console.log('\n[6] it survives every persona');
{
  const missing = [];
  for (const persona of PERSONAS) {
    const built = persona.build({ verbosity: 'quiet' });
    if (!/results only/i.test(built)) missing.push(persona.id);
  }
  check('all personas carry it', missing.length === 0, missing.join(', '));
}

console.log('');
if (failures) {
  console.error(`VERBOSITY TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('VERBOSITY TEST PASSED\n');
