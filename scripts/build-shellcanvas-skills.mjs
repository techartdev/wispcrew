/**
 * build-shellcanvas-skills.mjs — turn ShellCanvas SKILL.md files into builtin skills.
 *
 * ShellCanvas publishes three portable SKILL.md entrypoints for building its
 * apps, adapters and packages. They are written once, in that project, and
 * converted here rather than retyped: a second hand-written copy is a second
 * source of truth that drifts the day a flag changes, and an agent confidently
 * using a command that no longer exists is worse than having no skill at all.
 *
 * The shape is a TREE, like the CLI skill. A skill's body is spent on every
 * invocation whether it was needed or not, so the overview stays small and each
 * `##` section becomes a node the agent reads with `read_skill` only when it
 * applies. The checks at the bottom fail the build if that stops being true.
 *
 *   node scripts/build-shellcanvas-skills.mjs                    # from GitHub
 *   node scripts/build-shellcanvas-skills.mjs --source <dir>     # from a checkout
 *
 * Output is written straight into packages/runtime/src/generated/, which is
 * what builtin-skills.ts imports and what ships. There is no second copy to
 * keep in step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The skills to convert, in the order they should be seeded. */
const SKILLS = ['shellcanvas-app', 'shellcanvas-adapter', 'shellcanvas-package'];

const RAW =
  'https://raw.githubusercontent.com/techartdev/ShellCanvas/main/skills';

const sourceArg = process.argv.indexOf('--source');
const source = sourceArg === -1 ? null : process.argv[sourceArg + 1];
if (sourceArg !== -1 && !source) throw new Error('--source needs a directory');

async function load(name) {
  if (source) {
    return fs.readFileSync(path.join(source, name, 'SKILL.md'), 'utf8');
  }
  const response = await fetch(`${RAW}/${name}/SKILL.md`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status} from ${RAW}`);
  return await response.text();
}

/**
 * Frontmatter, then the prose before the first `##`, then one node per `##`.
 *
 * The first sentence of a section is its index description — written to be read
 * on its own, because that is the only thing the agent sees when choosing
 * whether a section is worth spending tokens on.
 */
function parse(name, text) {
  const normalised = text.replace(/\r\n/g, '\n');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(normalised);
  if (!frontmatter) throw new Error(`${name}: no frontmatter`);

  const field = (key) => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter[1]);
    if (!match) throw new Error(`${name}: frontmatter has no ${key}`);
    return match[1].trim();
  };

  const rest = normalised.slice(frontmatter[0].length);
  const parts = rest.split(/^## /m);
  const body = parts[0].trim();

  const sections = parts.slice(1).map((part) => {
    const newline = part.indexOf('\n');
    const heading = part.slice(0, newline).trim();
    const content = part.slice(newline + 1).trim();
    const sentence = /^[\s\S]*?[.:](?=\s|$)/.exec(content);
    return {
      name: heading
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
      description: (sentence ? sentence[0] : content).replace(/\s+/g, ' ').trim(),
      body: `# ${heading}\n\n${content}`,
    };
  });

  return {
    name: field('name'),
    description: field('description'),
    body,
    sections,
    enabled: true,
  };
}

/** Rough, but the ratio is what matters — the same measure the tree test uses. */
const tokens = (text) => Math.round(String(text).length / 4);

function verify(skill) {
  const problems = [];
  if (skill.name !== skill.name.toLowerCase().replace(/\s+/g, '-'))
    problems.push(`name "${skill.name}" is not an invocation token`);
  if (skill.description.length < 40)
    problems.push('description is too short to trigger on');
  if (skill.sections.length < 5)
    problems.push(`only ${skill.sections.length} sections`);
  if (tokens(skill.body) >= 600)
    problems.push(`overview is ~${tokens(skill.body)} tokens`);

  const index = skill.sections.reduce(
    (total, s) => total + tokens(`${s.name} — ${s.description}`),
    0,
  );
  const always = tokens(skill.body) + index;
  const flat =
    tokens(skill.body) + skill.sections.reduce((total, s) => total + tokens(s.body), 0);
  if (always * 2 >= flat)
    problems.push(`the split saves too little: ~${always} vs ~${flat} tokens`);

  for (const section of skill.sections) {
    if (!/^[a-z0-9-]+$/.test(section.name))
      problems.push(`section name "${section.name}" is not addressable`);
    if (section.description.length <= 30)
      problems.push(`section "${section.name}" has no usable description`);
    if (section.body.length <= 50)
      problems.push(`section "${section.name}" is empty`);
  }

  if (problems.length)
    throw new Error(`${skill.name}:\n  - ${problems.join('\n  - ')}`);

  return { always, flat };
}

const out = path.join(repo, 'packages/runtime/src/generated');
fs.mkdirSync(out, { recursive: true });

for (const name of SKILLS) {
  const skill = parse(name, await load(name));
  if (skill.name !== name)
    throw new Error(`${name}: frontmatter declares "${skill.name}"`);

  const { always, flat } = verify(skill);

  // Written as a file rather than to stdout: PowerShell's `>` re-encodes as
  // UTF-16 with a BOM, producing a file that looks right and will not parse.
  fs.writeFileSync(
    path.join(out, `${name}.json`),
    `${JSON.stringify(skill, null, 2)}\n`,
    'utf8',
  );

  console.error(
    `wrote ${name}.json — ${skill.sections.length} sections, ` +
      `~${always} tokens loaded vs ~${flat} flat`,
  );
}
