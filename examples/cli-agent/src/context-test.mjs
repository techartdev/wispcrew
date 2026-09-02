/**
 * context-test.mjs — knowing how full the context is.
 *
 * The whole transcript is rebuilt and sent on every turn. That is right for
 * an agent meant to hold a long conversation about a project, and it means
 * the request grows until the provider refuses it — arriving as a wall of
 * provider JSON on a turn that worked an hour earlier, with nothing having
 * changed. Nothing counted, warned or trimmed.
 *
 * Two rules this suite exists to hold:
 *
 *  - **Never invent a denominator.** A model this build has not heard of
 *    gets no percentage, because a wrong limit produces false alarm or
 *    false confidence and both get acted on. The same rule the
 *    subscription code follows for Anthropic usage.
 *  - **A measurement is not an estimate.** The provider's own input-token
 *    figure is preferred once a turn has run, and `measured` says which it
 *    was — an estimate quietly presented as a measurement is eventually
 *    trusted for a decision it cannot carry.
 *
 * Offline: pure functions plus a store on a temp directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildContextReport,
  contextWindowFor,
  estimateTokens,
  estimateToolTokens,
} from '@wispcrew/core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\n[estimating] characters into tokens');
{
  check('nothing costs nothing', estimateTokens('') === 0 && estimateTokens(undefined) === 0);
  check('prose is about four characters a token',
    Math.abs(estimateTokens('a'.repeat(400)) - 100) <= 1, String(estimateTokens('a'.repeat(400))));

  /*
   * Code, JSON and paths split far more finely than prose, and
   * under-counting is the dangerous direction: it reports room that is not
   * there. So dense text must cost MORE per character, not less.
   */
  const prose = 'the quick brown fox jumps over the lazy dog and keeps running along';
  const dense = '{"a":1,"b":[2,3],"c":"d/e/f.ts","g":{"h":null}},{"i":true},{"j":0}';
  check('dense text costs more per character',
    estimateTokens(dense) / dense.length > estimateTokens(prose) / prose.length,
    `${estimateTokens(dense)} vs ${estimateTokens(prose)}`);

  // A tool's whole definition goes on the wire, schema included.
  const tools = [{ name: 'shell', description: 'Run a command', parameters: { type: 'object' } }];
  check('tools are counted from what is sent', estimateToolTokens(tools) > 0);
  check('and no tools cost nothing', estimateToolTokens([]) <= 2, String(estimateToolTokens([])));
}

console.log('\n[limits] unknown is a real answer');
{
  check('a known family resolves', contextWindowFor('gpt-5.6-terra') === 400_000,
    String(contextWindowFor('gpt-5.6-terra')));
  // Providers prefix with a vendor path; the model is the last segment.
  check('a vendor-prefixed name resolves',
    contextWindowFor('nvidia/nemotron-3-super-120b-a12b') === 128_000,
    String(contextWindowFor('nvidia/nemotron-3-super-120b-a12b')));

  /*
   * The important one. A model newer than this build, or somebody's own
   * fine-tune, must produce NO number rather than a plausible one.
   */
  check('an unknown model gives no limit',
    contextWindowFor('some-model-invented-next-year') === undefined);
  check('and neither does an empty name', contextWindowFor('') === undefined);
}

console.log('\n[report] no limit means no percentage');
{
  const r = buildContextReport({
    systemPrompt: 'you are a helpful agent',
    messages: [{ content: 'hello there' }],
    model: 'a-model-nobody-has-heard-of',
  });

  check('it still says how much is used', r.used > 0, String(r.used));
  check('but offers no fraction', r.fraction === undefined, String(r.fraction));
  check('and no limit', r.limit === undefined, String(r.limit));
}

