/**
 * skill.ts — read one section of a skill, on demand.
 *
 * A skill worth writing is usually too long to inject whole. Everything in
 * its body is spent on every invocation whether it was needed or not, so a
 * thorough reference crowds out the conversation it was meant to help with
 * — the failure is invisible, because the model still answers, just with
 * less room to think in.
 *
 * So a skill is a tree: an overview that is always injected, and sections
 * fetched only when they turn out to matter. This is the fetch.
 *
 * The agent sees section names and one-line descriptions in the overview,
 * which is what it chooses from. That index is small enough to keep and
 * exact enough to pick by.
 */
import type { Tool, ToolContext, ToolResult } from '@wispcrew/shared';

export interface ReadSkillArgs {
  /** The skill's invocation name, e.g. "wispcrew-cli". */
  skill: string;
  /** The section to read, from the index in the skill's overview. */
  section: string;
}

/**
 * Reading is performed by the host.
 *
 * This package has no store. It knows the shape of the request and how to
 * describe it; the host owns the skills and answers.
 */
export type SkillReader = (
  skill: string,
  section: string,
) => Promise<{ found: boolean; body?: string; available?: string[] }>;

/**
 * Null until a host installs one, and then the tool answers honestly rather
 * than pretending the section is missing — "no reader" and "no such
 * section" are different failures and a model should be able to tell them
 * apart.
 */
let reader: SkillReader | null = null;

export function setSkillReader(read: SkillReader): void {
  reader = read;
}

export const readSkillTool: Tool<ReadSkillArgs> = skillTool((skill, section) =>
  reader ? reader(skill, section) : Promise.resolve({ found: false, available: [] }),
);

export function skillTool(read: SkillReader): Tool<ReadSkillArgs> {
  return {
    definition: {
      name: 'read_skill',
      description:
        'Read one section of a skill you have been given. Use it when the ' +
        'skill lists a section covering what you are being asked about. Never ' +
        "guess at a section's contents — the reason they exist is that they " +
        'are exact.',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'The skill name, as written in the skill you were given.',
          },
          section: {
            type: 'string',
            description: "A section name from that skill's list.",
          },
        },
        required: ['skill', 'section'],
      },
    },

    /*
     * No approval gate. A skill section is documentation the user wrote and
     * already gave this agent; asking permission to finish reading it would
     * make the tree cost more than the flat body it replaced, and the whole
     * point is that splitting a skill should be free.
     */
    async run(args: ReadSkillArgs, _ctx: ToolContext): Promise<ToolResult> {
      const { skill, section } = args ?? ({} as ReadSkillArgs);

      const fail = (content: string): ToolResult => ({
        id: '',
        name: 'read_skill',
        ok: false,
        content,
      });

      if (!skill || !section) {
        return fail('read_skill needs both a skill name and a section name.');
      }

      const result = await read(skill, section);

      if (!result.found) {
        /*
         * A miss names what IS there.
         *
         * Otherwise a model that misremembers a section name has no way back
         * except guessing again, and the usual next move is to invent the
         * content it was looking for.
         */
        const available = result.available?.length
          ? `\n\nSections in "${skill}":\n${result.available.map((s) => `- ${s}`).join('\n')}`
          : `\n\nNo skill called "${skill}" is available to you.`;

        return fail(`No section "${section}" in "${skill}".${available}`);
      }

      return {
        id: '',
        name: 'read_skill',
        ok: true,
        content: result.body ?? '',
      };
    },
  };
}
