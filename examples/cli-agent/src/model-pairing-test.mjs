/**
 * model-pairing-test.mjs — an agent whose provider and model come from
 * different vendors is refused before anything is spent.
 *
 * The complaint that caused this: "when an agent is defective (setup is
 * obviously bad) I need to get an error about the problem, not waste
 * everyone else's tokens for obvious failure."
 *
 * The shape of the mistake is always the same, and inheritance is what
 * makes it easy: the MODEL is set explicitly on the agent, the PROVIDER is
 * not set at all and falls back to the global one, so the two come from
 * different places and nothing ever looks at them together. Asking NVIDIA
 * for `gpt-5.6-terra` returns a bare `404 page not found` — measured — and
 * always will.
 *
 * ## Why the first version did not catch it
 *
 * It judged only against a catalogue this process had already FETCHED. On a
 * freshly started daemon that is no provider at all, so the very case the
 * file was written for sailed straight through. The cheap signal was sitting
 * in the presets the whole time.
 *
 * ## The line this suite exists to hold
 *
 * "Not in my provider's list" proves NOTHING. Those lists are short and
 * curated — NVIDIA serves 84 models and the preset names a handful — and
 * refusing on absence would block every model newer than this repository.
 *
 * "Listed by a DIFFERENT vendor and not by mine" is a positive claim of
 * ownership. That is the only thing refused.
 *
 * Offline: pure function.
 */
import { checkModelPairing } from '@wispcrew/runtime';
import { PROVIDER_PRESETS } from '@wispcrew/llm';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const blocked = (preset, model) => checkModelPairing(preset, model) !== null;

console.log('\n[the real one] an OpenAI model pointed at NVIDIA');
{
  check('refused', blocked('nvidia', 'gpt-5.6-terra'));

  const problem = checkModelPairing('nvidia', 'gpt-5.6-terra');
  // Naming the owner is the whole value: "does not offer" sends someone
  // hunting, "belongs to OpenAI" tells them what they actually did.
  check('names who owns the model', /OpenAI/.test(problem.message), problem.message);
  check('and the provider it was pointed at', /nvidia/.test(problem.message));
  check('says nothing was sent', /Nothing was sent/.test(problem.message), problem.message);
  // Both ways out, because either may be the one the user meant.
  check('and offers both repairs',
    /Pick a model this provider serves/.test(problem.message) &&
      /switch the provider to match/.test(problem.message),
    problem.message);
}

console.log('\n[not a false positive] the same model where it belongs');
{
  /*
   * This is the assertion that matters most, and the one whose absence
   * cost three working agents. `gpt-5.6-terra` on a ChatGPT subscription is
   * correct — the model is OpenAI's and so is the provider. A rule that
   * merely spotted "OpenAI model" without checking whose provider it is
   * would condemn a perfectly good agent.
   */
  check('a subscription may serve it', !blocked('chatgpt-subscription', 'gpt-5.6-terra'));
  check('and so may the API', !blocked('openai', 'gpt-5.6-terra'));
  check('an NVIDIA model on NVIDIA', !blocked('nvidia', 'nvidia/nemotron-3-super-120b-a12b'));
  check('and Anthropic on Anthropic', !blocked('anthropic', 'claude-opus-5'));
}

console.log('\n[staleness is not an error] a model newer than this repo');
{
  /*
   * The presets are curated, not exhaustive, and say so in their own
   * comments. Anything typed into the free-text model field must keep
   * working — refusing on "absent from my list" would make every provider
   * update a code change.
   */
  check('an unknown NVIDIA model passes', !blocked('nvidia', 'nvidia/not-invented-yet'));
  check('an unknown OpenAI model passes', !blocked('openai', 'gpt-7-whatever'));
  check('and an unknown Anthropic one', !blocked('anthropic', 'claude-opus-9'));

  /*
   * A FETCHED catalogue is not evidence either, and this is the case that
   * shipped wrong.
   *
   * A second arm used to refuse a model absent from the provider's live
   * model list. That is the same reasoning as "absent from my preset",
   * merely with a fresher source, and it was wrong twice over:
   *
   *  - Reported on `gpt-6-astra` during its rollout: "astra is a model
   *    currently releasing, I don't want to be stopped from trying to call
   *    it."
   *  - And older models are still served long after they stop being
   *    advertised: "there are older models still available out of this list
   *    which I can manually type and call and still work."
   *
   * A catalogue says what a provider ADVERTISES, not what it answers to.
   */
  check('a model releasing right now passes',
    !blocked('chatgpt-subscription', 'gpt-6-astra'));
  check('and one still served but no longer listed',
    !blocked('chatgpt-subscription', 'gpt-4-0314'));
}

console.log('\n[the provider gets the last word] when a name really is wrong');
{
  /*
   * The trade for the above: WispCrew no longer guesses, so a genuinely bad
   * name is discovered by asking. That is only acceptable if the answer is
   * the provider's own words rather than a shrug — which is what was asked
   * for: "do request and forward to me the original provider error".
   */
  const { describeHttpFailure } = await import('@wispcrew/llm');

  const body = JSON.stringify({
    error: { message: 'The model `gpt-6-astra` does not exist or you do not have access to it.' },
  });
  const said = describeHttpFailure(404, body, 'ChatGPT subscription', 'gpt-6-astra');

  check('the provider is quoted verbatim', said.includes('does not exist or you do not have access'),
    said);

  /*
   * And it does not assert the model is missing, because 404 is not only
   * "no such model" — NVIDIA's free tier answers that way under load, so
   * the same name succeeds and fails minutes apart.
   */
  check('without claiming to know why', /may be busy rather than missing/.test(said), said);
}

console.log('\n[local endpoints serve anything] and are never judged');
{
  /*
   * A local server or a proxy may answer to any name — someone's own alias
   * for a hosted model is a real setup. Nothing about a name proves a
   * pairing is wrong there, in either direction.
   */
  for (const local of ['ollama', 'lmstudio', 'custom']) {
    check(`${local} may serve an OpenAI name`, !blocked(local, 'gpt-5.6-terra'));
  }

  // And a hosted provider is not condemned for a name a local preset uses.
  check('a local preset does not claim names for others',
    !blocked('nvidia', 'local-model'), 'nvidia + local-model was refused');
}

console.log('\n[unknowable] no preset, no model, no opinion');
{
  check('no provider means no judgement', !blocked(undefined, 'gpt-5.6-terra'));
  check('no model means no judgement', !blocked('nvidia', undefined));
  check('an unknown preset id is not judged', !blocked('someones-fork', 'gpt-5.6-terra'));
}

console.log('\n[whitespace] a name is trimmed before it is judged');
{
  /*
   * A model name arrived once as `"nvidia/nemotron-3-nano-30b-a3b\r"` from a
   * deploy script written on Windows. An untrimmed comparison would have
   * called a correct pairing wrong.
   */
  check('padding does not change the answer', !blocked('openai', '  gpt-5.6-terra  '));
  check('and still catches the real mismatch', blocked('nvidia', '  gpt-5.6-terra  '));
}

console.log('\n[every preset] the rule is coherent across the whole catalogue');
{
  /*
   * Each preset's OWN default model must pass on its own preset. A rule
   * that condemned a shipped default would be broken on a first run, for
   * somebody who had changed nothing.
   */
  for (const preset of PROVIDER_PRESETS) {
    check(
      `${preset.id} accepts its own default`,
      !blocked(preset.id, preset.defaultModel),
      `${preset.id} + ${preset.defaultModel}`,
    );
  }
}

console.log('');
if (failures) {
  console.error(`MODEL-PAIRING TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('MODEL-PAIRING TEST PASSED\n');
