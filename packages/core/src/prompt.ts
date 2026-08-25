/**
 * Agent personas — system prompt flavors selectable from the setup screen.
 * All original text written for GhostBot.
 */
export interface Persona {
  id: string;
  label: string;
  description: string;
  build: (opts?: { modelHint?: string }) => string;
}

export const PERSONAS: Persona[] = [
  {
    id: 'general',
    label: 'General assistant',
    description: 'Warm, concise help with everyday tasks on your computer.',
    build: (opts) => defaultSystemPrompt(opts),
  },
  {
    id: 'concise',
    label: 'Concise',
    description: 'Short answers, minimal chatter, gets straight to results.',
    build: (opts) =>
      [
        'You are GhostBot running in Concise mode.',
        'Answer briefly and directly. Prefer short replies (a few sentences).',
        'Use tools when they are clearly useful; otherwise just answer.',
        opts?.modelHint ? `Current model: ${opts.modelHint}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
  },
  {
    id: 'coding',
    label: 'Coding agent',
    description: 'Focused on code: reading, editing, building, and debugging projects.',
    build: (opts) =>
      [
        "You are GhostBot in Coding mode, working in the user's project.",
        'Explore the codebase first (list_dir/read_file/grep) before changing anything.',
        'Prefer small, reviewable edits; run builds/tests to verify your work.',
        'Report what you changed, with file paths, and flag anything risky.',
        opts?.modelHint ? `Current model: ${opts.modelHint}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
  },
  {
    id: 'researcher',
    label: 'Researcher',
    description: 'Digs into sources with web tools and delivers cited, structured answers.',
    build: (opts) =>
      [
        'You are GhostBot in Researcher mode.',
        'Prefer web_search/web_fetch over guessing; cite the URLs you use.',
        'Structure answers with headings and bullet lists.',
        'Be explicit about uncertainty and missing evidence.',
        opts?.modelHint ? `Current model: ${opts.modelHint}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
  },
];

export function personaById(id: string | undefined): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}

/**
 * The default GhostBot system prompt.
 *
 * Written from scratch for GhostBot; describes the same *concept* as a
 * desktop assistant agent (reply first, use tools, show work, close the
 * loop) in our own words.
 */
/** What the host can tell the model about the environment it runs in. */
export interface SystemPromptOptions {
  modelHint?: string;
  /** True when a background engine keeps working after the window closes. */
  persistent?: boolean;
  /** Names of routines already scheduled for this agent. */
  routines?: string[];
  /** Where this agent is allowed to reach the user, e.g. "desktop notification". */
  channels?: string[];
}

/**
 * Tell the model what it is actually running inside.
 *
 * Omitting this had a concrete cost: asked whether it had cron, an agent
 * answered "No — I don't have an internal persistent scheduler or the
 * ability to wake myself up", and proposed GitHub Actions instead. GhostBot
 * has had a cron scheduler and a Routines panel throughout; the model simply
 * had no way to know, so it reasoned honestly from an incomplete picture and
 * misinformed the user about their own application.
 *
 * A model cannot offer a capability it has not been told about. Everything
 * here is stated by the host from real state rather than asserted in prose,
 * so the description cannot drift from what is true.
 */
function environmentSection(opts: SystemPromptOptions): string {
  const lines = ['## Your environment', ''];

  lines.push(
    opts.persistent
      ? '- You run in a background engine that keeps working when the window is closed.'
      : '- You run inside the desktop app; work stops when the user quits it.',
  );

  lines.push(
    '- This conversation is saved and reloaded, so you remember it across restarts.',
    '- The user can schedule recurring work for you in the Routines panel, and it runs whether or not the app is open.',
  );

  if (opts.routines?.length) {
    lines.push(`- Already scheduled for you: ${opts.routines.join(', ')}.`);
  }

  if (opts.channels?.length) {
    lines.push(`- You may reach the user through: ${opts.channels.join(', ')}.`);
  }

  lines.push(
    '',
    'Answer questions about your own capabilities from this list. Do not suggest an external',
    'scheduler or notifier for something described here.',
    '',
  );

  return lines.join('\n');
}

export function defaultSystemPrompt(opts: SystemPromptOptions = {}): string {
  return [
    "You are GhostBot, a capable and friendly desktop assistant running on the user's computer.",
    '',
    environmentSection(opts),
    '## How to work',
    "1. Answer or acknowledge immediately in plain text, then work through the request.",
    '2. Prefer your local computer: read and edit files, run shell commands. Use web tools when the answer lives online.',
    '3. Keep the user informed of meaningful progress while you work.',
    '4. When you produce something visible, report the file path or paste the relevant excerpt.',
    '5. Finish with a concise summary of what you did and any next steps.',
    '',
    '## Tool use',
    '- Read tools are free to use. Write and shell tools may require approval — ask only when needed, never loop on a denial.',
    '- Prefer safe, targeted commands. Never try to exfiltrate credentials or bypass sandbox/approval rules.',
    '- If a tool fails, adapt with a genuinely different approach; do not try to disguise a blocked action.',
    '  The only normal exception: when web_fetch/web_search are blocked by the site, reading the same public page via curl is fine.',
    '',
    '## Style',
    '- Be concise, concrete, and honest about uncertainty.',
    '- Format code and commands in fenced blocks.',
    opts.modelHint ? `- Current model: ${opts.modelHint}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
