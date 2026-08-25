/**
 * schedule.ts — an agent asking to wake itself up.
 *
 * Two shapes, because they are genuinely different commitments:
 *
 *  - **A follow-up** is one wake-up, soon. "The build takes ten minutes,
 *    I'll look again then." It ends after it fires.
 *  - **A routine** is recurring, indefinite. "Check the repo every hour."
 *    It keeps running until someone stops it.
 *
 * ## Why a routine needs approval and a follow-up does not
 *
 * A follow-up is bounded: one run, soon, and the user is usually still
 * there. Interrupting them to approve it would make the natural thing —
 * "give me a minute and I'll check" — cost more than it is worth.
 *
 * A recurring routine is open-ended authority. It runs unattended, possibly
 * for months, consuming tokens and taking actions nobody is watching. An
 * agent that can quietly grant itself that is an agent that can quietly
 * schedule itself badly: every minute, or a task the user forgot agreeing
 * to. So it goes through the same approval gate as any consequential tool
 * call, and the user sees exactly what they are agreeing to.
 */
import type { Tool, ToolContext, ToolResult } from '@wispcrew/shared';

export interface ScheduleFollowUpArgs {
  /** Minutes from now. */
  minutes: number;
  /** What to do when it fires — written to the agent's own future self. */
  prompt: string;
  /** Short label for the user's list of scheduled work. */
  reason?: string;
}

export interface ProposeRoutineArgs {
  name: string;
  /** 5-field cron: minute hour day-of-month month day-of-week. */
  cron: string;
  prompt: string;
}

/**
 * Scheduling is performed by the host.
 *
 * The tools package has no store and no scheduler; it knows how to ask and
 * how to describe what it is asking for. The host owns the routine records
 * and the timer.
 */
export interface Scheduler {
  followUp(minutes: number, prompt: string, reason: string | undefined, ctx: ToolContext): Promise<string>;
  createRoutine(name: string, cron: string, prompt: string, ctx: ToolContext): Promise<string>;
  /**
   * Human-readable summary of a cron expression, for the approval prompt.
   *
   * Must throw for an expression that cannot run. `describeCron` alone is
   * not enough: it echoes anything it cannot describe, so "not a cron" came
   * back unchanged and a nonsense schedule reached the user as though it
   * were valid — creating a routine that would never fire.
   */
  describeCron(cron: string): string;
}

let scheduler: Scheduler | null = null;

export function setScheduler(next: Scheduler | null): void {
  scheduler = next;
}

/** Bounds on a follow-up: soon enough to be a follow-up, far enough to be useful. */
const MIN_MINUTES = 1;
const MAX_MINUTES = 60 * 24 * 7;

export const scheduleFollowUpTool: Tool<ScheduleFollowUpArgs> = {
  definition: {
    name: 'schedule_follow_up',
    description:
      'Wake yourself up once, later, to continue something. Use when work is ' +
      'in progress elsewhere and you want to check on it — a build running, a ' +
      'deploy settling, a reply you are waiting for. Runs once and then ends. ' +
      'For recurring work, use propose_routine instead.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'How many minutes from now.' },
        prompt: {
          type: 'string',
          description: 'What you should do when you wake up. Write it to your future self.',
        },
        reason: { type: 'string', description: 'Short label shown to the user.' },
      },
      required: ['minutes', 'prompt'],
    },
  },

  async run(args: ScheduleFollowUpArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!scheduler) {
      return fail('schedule_follow_up', 'unavailable', 'Scheduling is not available here.');
    }

    const minutes = Math.round(Number(args.minutes));
    if (!Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
      return fail(
        'schedule_follow_up',
        'bad_delay',
        `A follow-up must be between ${MIN_MINUTES} minute and 7 days from now.`,
      );
    }

    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) {
      return fail('schedule_follow_up', 'empty_prompt', 'A follow-up needs something to do.');
    }

    const when = await scheduler.followUp(minutes, prompt, args.reason?.trim(), ctx);
    return {
      id: '',
      name: 'schedule_follow_up',
      ok: true,
      content: `You will wake up at ${when} to: ${prompt}`,
      data: { when, minutes },
    };
  },
};

export const proposeRoutineTool: Tool<ProposeRoutineArgs> = {
  definition: {
    name: 'propose_routine',
    description:
      'Ask the user to approve recurring work on a schedule — checking ' +
      'something hourly, a daily summary. The user must approve before it ' +
      'runs, and can remove it later. For a single check-back, use ' +
      'schedule_follow_up instead.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name, e.g. "Repo watch".' },
        cron: {
          type: 'string',
          description: '5-field cron: minute hour day-of-month month day-of-week.',
        },
        prompt: { type: 'string', description: 'What to do each time it runs.' },
      },
      required: ['name', 'cron', 'prompt'],
    },
  },

  async run(args: ProposeRoutineArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!scheduler) {
      return fail('propose_routine', 'unavailable', 'Scheduling is not available here.');
    }

    const name = String(args.name ?? '').trim();
    const cron = String(args.cron ?? '').trim();
    const prompt = String(args.prompt ?? '').trim();

    if (!name || !cron || !prompt) {
      return fail('propose_routine', 'incomplete', 'A routine needs a name, a schedule and a prompt.');
    }

    /*
     * Describe the schedule before asking.
     *
     * "0 * * * *" is not something a user should have to decode while
     * deciding whether to grant open-ended authority. An invalid expression
     * fails here rather than being approved and then never firing.
     */
    let described: string;
    try {
      described = scheduler.describeCron(cron);
    } catch (err) {
      return fail('propose_routine', 'bad_cron', `That schedule is not valid: ${(err as Error).message}`);
    }

    const approved = await ctx.requestApproval({
      toolName: 'propose_routine',
      summary: `Run "${name}" ${described}`,
      detail:
        `${prompt}\n\n` +
        'This will run on its own, including when the app is closed, until you remove it.',
      payload: { name, cron, prompt, described },
    });

    if (!approved) {
      return {
        id: '',
        name: 'propose_routine',
        ok: false,
        errorCode: 'declined',
        content: 'The user declined that routine. Do not propose it again unless asked.',
      };
    }

    const id = await scheduler.createRoutine(name, cron, prompt, ctx);
    return {
      id: '',
      name: 'propose_routine',
      ok: true,
      content: `Approved. "${name}" will run ${described}.`,
      data: { routineId: id, cron },
    };
  },
};

function fail(name: string, errorCode: string, content: string): ToolResult {
  return { id: '', name, ok: false, errorCode, content };
}
