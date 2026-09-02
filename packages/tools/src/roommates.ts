/**
 * roommates.ts — who else is here, and are they busy?
 *
 * A room is several agents sharing one conversation, and until now each was
 * blind to the others: it could read what they had SAID, because that is in
 * the transcript, but not whether one was working right now. Asked to wait
 * for a colleague's answer, an agent could only guess — and typically either
 * answered as though the colleague had already replied, or asked the user to
 * go and check.
 *
 * The information existed the whole time. `turns.ts` keeps a durable record
 * per turn with a state and a heartbeat, and `activeTurns()` reports exactly
 * this. No tool exposed any of it.
 *
 * ## Read-only, and no waiting
 *
 * This reports; it does not block. A `wait_for_agent` is the obvious
 * companion and is deliberately absent: two agents each waiting for the
 * other is a deadlock no budget can unwind, and it holds a turn on both
 * sides while it happens.
 *
 * Waiting is already expressible without it. An agent that needs a colleague
 * to go first says so in the room — "@other, tell me when you have the
 * numbers" — and the colleague's reply wakes it, because a reply that names
 * somebody routes to them. That path is bounded by the room's turn budget,
 * which is exactly the protection a blocking call would not have.
 *
 * A factory rather than a global, like the room instructions tool and for
 * the same reason: a room turn runs its members concurrently, so a shared
 * "current room" would be whichever run set it last.
 */
import type { Tool, ToolResult } from '@wispcrew/shared';

export interface Roommate {
  handle: string;
  name: string;
  /** Is a turn of theirs running right now? */
  busy: boolean;
  /** When that turn started, for "working (40s)". */
  since?: number;
}

export interface RoommateHost {
  /** Everyone in the room except the agent asking. */
  others(): Roommate[];
}

function ago(since: number | undefined): string {
  if (!since) return '';
  const seconds = Math.max(1, Math.round((Date.now() - since) / 1000));
  return seconds < 90 ? ` (${seconds}s)` : ` (${Math.round(seconds / 60)}m)`;
}

export function makeCheckAgentsTool(host: RoommateHost): Tool<Record<string, never>> {
  return {
    definition: {
      name: 'check_agents',
      description:
        'See who else is in this room and whether they are working right now. ' +
        'Use it before assuming a colleague has answered, or before repeating a ' +
        'question they may still be working on. It does not wait: to be told when ' +
        'somebody finishes, ask them in the room and their reply will reach you.',
      parameters: { type: 'object', properties: {}, required: [] },
    },

    async run(): Promise<ToolResult> {
      const others = host.others();

      if (others.length === 0) {
        return {
          id: '',
          name: 'check_agents',
          ok: true,
          content: 'Nobody else is in this conversation.',
        };
      }

      const lines = others.map(
        (o) => `@${o.handle} (${o.name}) — ${o.busy ? `working${ago(o.since)}` : 'idle'}`,
      );

      /*
       * The reminder is part of the ANSWER, not the prompt.
       *
       * "Working" invites a poll, and a model that polls burns a turn each
       * time and learns nothing new. Saying what to do instead, here, is the
       * one place it is certain to be read.
       */
      const busy = others.filter((o) => o.busy).length;

      return {
        id: '',
        name: 'check_agents',
        ok: true,
        content:
          lines.join('\n') +
          (busy
            ? '\n\nDo not check again in a loop. If you need an answer from them, say so ' +
              'in the room — their reply will reach you.'
            : ''),
      };
    },
  };
}
