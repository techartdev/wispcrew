/**
 * reasoning-test.mjs — how hard to think, only where that means anything.
 *
 * Several vendors expose a knob for this and each spells it differently, so
 * the tempting design is one dropdown everywhere. The result of that is a
 * control which silently does nothing on most of the models a user brings —
 * worse than no control, because it costs you trust in every other setting
 * on the panel (hard rule 11).
 *
 * What the vendors actually take, and why the table is keyed by MODEL:
 *
 *  - OpenAI documents none/minimal/low/medium/high/xhigh/max for
 *    `reasoning.effort`, and states plainly that supported values are
 *    model-dependent. The o-series takes the original three; sending
 *    `xhigh` to one is a request error, not a slower answer.
 *  - Anthropic has no enum at all: extended thinking is a token budget,
 *    `thinking: { type: 'enabled', budget_tokens: N }`.
 *  - NVIDIA NIM drives reasoning from the system prompt or
 *    `chat_template_kwargs`, depending on the model. No portable field.
 *  - DeepSeek's reasoner always reasons and takes no knob.
 *
 * Offline: pure functions and the adapters' request shapes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptsEffort, reasoningFor, THINKING_BUDGETS } from '@wispcrew/shared';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\n[offered] only where the pairing has a knob');
{
  check('gpt-5 takes the wide scale',
    reasoningFor('openai', 'gpt-5.6-terra').levels.join() === 'minimal,low,medium,high,xhigh',
    reasoningFor('openai', 'gpt-5.6-terra').levels.join());

  /*
   * The reason this is keyed by model and not by provider. Offering `xhigh`
   * to an o-series model produces a failed request, and the user would have
   * no way to connect the failure to the dropdown they used.
   */
  check('the o-series takes only three',
    reasoningFor('openai', 'o3-mini').levels.join() === 'low,medium,high',
    reasoningFor('openai', 'o3-mini').levels.join());
  check('and rejects one it does not accept',
    acceptsEffort('openai', 'o3-mini', 'xhigh') === false);

  // A model that does not reason must not be offered the control at all.
  check('gpt-4o has none', reasoningFor('openai', 'gpt-4o').style === 'none');
}

console.log('\n[not offered] where there is no portable control');
{
  for (const [preset, model] of [
    ['nvidia', 'nvidia/nemotron-3-super-120b-a12b'],
    ['deepseek', 'deepseek-reasoner'],
    ['deepseek', 'deepseek-chat'],
    ['ollama', 'llama3.3'],
    ['lmstudio', 'anything'],
    ['groq', 'llama-3.3-70b'],
  ]) {
    check(`${preset} offers nothing`, reasoningFor(preset, model).style === 'none');
  }

  // Unset is always valid: it means "whatever the provider does by default".
  check('unset is accepted anywhere', acceptsEffort('nvidia', 'anything', undefined));
}

console.log('\n[anthropic] an enum on the outside, a budget on the wire');
{
  const support = reasoningFor('anthropic', 'claude-opus-5');
  check('it is a budget, not an effort', support.style === 'budget');
  check('with three levels', support.levels.join() === 'low,medium,high');

  /*
   * And the panel says so. "High" secretly meaning a token count is not
   * something to leave somebody to discover from a bill.
   */
  check('and the note says it is tokens', /token budget/.test(support.note ?? ''),
    support.note);
  check('the budgets rise', THINKING_BUDGETS.low < THINKING_BUDGETS.medium &&
    THINKING_BUDGETS.medium < THINKING_BUDGETS.high);
}