console.log('\n[report] the measured number wins');
{
  const parts = {
    systemPrompt: 'x'.repeat(400),
    tools: [{ name: 't', description: 'y'.repeat(200) }],
    messages: [{ content: 'z'.repeat(4000) }],
    model: 'gpt-5.6-terra',
  };

  const estimate = buildContextReport(parts);
  check('an estimate is labelled as one', estimate.measured === false);

  const measured = buildContextReport({ ...parts, measuredInput: 9999 });
  check('the provider figure is used', measured.used === 9999, String(measured.used));
  check('and labelled as measured', measured.measured === true);
  check('the fraction follows it',
    Math.abs((measured.fraction ?? 0) - 9999 / 400_000) < 1e-9, String(measured.fraction));

  /*
   * The parts are scaled to agree with the total. Otherwise the three
   * numbers visibly fail to add up to the one beside them, which reads as
   * a bug in the meter rather than as the estimate it is.
   */
  const sum = measured.systemTokens + measured.toolTokens + measured.messageTokens;
  check('and the breakdown adds up to it', Math.abs(sum - 9999) <= 3, `${sum} vs 9999`);

  // A zero or negative report from a provider is not a measurement.
  const zero = buildContextReport({ ...parts, measuredInput: 0 });
  check('zero is not treated as measured', zero.measured === false);
}

console.log('\n[report] an explicit window beats the table');
{
  /*
   * A self-hosted endpoint serving a familiar model name at a smaller
   * window is exactly the case the table gets wrong, and the only way to
   * know is to be told.
   */
  const r = buildContextReport({
    messages: [{ content: 'hello' }],
    model: 'gpt-5.6-terra',
    limitOverride: 32_000,
  });
  check('the override is used', r.limit === 32_000, String(r.limit));
}

console.log('\n[report] the fraction never exceeds one');
{
  const r = buildContextReport({
    messages: [{ content: 'q' }],
    model: 'gpt-5.6-terra',
    measuredInput: 900_000,
  });
  // A bar wider than its track is a rendering bug waiting to happen.
  check('it is clamped', r.fraction === 1, String(r.fraction));
}

console.log('\n[measured input] the engine records what the provider said');
{
  /*
   * `usage` has been on TranscriptEntry since the beginning and nothing
   * ever wrote it — the same declared-but-unpopulated fault as `authorId`,
   * and with the same consequence: the one number that says how full the
   * context is arrived on every turn and was thrown away.
   */
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');
  check('turn_end is handled', /e\.type === 'turn_end'/.test(engine));
  check('and the input tokens are stored',
    /lastInputTokens: input/.test(engine), 'the provider figure is still discarded');

  /*
   * Kept on the CONVERSATION, because that is the question it answers.
   * Reading it off the last assistant entry would break whenever a turn
   * ended with a tool call rather than prose, which is most long turns.
   */
  const conversation = fs.readFileSync(
    path.join(repo, 'packages/shared/src/conversation.ts'),
    'utf8',
  );
  check('on the conversation record', /lastInputTokens\?: number/.test(conversation));
}

