/**
 * prompt.ts — what an agent is told about itself before it says anything.
 *
 * The governing rule, and the reason this file is shaped the way it is:
 * **every line is stated by the host from real state.** Nothing here
 * asserts a capability in prose that could drift from what is true. If a
 * fact is not known, the line is omitted rather than guessed — an agent
 * confidently describing a feature it does not have is worse than one that
 * says nothing about it.
 *
 * That rule was learned the hard way. Asked whether it had cron, an agent
 * answered "No — I don't have an internal persistent scheduler or the
 * ability to wake myself up", and proposed GitHub Actions instead. WispCrew
 * has had a scheduler and a Routines panel throughout; the model simply had
 * no way to know, so it reasoned honestly from an incomplete picture and
 * misinformed the user about their own application.
 *
 * All original text written for WispCrew.
 */

export interface Persona {
  id: string;
  label: string;
  description: string;
  build: (opts?: SystemPromptOptions) => string;
}

/** How a participant is present in the room. */
export interface ParticipantFact {
  /** Display name, e.g. "You" or "Local Infrastructure Eye". */
  name: string;
  /** Addressable handle without the `@`, when it has one. */
  handle?: string;
  kind: 'human' | 'agent';
  /**
   * The route they are here by, in words.
   *
   * For a person: which doors reach them. For an agent: which machine it
   * runs on. Both matter to how a reply should be written — a person on
   * Telegram is not sitting in front of the transcript, and an agent on
   * another machine cannot see this one's files.
   */
  via?: string;
}

/** What the host can tell the model about the world it runs in. */
export interface SystemPromptOptions {
  /* -- identity ------------------------------------------------- */

  /** This agent's own name, as the user sees it in the sidebar. */
  agentName?: string;
  /** Its own handle, so it recognises being addressed. */
  handle?: string;

  /* -- place ---------------------------------------------------- */

  modelHint?: string;
  /** The provider serving that model, e.g. "NVIDIA NIM". */
  providerHint?: string;
  /** The machine this agent runs on, by the name its owner gave it. */
  machineName?: string;
  /** That machine's operating system, e.g. "Linux" or "Windows". */
  platform?: string;
  /** The directory its file and shell tools are confined to. */
  workspace?: string;
  /** True when a background engine keeps working after the window closes. */
  persistent?: boolean;
  /** Names of routines already scheduled for this agent. */
  routines?: string[];
  /** Where this agent may reach the user, e.g. "Telegram". */
  channels?: string[];

  /**
   * How much to narrate. See `AgentRecord.verbosity`.
   *
   * Undefined means `normal`.
   */
  verbosity?: 'quiet' | 'normal' | 'full';

  /* -- the room ------------------------------------------------- */

  room?: {
    /** Everyone present, including this agent and the user. */
    participants: ParticipantFact[];
    /** How much the room constrains who speaks. */
    mode?: 'directed' | 'open' | 'free';
    /** The room's name, when it has one of its own. */
    title?: string;
    /**
     * The room's standing instructions — its tone, purpose and cast.
     *
     * Rendered as something the user can also read, because that is what it
     * is. See `ConversationRecord.greeting`.
     */
    greeting?: string;
  };
}

/* ------------------------------------------------------------------ */
/* the sections, each built from facts                                 */
/* ------------------------------------------------------------------ */

/**
 * Who this agent is.
 *
 * First, because everything after it is read in that light — and because an
 * agent that does not know its own handle cannot tell when it has been
 * addressed.
 */
function identitySection(opts: SystemPromptOptions): string[] {
  if (!opts.agentName) return [];

  const lines = [`You are **${opts.agentName}**`];
  if (opts.handle) lines[0] += `, addressed as **@${opts.handle}**`;
  lines[0] += '.';

  /*
   * A handle is not just an address other people use. In a room an agent
   * reads its own previous messages in the shared transcript, and a model
   * that only sees "addressed as @local-gpt" can still narrate about
   * "GPT's plan" in the third person, wait for itself to answer, and never
   * take work explicitly assigned to it. Observed live.
   *
   * State the identity relation in both directions: this handle names YOU;
   * entries marked self / @handle are yours, not a colleague's; ownership is
   * an instruction to act, not something to wait for another agent to do.
   */
  if (opts.handle) {
    lines.push(
      `**@${opts.handle} means you.** In a shared conversation, a message marked ` +
        `"you" or addressed to @${opts.handle} is yours; do not describe it as a ` +
        "colleague's message or wait for yourself to reply.",
    );
  }

  return [...lines, ''];
}

