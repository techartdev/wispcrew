/**
 * schedule-host.ts — turning an agent's request into a real routine.
 *
 * The tools know how to ask and what to explain. This knows where routines
 * live and how the scheduler reads them.
 */
import type { ToolContext } from '@wispcrew/shared';
import { setScheduler } from '@wispcrew/tools';
import { describeCron, parseCron } from './cron.js';
import path from 'node:path';
import { fileLog } from './filelog.js';
import { host } from './host.js';
import { refreshNextRunTime } from './scheduler.js';
import { resyncWatches } from './watch-manager.js';
import * as store from './store.js';
import { announceRoutines } from './transcript.js';

/**
 * How many self-scheduled routines one agent may hold.
 *
 * An agent that can schedule itself can also schedule itself badly — a
 * misjudged loop, or a task proposed again each time it is declined. The
 * user approves each recurring one, so this is not the main defence; it is a
 * backstop against an agent quietly accumulating follow-ups nobody reads.
 */
const MAX_SELF_SCHEDULED = 20;

/** Find the agent that owns this tool call, by its workspace. */
function agentFor(ctx: ToolContext) {
  return store
    .listAgents()
    .find((a) => a.workspaceRoot && a.workspaceRoot === ctx.workspaceRoot);
}

function selfScheduledCount(agentId: string): number {
  return store
    .listRoutines(agentId)
    .filter((r) => r.selfScheduled && r.enabled !== false).length;
}

export function installScheduler(): void {
  setScheduler({
    /**
     * Validate, then describe.
     *
     * `describeCron` echoes anything it cannot describe, so on its own it
     * accepted "not a cron" and handed it to the user as though it were a
     * schedule. `parseCron` is the thing that actually rejects, so it runs
     * first and its error is what the agent sees.
     */
    describeCron(cron: string): string {
      parseCron(cron);
      return describeCron(cron);
    },

    async followUp(minutes, prompt, reason, ctx) {
      const agent = agentFor(ctx);
      if (!agent) throw new Error('No agent owns this workspace, so nothing can be scheduled.');

      if (selfScheduledCount(agent.id) >= MAX_SELF_SCHEDULED) {
        throw new Error(
          `This agent already has ${MAX_SELF_SCHEDULED} scheduled items. ` +
            'Remove some before adding more.',
        );
      }

      const runAt = Date.now() + minutes * 60_000;
      const routine = store.createRoutine({
        agentId: agent.id,
        name: reason || `Follow up in ${minutes} min`,
        // A one-shot has no recurrence; the field is kept for display and for
        // records written before `runAt` existed.
        cron: '',
        runAt,
        selfScheduled: true,
        prompt,
        enabled: true,
      });

      refreshNextRunTime(routine.id);
      announceRoutines();
      fileLog('[schedule] follow-up in', String(minutes), 'min for', agent.name);
      return new Date(runAt).toLocaleString();
    },

    async createRoutine(name, cron, prompt, ctx, watch) {
      const agent = agentFor(ctx);
      if (!agent) throw new Error('No agent owns this workspace, so nothing can be scheduled.');

      /*
       * Re-checked here, not merely before the approval card.
       *
       * Approval and creation are separate steps, and a value that changed
       * between them would be a routine the user did not agree to. For a
       * watch that means the path must STILL be inside the workspace: an
       * agent whose workspace moved between the ask and the answer must not
       * end up with a watcher pointed outside it.
       */
      if (watch) {
        const root = agent.workspaceRoot ?? host().defaultWorkspaceRoot;
        const resolved = path.resolve(root, watch.path);
        const inside =
          resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
        if (!inside) {
          throw new Error(`${watch.path} is outside this agent's workspace.`);
        }
      } else {
        describeCron(cron);
      }

      const routine = store.createRoutine({
        agentId: agent.id,
        name,
        // A record carries one trigger or the other; a watch has no cron.
        cron: watch ? '' : cron,
        ...(watch
          ? { watchPath: watch.path, ...(watch.pattern ? { watchPattern: watch.pattern } : {}) }
          : {}),
        prompt,
        selfScheduled: true,
        enabled: true,
      });

      /*
       * A watch needs a watcher, not a next-run time.
       *
       * `refreshNextRunTime` on a routine with no cron would compute
       * nothing and the routine would sit there looking scheduled and never
       * fire — which is exactly how a feature that "exists" turns out not
       * to work.
       */
      if (watch) resyncWatches();
      else refreshNextRunTime(routine.id);

      announceRoutines();
      fileLog('[schedule] routine approved:', name, watch ? `watch ${watch.path}` : cron);
      return routine.id;
    },
  });
}