console.log('\n[the wire] each API in its own shape');
{
  const responses = fs.readFileSync(
    path.join(repo, 'packages/llm/src/openai-responses.ts'),
    'utf8',
  );
  const compatible = fs.readFileSync(
    path.join(repo, 'packages/llm/src/openai-compatible.ts'),
    'utf8',
  );
  const anthropic = fs.readFileSync(path.join(repo, 'packages/llm/src/anthropic.ts'), 'utf8');

  // The Responses API nests it; chat-completions does not.
  check('Responses nests it', /reasoning: \{ effort: request\.reasoningEffort \}/.test(responses));
  /*
   * And checks the model before sending, because the accepted values differ
   * between OpenAI's own families.
   */
  check('and checks the model first',
    /acceptsEffort\('openai', this\.config\.model, request\.reasoningEffort\)/.test(responses));

  /*
   * Everything OpenAI-compatible arrives through one adapter, including
   * Ollama and LM Studio, and a strict local server rejects a whole request
   * over an unknown field rather than ignoring it. So it is sent only where
   * the endpoint is known to take it.
   */
  check('the compatible adapter is selective',
    /openrouter\.ai/.test(compatible), 'it would send the field to any endpoint');

  check('Anthropic sends a budget', /budget_tokens: budget/.test(anthropic));
  /*
   * And raises the ceiling to fit it: Anthropic rejects a request whose
   * budget is not comfortably below max_tokens, and the caller's 4096
   * default would not fit a 32k budget at all.
   */
  check('raising max_tokens to fit', /Math\.max\(request\.maxTokens \?\? 4096, budget/.test(anthropic));
}

console.log('\n[carried] the setting reaches the request');
{
  const agent = fs.readFileSync(path.join(repo, 'packages/core/src/agent.ts'), 'utf8');
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');

  check('the agent sends it', /reasoningEffort: this\.reasoningEffort/.test(agent));
  check('the engine supplies it', /reasoningEffort: agent\.reasoningEffort/.test(engine));

  /*
   * And a change must rebuild the session. It is held on the live Agent, so
   * a cached one would keep answering at the level it was built with —
   * which looks exactly like the setting not working.
   */
  check('a change rebuilds the session',
    /effort: agent\.reasoningEffort \?\? ''/.test(engine),
    'the fingerprint ignores it, so a cached session keeps the old level');
}

console.log('\n[the panel] the control appears only where it works');
{
  const panels = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/Panels.tsx'), 'utf8');

  check('gated on support', /reasoning\.style !== 'none' && \(/.test(panels));
  check('offering the provider default', /Provider default/.test(panels));
  /*
   * And a level the NEW pairing does not accept is dropped when the model
   * changes. Moving an agent from gpt-5 to the o-series would otherwise
   * leave `xhigh` set, and the failure would arrive on the next message
   * with nothing on screen to explain it.
   */
  check('and dropping a level the new model refuses',
    /!reasoning\.levels\.includes\(reasoningEffort\)/.test(panels));
  check('it is saved', /reasoningEffort: reasoningEffort \|\| undefined/.test(panels));
}

console.log('\n[the model field] a list, not a search box wearing a costume');
{
  /*
   * Reported as: "I had to wipe the text so all models appeared, like a
   * searchbox not an actual dropdown". It was an `<input list=…>` combo
   * box, prefilled with the current model — so it filtered its own
   * suggestions down to that one entry and looked empty.
   */
  const panels = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/Panels.tsx'), 'utf8');
  const picker = fs.readFileSync(
    path.join(repo, 'apps/desktop/src/renderer/ModelPicker.tsx'),
    'utf8',
  );

  check('no combo boxes remain', !/list="[a-z-]*model/.test(panels), 'a datalist survives');
  check('no stray datalists', !/<datalist/.test(panels));
  check('all three fields use one picker',
    (panels.match(/<ModelPicker/g) ?? []).length === 3,
    String((panels.match(/<ModelPicker/g) ?? []).length));

  // The escape hatch is an explicit choice, not a hidden behaviour: a model
  // released this week must stay reachable without a release of this app.
  check('with an explicit Custom option', /Custom…/.test(picker));
  check('that reveals a text field', /if \(custom\) \{/.test(picker));
  // And a way back, or arriving there by accident is a worse trap.
  check('and a way back to the list', /Choose from the list instead/.test(picker));
}

console.log('');
if (failures) {
  console.error(`REASONING TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('REASONING TEST PASSED\n');