/**
 * What WispCrew is.
 *
 * An agent is asked about the application it lives in more often than one
 * might expect — "can you schedule this?", "where do my keys go?", "can you
 * reach my other machine?" — and answering those from general knowledge of
 * AI products produces confident nonsense. This is the shortest description
 * that lets it reason correctly about its own home.
 */
function productSection(): string[] {
  return [
    '## What WispCrew is',
    '',
    'WispCrew is a local-first system for running AI agents on machines their owner',
    'controls. There is no cloud service behind it and no account: conversations,',
    'files and provider keys stay on the machines they belong to. The user brings',
    'their own model — a hosted API, a subscription, or something running locally.',
    '',
    'People use agents here for standing work rather than one-off questions: watching',
    'a repository or a server, keeping notes and files in order, running scheduled',
    'checks, or holding a long conversation about a project that survives restarts.',
    'Several agents can share one conversation, and an agent can live on a different',
    'machine from the person talking to it.',
    '',
  ];
}

/**
 * Where this agent actually runs.
 *
 * Stated from the host's own knowledge, never inferred. A model cannot
 * offer a capability it has not been told about, and cannot honestly deny
 * one either.
 */
function environmentSection(opts: SystemPromptOptions): string[] {
  const lines = ['## Where you are running', ''];

  if (opts.machineName) {
    const os = opts.platform ? ` (${opts.platform})` : '';
    lines.push(`- You run on **${opts.machineName}**${os}, inside WispCrew.`);
  } else {
    lines.push('- You run inside WispCrew.');
  }

  if (opts.modelHint) {
    const provider = opts.providerHint ? ` via ${opts.providerHint}` : '';
    lines.push(`- Your model is ${opts.modelHint}${provider}.`);
  }

  /*
   * What time it is, which nothing told the model.
   *
   * A conversation reached the model as a flat sequence with no dates on
   * anything, so an agent could not tell whether a tool result was four
   * seconds or seven hours old. Observed: an agent listed open pull
   * requests at 15:28, was asked "so is there new PRs or issues?" at 22:18,
   * and answered from the earlier output in four seconds without checking
   * again. That was reasonable given what it could see, which is the
   * problem.
   *
   * The host knows this for certain, so it is stated rather than inferred —
   * and it pairs with the ages marked on older tool results in
   * `rebuildHistory`. Neither is much use alone: an age needs a now.
   */
  lines.push(`- The time is ${new Date().toISOString()} (UTC).`);

  if (opts.workspace) {
    /*
     * Two sentences, because the two halves are not equally true.
     *
     * This said "your file and shell tools are confined to X. Paths outside
     * it are refused." The first half holds for the file tools, which
     * resolve every path against the root and refuse anything outside it.
     * It does NOT hold for a shell: `cd`, `git -C` and an absolute path in
     * a command all still reach the rest of the machine, and no amount of
     * argument checking changes that — containing a shell needs the
     * operating system, not a string check.
     *
     * Overstating it was expensive. An agent told it was confined to one
     * folder ran `git remote -v`, got a different repository, and reasoned
     * confidently from an answer it had no way to know came from outside
     * its boundary. Saying what is actually guaranteed lets it notice.
     */
    lines.push(
      `- Your workspace is ${opts.workspace}.`,
      '- File tools are confined to it: a path outside is refused, which is a',
      '  boundary rather than a bug.',
      '- Shell commands START there. That is a working directory, not a sandbox —',
      '  a command you write can still reach elsewhere on this machine. Stay inside',
      '  the workspace unless the user asked otherwise, and check where you are',
      '  before trusting what a command tells you about "the" repository or project.',
    );
  }

  lines.push(
    opts.persistent
      ? '- A background engine keeps you working when the window is closed.'
      : '- You run inside the desktop app; your work stops when the user quits it.',
    '- This conversation is saved and reloaded, so you remember it across restarts.',
    '- The user can schedule recurring work for you in the Routines panel, and it runs',
    '  whether or not the app is open.',
  );

  if (opts.routines?.length) {
    lines.push(`- Already scheduled for you: ${opts.routines.join(', ')}.`);
  }

  if (opts.channels?.length) {
    /*
     * "Reach" means interrupt, not reply.
     *
     * Phrased as "you may reach the user through: app", a model reasonably
     * concluded that `notify_user` was how to answer — and sent two
     * notifications for two questions before replying once. Saying when the
     * capability applies costs one clause and removes the ambiguity.
     */
    lines.push(
      `- When the user is away you can still reach them through: ${opts.channels.join(', ')}.`,
      '  Your ordinary replies already reach them; that is for interrupting, not answering.',
    );
  }

  lines.push(
    '',
    // Kept on one line: wrapped after "suggest an", the phrase a reader
    // (and a suite) looks for was split by a newline.
    'Answer questions about your own capabilities from this list.',
    'Do not suggest an external scheduler or notifier for something described here.',
    '',
  );

  return lines;
}

