/**
 * builtin-skills-test.mjs — every skill WispCrew ships, held to the same shape.
 *
 * `skill-tree-test.mjs` pins the CLI skill and the two bugs that made the tree
 * silently not work. This one is the general case: whatever is in
 * `packages/runtime/src/generated/` must be seeded, must be a tree rather than
 * a wall of text, and must be usable by somebody who is not standing in a
 * particular checkout.
 *
 * That last one is the reason this file exists. The ShellCanvas skills
 * originally pointed at `../../docs/*.md`, which resolves only inside a clone
 * of that repository — so an agent following them from the user's own project
 * read nothing, and invented the rest.
 *
 * Offline: the generated skills and how they are wired in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const generated = path.join(repo, 'packages/runtime/src/generated');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Rough, but the ratio is what matters — the same measure the tree test uses. */
const tokens = (text) => Math.round(String(text).length / 4);

const files = fs.readdirSync(generated).filter((f) => f.endsWith('.json')).sort();
const seed = fs.readFileSync(path.join(repo, 'packages/runtime/src/builtin-skills.ts'), 'utf8');

console.log('\n[wiring] every generated skill is actually shipped');
{
  check('there are generated skills', files.length > 0, `${files.length}`);

  // A skill sitting in generated/ that nothing imports is dead weight that
  // looks like a feature. Both halves are required: the import and the array.
  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    check(`${name}: imported`, seed.includes(`./generated/${file}`));

    const identifier = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const variable = identifier.startsWith('wispcrew') ? 'cliSkill' : identifier;
    check(`${name}: in BUILTIN`, new RegExp(`BUILTIN[\\s\\S]*?\\b${variable}\\b`).test(seed));
  }
}

const skills = files.map((file) => ({
  file,
  skill: JSON.parse(fs.readFileSync(path.join(generated, file), 'utf8')),
}));

console.log('\n[identity] a skill can be invoked and chosen');
{
  const names = new Set();
  for (const { file, skill } of skills) {
    check(`${file}: name is an invocation token`, /^[a-z0-9-]+$/.test(skill.name ?? ''), skill.name);
    check(`${file}: name matches the file`, `${skill.name}.json` === file);
    check(`${file}: name is unique`, !names.has(skill.name), skill.name);
    names.add(skill.name);

    // The description is the only thing a person sees when deciding whether to
    // type /name, and the only thing that makes one skill preferable to another.
    check(`${file}: description is specific`, (skill.description ?? '').length > 40, skill.description);
    check(`${file}: enabled`, skill.enabled === true);
  }
}

console.log('\n[the tree] the trunk stays small and the split pays');
{
  for (const { skill } of skills) {
    const index = (skill.sections ?? []).reduce(
      (total, s) => total + tokens(`${s.name} — ${s.description}`),
      0,
    );
    const always = tokens(skill.body) + index;
    const flat =
      tokens(skill.body) + (skill.sections ?? []).reduce((total, s) => total + tokens(s.body), 0);

    check(`${skill.name}: has sections`, (skill.sections ?? []).length >= 5, `${(skill.sections ?? []).length}`);
    check(`${skill.name}: overview is short`, tokens(skill.body) < 600, `~${tokens(skill.body)} tokens`);
    check(`${skill.name}: the split saves most of the cost`, always * 2 < flat, `~${always} vs ~${flat}`);

    for (const section of skill.sections ?? []) {
      check(`${skill.name}/${section.name}: addressable`, /^[a-z0-9-]+$/.test(section.name), section.name);
      check(`${skill.name}/${section.name}: description is specific`,
        (section.description ?? '').length > 30, section.description);
      check(`${skill.name}/${section.name}: has a body`, (section.body ?? '').length > 50);
    }
  }
}

console.log("\n[portable] usable without standing in somebody else's checkout");
{
  for (const { skill } of skills) {
    const text = [skill.body, ...(skill.sections ?? []).map((s) => s.body)].join('\n');

    // `../../docs/app-sdk.md` resolves in one clone and nowhere else. A skill
    // that references it is silently useless in the project it is used from.
    check(`${skill.name}: no checkout-relative links`, !/\]\(\.\.\//.test(text),
      (/\]\((\.\.\/[^)]*)\)/.exec(text) ?? [])[1]);

    /*
     * Every link that IS present has to be reachable from anywhere. Not every
     * skill has links — a CLI reference is commands, not prose — so this asks
     * that none of them are relative rather than that some of them exist.
     */
    const relative = [...text.matchAll(/\]\(([^)]+)\)/g)]
      .map((match) => match[1].trim())
      .filter((target) => !/^(?:https?:|mailto:|#)/i.test(target));
    check(`${skill.name}: every link target is absolute`, relative.length === 0, relative.join(', '));
  }
}

console.log('\n[generated] not retyped by hand');
{
  const builder = path.join(repo, 'scripts/build-shellcanvas-skills.mjs');
  check('the ShellCanvas builder exists', fs.existsSync(builder));

  if (fs.existsSync(builder)) {
    const source = fs.readFileSync(builder, 'utf8');
    // The builder enforces the same limits, so drift fails at generation time
    // rather than shipping a skill that quietly costs every invocation.
    check('the builder verifies what it writes', source.includes('function verify'));
    check('and refuses a fat trunk', source.includes('tokens(skill.body) >= 600'));
  }
}

console.log('');
if (failures) {
  console.error(`BUILTIN SKILLS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('BUILTIN SKILLS TEST PASSED\n');
