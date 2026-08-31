/**
 * builtin-skills.ts — skills WispCrew ships with.
 *
 * An agent running inside WispCrew is asked about WispCrew constantly, and
 * answering from general knowledge of AI products produces confident
 * nonsense. The CLI skill is the clearest case: it is right there on PATH,
 * it is how an agent does anything outside its own conversation, and
 * without it the model invents flags.
 *
 * Generated from `wispcrew capabilities --json` by
 * `scripts/build-cli-skill.mjs`, so it cannot describe a CLI that is not
 * there. Regenerate it when commands change; `verify` checks it is current.
 *
 * SEEDED, NOT ENFORCED. It is installed once, then belongs to the user:
 * they may edit it, disable it, or delete it, and none of that is undone on
 * the next launch. A "builtin" that reappears after being deleted is a bug
 * nobody can work around.
 */
import type { SkillRecord } from '@wispcrew/shared';
import * as store from './store.js';
import { fileLog } from './filelog.js';

/** The generated CLI reference, embedded at build time. */
import cliSkill from './generated/wispcrew-cli.json' with { type: 'json' };

interface SeedSkill {
  name: string;
  description: string;
  body: string;
  sections?: { name: string; description: string; body: string }[];
}

const BUILTIN: SeedSkill[] = [cliSkill as SeedSkill];

/**
 * Which builtins have already been offered.
 *
 * Recorded by name so a deleted skill stays deleted. Without this the only
 * way to be rid of a builtin would be to disable it forever, and a user who
 * deletes something expects it to be gone.
 */
const SEEDED_FILE = 'seeded-skills.json';

export function seedBuiltinSkills(): void {
  /*
   * `filePathFor`, because `readJson` and `writeJson` take a PATH, not a
   * name — unlike every other store function, which resolves the profile
   * directory for you.
   *
   * Passing the bare name read and wrote `seeded-skills.json` relative to
   * the working directory, so the marker landed in the repository root. The
   * effect was invisible and total: every profile on the machine shared one
   * marker, the first run claimed the builtin was installed, and no profile
   * ever received it — including brand-new ones created with --data-dir.
   */
  const marker = store.filePathFor(SEEDED_FILE);

  // A missing or unreadable marker means "seed them"; the name check below
  // still prevents a duplicate on a profile that already has one.
  const seeded = store.readJson<string[]>(marker, []);

  const existing = new Set(store.listSkills().map((s) => s.name.toLowerCase()));
  const installed: string[] = [];

  for (const skill of BUILTIN) {
    if (seeded.includes(skill.name)) continue;
    if (existing.has(skill.name.toLowerCase())) {
      // Somebody wrote their own with this name. Theirs wins, and it is
      // marked so this never asks again.
      installed.push(skill.name);
      continue;
    }

    store.createSkill({
      name: skill.name,
      description: skill.description,
      body: skill.body,
      sections: skill.sections,
      enabled: true,
    } as Partial<SkillRecord>);

    installed.push(skill.name);
    fileLog('[skills] installed builtin', skill.name);
  }

  if (installed.length) {
    store.writeJson(marker, [...new Set([...seeded, ...installed])]);
  }
}