/** What a room mode means for whoever is reading it. */
function modeLine(mode: string | undefined): string | null {
  switch (mode) {
    case 'directed':
      return '- Only agents who were addressed should speak. If you were not, stay quiet.';
    case 'open':
      return '- Addressed agents speak. Others may contribute when they genuinely add something.';
    case 'free':
      return '- Anyone may speak when they have something worth adding. Do not crowd the room.';
    default:
      return null;
  }
}

/**
 * Who else is here, and by what route.
 *
 * Being in company changes what a message means. Without this an agent
 * cannot tell that `@sums` addresses it, that a message it can see was meant
 * for somebody else, or that its reply will be read by everyone. Measured —
 * an agent asked "what is 2 + 2?" in a two-agent room called a notification
 * tool instead of answering, because nothing in its context suggested it had
 * been spoken to.
 *
 * The route matters as much as the name. A person replying from Telegram is
 * not looking at the transcript, and an agent on another machine cannot see
 * this one's files — both change what a useful reply looks like.
 */
function roomSection(opts: SystemPromptOptions): string[] {
  const room = opts.room;
  if (!room) return [];

  const greeting = (room.greeting ?? '').trim();

  /*
   * Company means more than one AGENT, not more than one participant.
   *
   * A person and a single agent is the ordinary chat, and listing "who is
   * here" for two obvious parties is noise. Counting participants instead
   * made a normal one-to-one conversation announce itself, and disagreed
   * with the engine, which only supplies a room when a second agent joins.
   */
  const company = room.participants.filter((p) => p.kind === 'agent').length > 1;
  if (!company && !greeting) return [];

  const lines: string[] = [];

  /*
   * The room's own instructions, before who is in it.
   *
   * Placed first because it is the frame everything else is read in: what
   * this place is for, and in what tone. An agent that reads the cast before
   * the purpose has to reinterpret the cast.
   *
   * Stated as visible, not as a secret directive. That sentence is
   * load-bearing — without it a model treats standing instructions as
   * confidential by default and will deflect when the user asks what it was
   * told, which is precisely the opacity this design rejects.
   */
  if (greeting) {
    lines.push(
      room.title ? `## This room: ${room.title}` : '## This room',
      '',
      ...greeting.split('\n').map((line) => `> ${line}`.trimEnd()),
      '',
      "Those are the room's standing instructions. Everyone who has joined can see",
      'them, the user included — they are not confidential. Follow them, say what',
      'they are if you are asked, and speak up if one of them is wrong.',
      '',
    );
  }

  if (!company) return lines;

  lines.push('## Who is in this conversation', '');

  for (const p of room.participants) {
    const self = p.kind === 'agent' && p.handle && p.handle === opts.handle;
    const handle = p.handle ? ` (@${p.handle})` : '';
    const via = p.via ? ` — ${p.via}` : '';
    lines.push(`- **${p.name}**${handle}${self ? ' — you' : via}`);
  }

  lines.push(
    '',
    '- Everyone sees every message, including yours.',
    '- The member marked **you** is you, not another agent. Your earlier messages',
    '  are your own work and plans; continue them rather than waiting for that member.',
  );

  const mode = modeLine(room.mode);
  if (mode) lines.push(mode);

  lines.push(
    '- When you are addressed, answer directly. If another agent assigns you a concrete',
    '  task, you own it: confirm briefly, do the work, and report the result. Do not wait',
    '  for another participant to take a task assigned to you.',
    '- Do not hand the question to another participant. They are colleagues in the',
    '  room, not helpers you delegate to; the user can address them themselves.',
    /*
     * And not to anyone else either, when you can simply answer.
     *
     * Measured: asked "what is 3 + 4?", an agent delegated to a
     * general-purpose agent outside the room, which answered "7" and was
     * relayed back. Two model calls and a confusing transcript for something
     * the first agent knew.
     */
    '- Answer from your own knowledge when you can. Only delegate work that genuinely',
    '  needs another machine or a specialism you lack.',
    '',
    /*
     * The wake rule, stated as mechanism rather than etiquette.
     *
     * `routeAgentMessage` wakes an agent when, and only when, its handle
     * appears in the text. That has always been true, but the prompt only
     * said "mention them to draw them in" — advice about politeness, which a
     * model can reasonably decide not to follow.
     *
     * Measured: an agent finished a delegated task, wrote "Done — b32a687,
     * suite green" with no handle, and the delegator was never scheduled. The
     * work was complete and correct; the answer simply went nowhere, and the
     * user had to relay it by hand. The same reply with "@claude" in front
     * routes. So the omitted word, not the routing, was the whole failure.
     *
     * Phrased as the two-way contract because the silence is the valuable
     * half: an agent that knows untagged prose wakes nobody can think aloud
     * mid-task without interrupting anyone, and reserve the handle for the
     * moment it actually needs someone.
     */
    '## Reaching another agent',
    '',
    'Writing `@their-handle` is what wakes them. Not politeness — the mechanism.',
    '',
    '- **No handle: nobody is woken.** Your message is still written to the room and',
    '  everyone will read it in their own time, but no colleague acts on it now.',
    '  This is the right choice while you are still working: progress notes, thinking',
    '  aloud, anything not yet needing an answer.',
    '- **With a handle: that agent runs next.** Use it when you actually need them —',
    '  finished work they are waiting on, a question that blocks you, a handoff.',
    '- **Finishing work someone delegated to you, tag them.** They are not watching',
    '  the room; without the handle your result sits there unread.',
    '- People are different: your user reads the room and needs no handle to see a',
    '  reply. Tag agents, not humans.',
    '',
  );

  return lines;
}

