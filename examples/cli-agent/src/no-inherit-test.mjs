/**
 * no-inherit-test.mjs — an agent carries its own provider and model.
 *
 * The complaint that caused this: "this inheritance thing makes it unstable.
 * Each agent must explicitly set provider and model from that specific
 * provider, no inheritance, no global setting."
 *
 * ## Why inheritance was worse than it looked
 *
 * Provider and model fell back INDEPENDENTLY —
 * `agent.presetId ?? settings.presetId` and `agent.model ?? settings.model`.
 * In practice the model was set on the agent and the provider was not, so
 * the two arrived from different places and nothing ever compared them: an
 * OpenAI model aimed at NVIDIA, which answers `404 page not found` forever.
 *
 * And the failure MOVED. Changing the provider in Settings silently changed
 * where every inheriting agent sent its requests, so an agent that worked
 * yesterday failed today with nothing about it having been edited. That is
 * the instability; the 404 was only the symptom.
 *
 * Offline: store and migration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgent,
  createNodeCrypto,
  initStore,
  listAgents,
  migrateAgentsToExplicitProvider,
  setHost,
  writeSettings,
} from '@wispcrew/runtime';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-noinherit-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

console.log('\n[required] an agent cannot exist without both');
{
  const cases = [
    ['nothing', {}],
    ['a name only', { name: 'Nameless' }],
    ['a provider but no model', { name: 'Half', presetId: 'openai' }],
    ['a model but no provider', { name: 'Other half', model: 'gpt-5.6-luna' }],
    ['blank strings', { name: 'Blank', presetId: '   ', model: '   ' }],
  ];

  for (const [label, patch] of cases) {
    let threw = '';
    try {
      createAgent(patch);
    } catch (err) {
      threw = String(err.message ?? err);
    }
    check(`${label} is refused`, threw !== '', 'it was created');
  }

  const both = createAgent({ name: 'Proper', presetId: 'openai', model: 'gpt-5.6-luna' });
  check('both together is accepted', both.presetId === 'openai' && both.model === 'gpt-5.6-luna');
  // Trimmed on the way in, because a model name arrived once as
  // "nvidia/...\r" from a deploy script written on Windows.
  const padded = createAgent({ name: 'Padded', presetId: ' openai ', model: ' gpt-5.6-luna ' });
  check('and trimmed', padded.presetId === 'openai' && padded.model === 'gpt-5.6-luna',
    `${padded.presetId} / ${padded.model}`);
}

console.log('\n[migration] records written before the rule keep working');
{
  /*
   * Hand-written in the pre-change shape: this is what a real profile looks
   * like on disk. The whole point is that these agents keep pointing where
   * they already pointed, so the change is invisible to somebody upgrading.
   */
  writeSettings(dir, { presetId: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b' });

  const file = path.join(dir, 'agents.json');
  const now = Date.now();
  const legacy = [
    // Inherits both — the plain case.
    { id: 'a_all', name: 'Inherits everything', createdAt: now, updatedAt: now },
    // Model set, provider inherited — the dangerous case, and the common one.
    {
      id: 'a_model',
      name: 'Model only',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      createdAt: now,
      updatedAt: now,
    },
    // Fully explicit already; must not be touched.
    {
      id: 'a_both',
      name: 'Already explicit',
      presetId: 'chatgpt-subscription',
      model: 'gpt-5.6-terra',
      createdAt: now,
      updatedAt: now,
    },
  ];
  fs.writeFileSync(file, JSON.stringify([...JSON.parse(fs.readFileSync(file, 'utf8')), ...legacy], null, 2));

  const result = migrateAgentsToExplicitProvider();
  const byId = new Map(listAgents().map((a) => [a.id, a]));

  check('the one inheriting both is filled in',
    byId.get('a_all')?.presetId === 'nvidia' &&
      byId.get('a_all')?.model === 'nvidia/nemotron-3-super-120b-a12b');

  // Its own model is kept; only the missing half is supplied.
  check('the one with a model keeps it',
    byId.get('a_model')?.model === 'nvidia/nemotron-3-super-120b-a12b');
  check('and is given the provider it was already using',
    byId.get('a_model')?.presetId === 'nvidia');

  /*
   * The load-bearing one. An agent that had already chosen a subscription
   * must not be dragged onto the global provider — that would change what
   * a working agent runs on, which is the opposite of the intent.
   */
  check('an explicit agent is untouched',
    byId.get('a_both')?.presetId === 'chatgpt-subscription' &&
      byId.get('a_both')?.model === 'gpt-5.6-terra');
  check('and is not reported as filled',
    !result.filled.some((a) => a.id === 'a_both'));

  check('two were filled', result.filled.length === 2, String(result.filled.length));
}

console.log('\n[idempotent] a second run changes nothing');
{
  const before = fs.readFileSync(path.join(dir, 'agents.json'), 'utf8');
  const again = migrateAgentsToExplicitProvider();
  const after = fs.readFileSync(path.join(dir, 'agents.json'), 'utf8');

  check('nothing was filled', again.filled.length === 0, String(again.filled.length));
  // Byte-identical: both hosts run this at startup and either may go first.
  check('and the file is byte-identical', before === after);
}

console.log('\n[flagged, not repaired] a pairing that was already broken');
{
  const file = path.join(dir, 'agents.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  // An OpenAI model with no provider, on a profile whose global provider is
  // NVIDIA. This is the exact shape found on a real machine.
  all.push({ id: 'a_bad', name: 'Crossed wires', model: 'gpt-5.6-terra', createdAt: 1, updatedAt: 1 });
  fs.writeFileSync(file, JSON.stringify(all, null, 2));

  const result = migrateAgentsToExplicitProvider();
  const bad = result.broken.find((b) => b.id === 'a_bad');

  check('it is reported', Boolean(bad));
  check('naming the model and the provider',
    /gpt-5\.6-terra/.test(bad?.why ?? '') && /nvidia/.test(bad?.why ?? ''), bad?.why);

  /*
   * Written down faithfully rather than repaired. Both fixes are plausible
   * — an NVIDIA model, or the OpenAI provider — and they mean entirely
   * different things. Guessing would quietly move an agent to another
   * company's model.
   */
  const stored = listAgents().find((a) => a.id === 'a_bad');
  check('and the values are recorded as they were',
    stored?.model === 'gpt-5.6-terra' && stored?.presetId === 'nvidia',
    `${stored?.presetId} / ${stored?.model}`);
}

console.log('\n[no fallback left] the engine reads the agent, and only the agent');
{
  const raw = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');

  /*
   * Comments stripped first.
   *
   * The file explains at length what the old fallback chain was and why it
   * is gone, quoting it verbatim — so searching the raw text finds the
   * explanation and reports the behaviour as unfixed. A test that punishes
   * the comment for describing the bug it verifies has been written here
   * once before; this is the same trap, avoided.
   */
  const engine = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /*
   * Checked in source because the failure is an ABSENCE. A fallback that
   * came back would be invisible in behaviour until the two halves
   * disagreed, which is exactly how long it took to notice the first time.
   */
  check('no provider fallback', !/presetId \?\? settings\.presetId/.test(engine));
  check('no model fallback', !/model \?\? settings\.model/.test(engine));
  check('the provider comes off the agent', /const presetId = agent\.presetId;/.test(engine));
  check('and so does the model', /model: agent\.model,/.test(engine));

  // A turn for an agent that no longer exists used to proceed on the global
  // settings — a run with no name, on somebody else's provider.
  check('a missing agent stops the turn', /That agent no longer exists/.test(raw));
}

console.log('\n[first run] no provider means no starter agent');
{
  /*
   * A regression this suite exists because of. Both hosts seeded an
   * "Assistant" unconditionally, which was fine while a provider was
   * inherited — and made the daemon refuse to START once one was required.
   * Found by booting against an empty directory; nothing static saw it.
   */
  const serve = fs.readFileSync(path.join(repo, 'apps/daemon/src/serve.ts'), 'utf8');
  const main = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/main.ts'), 'utf8');

  for (const [where, src] of [['the daemon', serve], ['the desktop', main]]) {
    check(`${where} only seeds with a provider and model`,
      /listAgents\(\)\.length === 0 && seed/.test(src) ||
        /listAgents\(\)\.length === 0 && seedPreset && seedModel/.test(src),
      'the seed is still unconditional');
  }
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`NO-INHERIT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('NO-INHERIT TEST PASSED\n');
