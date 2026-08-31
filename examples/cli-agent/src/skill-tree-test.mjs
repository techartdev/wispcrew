/**
 * skill-tree-test.mjs — a skill is a tree, and the trunk stays small.
 *
 * Everything in a skill's body is spent on every invocation, whether it was
 * needed or not. A thorough reference injected whole crowds out the
 * conversation it was meant to help with, and the failure is invisible: the
 * model still answers, just with less room to think in.
 *
 * So a skill has an overview and sections read on demand. This pins the
 * split, and the two bugs that made it silently not work.
 *
 * Offline: the generated skill and the composition rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const skill = JSON.parse(
  fs.readFileSync(path.join(repo, 'packages/runtime/src/generated/wispcrew-cli.json'), 'utf8'),
);

/** Rough, but the ratio is what matters and it is stable enough to assert. */
const tokens = (text) => Math.round(String(text).length / 4);

console.log('\n[the trunk] the always-loaded part stays small');
{
  const index = skill.sections.reduce((a, s) => a + tokens(`${s.name} — ${s.description}`), 0);
  const always = tokens(skill.body) + index;
  const flat = tokens(skill.body) + skill.sections.reduce((a, s) => a + tokens(s.body), 0);

  check('there are sections at all', skill.sections.length >= 5, `${skill.sections.length}`);
  check('the overview is short', tokens(skill.body) < 600, `~${tokens(skill.body)} tokens`);

  /*
   * The whole point. If splitting saved nothing there would be no reason to
   * have done it, and a future edit that moves material back into the body
   * should fail here rather than quietly cost every turn.
   */
  check('the split saves most of the cost', always * 2 < flat, `~${always} vs ~${flat} tokens`);
}

console.log('\n[the index] a section can be chosen without reading it');
{
  for (const section of skill.sections) {
    check(`${section.name}: has a description`, Boolean(section.description?.trim()));

    // "more about nodes" is not a basis for a decision; the description has
    // to say what is inside well enough to pick by.
    check(`${section.name}: the description is specific`,
      (section.description ?? '').length > 30, section.description);

    check(`${section.name}: has a body`, (section.body ?? '').length > 50);
    check(`${section.name}: name is addressable`, /^[a-z0-9-]+$/.test(section.name), section.name);
  }
}

console.log('\n[generated] it describes the CLI that exists');
{
  /*
   * A hand-written CLI reference is a second source of truth that drifts
   * the day a flag changes, and an agent confidently using a command that
   * no longer exists is worse than one with no skill at all.
   */
  const builder = fs.readFileSync(path.join(repo, 'scripts/build-cli-skill.mjs'), 'utf8');
  check('built from capabilities --json', builder.includes("'capabilities', '--json'"));
  check('and fails if that reports nothing', builder.includes('reported no commands'));

  // Every section body should name real commands.
  const all = skill.sections.map((s) => s.body).join('\n');
  check('sections quote real commands', (all.match(/`wispcrew /g) ?? []).length > 20);
}

console.log('\n[the store] a new field is not silently dropped');
{
  /*
   * `createSkill` builds its record field by field rather than spreading,
   * which keeps unknown keys out of the store — and also means a new field
   * vanishes until it is added. `sections` did: the skill installed with an
   * index promising seven topics and none of them present.
   */
  const store = fs.readFileSync(path.join(repo, 'packages/runtime/src/store.ts'), 'utf8');
  const create = store.slice(store.indexOf('export function createSkill'));
  check('createSkill carries sections', create.slice(0, 900).includes('sections: patch.sections'));
}

console.log('\n[the marker] it is written inside the profile');
{
  /*
   * `readJson`/`writeJson` take a PATH, unlike every other store function,
   * which resolves the profile directory for you. Passing the bare name put
   * the marker in the working directory — so every profile on the machine
   * shared one, the first run claimed the builtin was installed, and no
   * profile ever received it.
   */
  const seed = fs.readFileSync(path.join(repo, 'packages/runtime/src/builtin-skills.ts'), 'utf8');

  check('the marker path is resolved', seed.includes('store.filePathFor(SEEDED_FILE)'));
  check('read uses it', /readJson<string\[\]>\(marker/.test(seed));
  check('write uses it', /writeJson\(marker/.test(seed));
  check('the bare name is never passed', !/(read|write)Json\(SEEDED_FILE/.test(seed));

  // Seeded once, then the user's. A builtin that reappears after being
  // deleted is a bug nobody can work around.
  check('a deleted builtin stays deleted', seed.includes('seeded.includes(skill.name)'));
  check("a user's own skill of that name wins", seed.includes('existing.has(skill.name.toLowerCase())'));
}

console.log('\n[the tool] it is offered only when there is something to read');
{
  // Hard rule 11: a tool that is offered gets used. An agent given
  // `read_skill` with nothing to read will eventually call it, inventing a
  // skill name to try.
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');
  check('registered conditionally', /sections\?\.length[\s\S]{0,120}readSkillTool/.test(engine));

  // And the index tells the model how to open them, because a list of
  // topics with no stated way to read them invites invention.
  check('the index explains how to fetch', engine.includes('read_skill'));
  check('and forbids guessing', engine.includes('Do not guess at'));
}

console.log('');
if (failures) {
  console.error(`SKILL-TREE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('SKILL-TREE TEST PASSED\n');