console.log('\n[assembly] it measures what a turn would really send');
{
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');

  /*
   * A meter that measures something adjacent to the request is worse than
   * none, because it is believed. So the report is built beside runPrompt
   * from the same pieces: the same prompt, the same tool registry
   * including MCP, and the history as REBUILT for the model — not the
   * transcript, which also holds tool cards, notices and approval prompts
   * that never go.
   */
  check('the same system prompt builder', /systemPromptFor\(agent, cfg\.persona/.test(engine));
  check('the same MCP tools', /contextForAgent[\s\S]{0,2200}buildMcpTools/.test(engine));
  check('the rebuilt history, not the transcript',
    /contextForAgent[\s\S]{0,2600}rebuildHistory\(store\.loadTranscript/.test(engine));
  check('and the agent\u2019s own window override',
    /limitOverride: agent\.contextWindow/.test(engine));
}

console.log('\n[per agent] a room has one history and an answer for each member');
{
  /*
   * Two agents on the same project can run different models with different
   * windows, so the same forty thousand tokens is a tenth of one and a
   * third of the other. A single figure for the room would be right for at
   * most one member and misleading for the rest.
   */
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');

  check('reports are per agent', /export async function contextForAgent/.test(engine));
  check('and gathered for every member', /export async function getContextReports/.test(engine));
  // The only question anyone asks of several meters is which one is about
  // to become a problem.
  check('ordered fullest first',
    /sort\(\(a, b\) => \(b\.fraction \?\? 0\) - \(a\.fraction \?\? 0\)/.test(engine));
}

console.log('\n[automatic] when, and — more importantly — when not');
{
  const compaction = fs.readFileSync(
    path.join(repo, 'packages/runtime/src/compaction.ts'),
    'utf8',
  );
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');

  check('there is a threshold', /AUTO_COMPACT_FRACTION = 0\.8/.test(compaction));

  /*
   * The rule that matters most, and the one a shipped tool got wrong:
   * Claude Code compacted at ~76K on a 1M-context model because the
   * threshold was computed against an assumed window, discarding history
   * with 92% of the context unused. No known limit, no automatic action.
   */
  check('an unknown window means no automatic action',
    /if \(report\.limit === undefined \|\| report\.fraction === undefined\) return null;/
      .test(compaction),
    'auto-compaction can fire on a guessed window');

  /*
   * And WHERE it runs. Anywhere inside the agent loop would replace the
   * tool results a task in flight is standing on — an agent halfway
   * through a merge would find its recent work summarised. It belongs at
   * the seam between turns, before the next one starts.
   */
  check('it runs before the session is built',
    engine.indexOf('autoCompactIfNeeded') < engine.indexOf('const session = getSession'),
    'compaction happens after the turn has started');

  /*
   * And the live session must be dropped. It holds its own copy of the
   * history in memory and reuses it whenever the fingerprint matches, so
   * rewriting the transcript alone would change nothing about what is
   * actually sent — the compaction would appear to work and save nothing.
   */
  check('and the cached session is dropped',
    /compacted\?\.ok[\s\S]{0,900}clearSession\(agentId\)/.test(engine),
    'the in-memory history would survive the compaction');

  // Housekeeping must never be what stops a turn.
  check('a failure here does not stop the turn',
    /\[compaction\] skipped:/.test(engine));
}

console.log('\n[ui] every class the meter renders exists');
{
  /*
   * The `*-ui` suites exist because a panel that typechecks can still look
   * broken; one caught a modal with no styles at all.
   */
  const tsx = fs.readFileSync(
    path.join(repo, 'apps/desktop/src/renderer/ContextMeter.tsx'),
    'utf8',
  );
  const css = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/styles.css'), 'utf8');

  const used = new Set();
  for (const m of tsx.matchAll(/className=\{?["'`]([^"'`{}]+)/g)) {
    for (const cls of m[1].split(/\s+/)) {
      // A template literal ends the literal part at `${`, leaving a stray
      // `$` on the class name — `context-meter${tone(...)}`. Trimmed rather
      // than matched around, so the base class is still checked.
      const name = cls.replace(/\$$/, '');
      if (name) used.add(name);
    }
  }
  // The interpolated half, which `tone()` returns as a leading-space string.
  for (const m of tsx.matchAll(/' (context-meter-[a-z]+)'/g)) used.add(m[1]);

  const missing = [...used].filter(
    (cls) => !new RegExp(`\\.${cls.replace(/[-]/g, '\\-')}\\b`).test(css),
  );
  check('no class is unstyled', missing.length === 0, missing.join(', '));

  // The bar only exists with a known limit: any width it picked without one
  // would be a claim about how full the context is.
  check('the bar is gated on a known fraction',
    /report\.fraction !== undefined && \(/.test(tsx));
  // And the tilde is the visible difference between the two kinds of number.
  check('an estimate is marked with a tilde', /report\.measured \? '' : '~'/.test(tsx));
}

console.log('');
if (failures) {
  console.error(`CONTEXT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CONTEXT TEST PASSED\n');