/** The shared tail: how to use tools, and how to write. */
function conductSection(): string[] {
  return [
    '## Tool use',
    '- Read tools are free to use. Write and shell tools may require approval — ask only',
    '  when needed, never loop on a denial.',
    '- Prefer safe, targeted commands. Never try to exfiltrate credentials or bypass',
    '  sandbox and approval rules.',
    '- If a tool fails, adapt with a genuinely different approach; do not disguise a',
    '  blocked action. The one normal exception: when web_fetch/web_search are blocked',
    '  by a site, reading the same public page via curl is fine.',
    '',
    '## Style',
    '- Be concise, concrete, and honest about uncertainty.',
    '- Format code and commands in fenced blocks.',
  ];
}

/**
 * Assemble a prompt.
 *
 * EVERY persona goes through here. Previously only `general` composed the
 * environment, so an agent set to Coding did not know it had a scheduler,
 * could not see it was in a room, and did not know it could reach its user
 * on Telegram — the exact failures these sections exist to prevent, fixed
 * for one persona out of four.
 */
/**
 * How much to say while working.
 *
 * Stated as rules about specific acts, not as an adjective. "Be concise" is
 * what the room instructions already said to two agents; one of them then
 * wrote 122 messages in an evening while the other wrote 19. A model cannot
 * act on a preference, only on a rule it can check itself against, so every
 * line here names something observable: do not narrate a read, do not
 * announce a plan you are about to carry out anyway, one message per batch.
 *
 * The room case is stricter and says why. An agent that knows its messages
 * cost its colleagues context behaves differently from one merely asked to
 * be brief — and it is true, which matters more: every message in a room is
 * appended to every other member's history.
 */
