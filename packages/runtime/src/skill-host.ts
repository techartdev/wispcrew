/**
 * skill-host.ts — answering `read_skill` from the store.
 *
 * The tools package has no store; it knows the shape of the request. This
 * owns the skills and answers, the same seam `notify-host` and
 * `schedule-host` use.
 */
import { setSkillReader } from '@wispcrew/tools';
import * as store from './store.js';

/** Match on the invocation name, case-insensitively, as `/skill` does. */
function findSkill(name: string) {
  const wanted = name.trim().toLowerCase().replace(/^\//, '');
  return store.listSkills().find((s) => s.enabled && s.name.toLowerCase() === wanted);
}

export function installSkillReader(): void {
  setSkillReader(async (skillName, sectionName) => {
    const skill = findSkill(skillName);

    // No such skill: `available` stays empty, and the tool says so rather
    // than implying the section was the problem.
    if (!skill) return { found: false };

    const wanted = sectionName.trim().toLowerCase();
    const section = skill.sections?.find((s) => s.name.toLowerCase() === wanted);

    if (!section) {
      /*
       * Name what IS there. A model that misremembers a section name
       * otherwise has no way back except guessing again, and the usual next
       * move is to invent the content it was looking for.
       */
      return {
        found: false,
        available: (skill.sections ?? []).map((s) => `${s.name} — ${s.description}`),
      };
    }

    return { found: true, body: section.body };
  });
}
