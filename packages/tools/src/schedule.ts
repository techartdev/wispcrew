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
import { resolveInRoot } from './workspace.js';
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
  /**
   * 5-field cron: minute hour day-of-month month day-of-week.
   *
   * One of `cron` or `watch` is required, and they are alternatives: a
   * routine is woken by the clock or by a file changing, never both.
   */
  cron?: string;
  /**
   * A path under the agent's workspace to watch instead of a clock.
   *
   * The engine has supported watch-triggered routines for as long as cron
   * ones — `RoutineRecord` carries `watchPath`, the watcher is debounced,
   * and `watch-manager` keeps it in step — but an agent had no way to ask
   * for one. "Tell me when the build output changes" was expressible only
   * as a poll every minute, which is worse in every respect: later, and
   * far more expensive.
   */
  watch?: string;
  /** Only wake for names matching this, e.g. `*.log`. */
  pattern?: string;
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
  createRoutine(
    name: string,
    cron: string,
    prompt: string,
    ctx: ToolContext,
    /** A watch-triggered routine instead of a scheduled one. */
    watch?: { path: string; pattern?: string },
  ): Promise<string>;
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
      'Ask the user to approve recurring work — on a clock, or whenever a ' +
      'file changes. Give EITHER cron (a repeating schedule) OR watch (a ' +
      'path under your workspace to react to), not both. The user must ' +
      'approve before it runs, and can remove it later. For a single ' +
      'check-back, use schedule_follow_up instead.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name, e.g. "Repo watch".' },
        cron: {
          type: 'string',
          description:
            '5-field cron: minute hour day-of-month month day-of-week. Omit if using watch.',
        },
        watch: {
          type: 'string',
          description:
            'A file or folder under your workspace. The routine runs shortly after it ' +
            'changes, instead of on a schedule. Prefer this to polling: it reacts sooner ' +
            'and costs nothing while nothing happens. Omit if using cron.',
        },
        pattern: {
          type: 'string',
          description: 'With watch, only react to names matching this, e.g. "*.log".',
        },
        prompt: { type: 'string', description: 'What to do each time it runs.' },
      },
      required: ['name', 'prompt'],
    },
  },

  async run(args: ProposeRoutineArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!scheduler) {
      return fail('propose_routine', 'unavailable', 'Scheduling is not available here.');
    }

    const name = String(args.name ?? '').trim();
    const cron = String(args.cron ?? '').trim();
    const watch = String(args.watch ?? '').trim();
    const pattern = String(args.pattern ?? '').trim();
    const prompt = String(args.prompt ?? '').trim();

    if (!name || !prompt) {
      return fail('propose_routine', 'incomplete', 'A routine needs a name and a prompt.');
    }

    /*
     * One trigger, not two.
     *
     * A record carries either a cron or a watch path, so accepting both
     * would mean silently ignoring one — and the user would approve a card
     * describing a schedule that is not the whole truth.
     */
    if (cron && watch) {
      return fail(
        'propose_routine',
        'ambiguous',
        'Give either cron or watch, not both: a routine is woken by the clock or by a ' +
          'file changing, never both. Propose two routines if you need both.',
      );
    }
    if (!cron && !watch) {
      return fail(
        'propose_routine',
        'incomplete',
        'A routine needs a trigger: cron for a schedule, or watch for a path to react to.',
      );
    }

    let described: string;
    let watchPath: string | undefined;

    if (watch) {
      /*
       * The watched path is confined to the workspace, like every other
       * path an agent names.
       *
       * This one matters more than most: a routine is open-ended authority,
       * and "watch C:\Users\me\Documents" in an approval card is the sort
       * of thing that gets waved through. Refusing here means the card can
       * only ever describe somewhere the agent already works.
       */
      try {
        watchPath = resolveInRoot(ctx, watch);
      } catch (err) {
        return fail('propose_routine', 'outside_workspace', (err as Error).message);
      }

      described = pattern
        ? `whenever ${watch} changes, for files matching ${pattern}`
        : `whenever ${watch} changes`;
    } else {
      /*
       * Describe the schedule before asking.
       *
       * "0 * * * *" is not something a user should have to decode while
       * deciding whether to grant open-ended authority. An invalid
       * expression fails here rather than being approved and then never
       * firing.
       */
      try {
        described = scheduler.describeCron(cron);
      } catch (err) {
        return fail('propose_routine', 'bad_cron', `That schedule is not valid: ${(err as Error).message}`);
      }
    }

    const approved = await ctx.requestApproval({
      toolName: 'propose_routine',
      summary: `Run "${name}" ${described}`,
      detail:
        `${prompt}\n\n` +
        (watchPath ? `Watching: ${watchPath}\n\n` : '') +
        'This will run on its own, including when the app is closed, until you remove it.',
      payload: { name, cron, watch: watchPath, pattern, prompt, described },
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

    const id = await scheduler.createRoutine(
      name,
      cron,
      prompt,
      ctx,
      watchPath ? { path: watchPath, ...(pattern ? { pattern } : {}) } : undefined,
    );
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