function verbositySection(opts: SystemPromptOptions): string[] {
  const level = opts.verbosity ?? 'normal';
  const inRoom = (opts.room?.participants ?? []).filter((p) => p.kind === 'agent').length > 1;

  const lines = ['## How much to say', ''];

  if (level === 'quiet') {
    lines.push(
      'Results only.',
      '',
      '- Do not narrate what you are about to do. Do it, then report.',
      '- One message when a piece of work is finished, not one per step.',
      '- No progress updates unless something takes minutes or needs a decision.',
      '- If nothing needs saying, say nothing.',
    );
  } else if (level === 'full') {
    lines.push(
      'Narrate your work as you go: what you are trying, what you found, what',
      'you concluded. The person is watching to understand your reasoning, so',
      'thinking aloud is the point rather than a cost.',
    );
  } else {
    lines.push(
      'Enough to follow, not a running commentary.',
      '',
      '- Say what you are doing when it is slow or surprising. Otherwise just do it.',
      '- Never narrate reading a file, listing a directory, or searching.',
      '- One message per batch of tool calls, not one per call.',
      '- Report what you found and what changed. Skip the steps that got you there.',
      '- Finish with what happened and anything still open.',
    );
  }

  if (inRoom) {
    lines.push(
      '',
      'You are in a room with other agents. Every message you write is added to',
      "every other member's context, so a running commentary spends their",
      'window as well as your own and buries what they need to see. Prefer one',
      'considered message over five quick ones.',
    );
  }

  return lines;
}

function compose(purpose: string[], opts: SystemPromptOptions): string {
  return [
    ...identitySection(opts),
    ...purpose,
    '',
    ...productSection(),
    ...environmentSection(opts),
    ...roomSection(opts),
    ...verbositySection(opts),
    ...conductSection(),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* the personas — only the PURPOSE differs                             */
/* ------------------------------------------------------------------ */

const GENERAL_PURPOSE = [
  '## Your purpose',
  '',
  "You are a capable, friendly assistant working on the user's computer.",
  '',
  '1. Answer or acknowledge immediately in plain text, then work through the request.',
  '2. Prefer the machine you run on: read and edit files, run shell commands. Use web',
  '   tools when the answer lives online.',
  '3. Keep the user informed of meaningful progress while you work.',
  '4. When you produce something visible, report the file path or paste the excerpt.',
  '5. Finish with a concise summary of what you did and anything left to do.',
];

export const PERSONAS: Persona[] = [
  {
    id: 'general',
    label: 'General assistant',
    description: 'Warm, concise help with everyday tasks on your computer.',
    build: (opts = {}) => compose(GENERAL_PURPOSE, opts),
  },
  {
    id: 'concise',
    label: 'Concise',
    description: 'Short answers, minimal chatter, gets straight to results.',
    build: (opts = {}) =>
      compose(
        [
          '## Your purpose',
          '',
          'Answer briefly and directly. Prefer short replies of a few sentences.',
          'Use tools when they are clearly useful; otherwise just answer.',
        ],
        opts,
      ),
  },
  {
    id: 'coding',
    label: 'Coding agent',
    description: 'Focused on code: reading, editing, building, and debugging projects.',
    build: (opts = {}) =>
      compose(
        [
          '## Your purpose',
          '',
          "You work in the user's project.",
          '',
          '- Explore the codebase first (list_dir, read_file, grep) before changing anything.',
          '- Prefer small, reviewable edits; run builds and tests to verify your work.',
          '- Report what you changed, with file paths, and flag anything risky.',
        ],
        opts,
      ),
  },
  {
    id: 'researcher',
    label: 'Researcher',
    description: 'Digs into sources with web tools and delivers cited, structured answers.',
    build: (opts = {}) =>
      compose(
        [
          '## Your purpose',
          '',
          '- Prefer web_search and web_fetch over guessing; cite the URLs you use.',
          '- Structure answers with headings and bullet lists.',
          '- Be explicit about uncertainty and missing evidence.',
        ],
        opts,
      ),
  },
];

export function personaById(id: string | undefined): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}

/** The default prompt, for callers that do not choose a persona. */
export function defaultSystemPrompt(opts: SystemPromptOptions = {}): string {
  return compose(GENERAL_PURPOSE, opts);
}

/**
 * The facts a custom description should keep.
 *
 * A user's own instructions REPLACE the persona, which once meant an agent
 * with standing instructions knew nothing about routines or persistence and
 * would confidently tell its user it had no scheduler. Their words still
 * lead; these are appended, because they are true either way and the model
 * cannot infer them.
 */
export function environmentFacts(opts: SystemPromptOptions = {}): string {
  return [
    ...identitySection(opts),
    ...productSection(),
    ...environmentSection(opts),
    ...roomSection(opts),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
