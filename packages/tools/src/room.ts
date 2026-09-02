/**
 * room.ts — let an agent rewrite the room's standing instructions.
 *
 * The greeting is the one piece of content a room owns: its tone, its
 * purpose, and why these particular agents are here. It is already visible
 * to everyone — shown in the room pane, and placed in every member's prompt
 * marked as something the user can read too.
 *
 * Asked to write the workflow it had just proposed, an agent answered "I
 * can't directly edit this room's instructions from the tools available to
 * me" and pasted the text for the user to copy. That was honest and
 * correct, and the wrong division of labour: agreeing what a room is for is
 * exactly the kind of thing the agents in it should be able to record.
 *
 * ## Two constraints this tool exists inside
 *
 * **It needs approval.** Standing instructions shape every future turn of
 * every member, so they are a write with more reach than a file edit. The
 * default policy asks; an agent set to run unattended may do it freely,
 * which is the user's decision to have made.
 *
 * **It is only offered inside a group.** A one-to-one chat has no greeting
 * — the agent's own description is where its standing instructions live —
 * and a tool that is offered gets used, so in that case it is not offered
 * at all rather than being present and always failing.
 */
import type { Tool, ToolContext, ToolResult } from '@wispcrew/shared';

interface RoomInstructionsArgs {
  instructions: string;
}

/**
 * How the host reads and writes the room. Installed by the runtime, which
 * owns conversations; this package knows only the shape of the request.
 */
export interface RoomInstructionsHost {
  /** The room's current instructions, for reporting what changed. */
  current(): string;
  /** Room title, so the approval card names the place being changed. */
  title(): string;
  write(instructions: string): Promise<void> | void;
}

/**
 * Build the tool for ONE room.
 *
 * A factory rather than a module-level host with a setter, because room
 * turns run their agents concurrently: two members answering the same
 * message are two `runPrompt` calls in flight at once, and a routine for a
 * third agent can fire alongside them. A global bound to "the current
 * conversation" would be whichever run set it last — the same class of bug
 * as a shared mutable cwd. Closing over the room removes the question.
 */
export function makeRoomInstructionsTool(host: RoomInstructionsHost): Tool<RoomInstructionsArgs> {
  return {
  definition: {
    name: 'set_room_instructions',
    description:
      "Replace this room's standing instructions — its purpose, tone, and how the agents in " +
      'it divide the work. Everyone in the room can read them, including the user, and they ' +
      'are included in every member\u2019s prompt from the next turn on. Replaces the whole ' +
      'text, so include anything worth keeping. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        instructions: {
          type: 'string',
          description:
            'The complete new instructions. An empty string removes them.',
        },
      },
      required: ['instructions'],
    },
  },

  async run(args: RoomInstructionsArgs, ctx: ToolContext): Promise<ToolResult> {
    const next = String(args.instructions ?? '').trim();
    const current = host.current();

    if (next === current) {
      // Not an error, and not a change either. Saying so stops a model
      // "confirming" the edit by making it again.
      return {
        id: '',
        name: 'set_room_instructions',
        ok: true,
        content: 'The room instructions already say exactly that; nothing was changed.',
      };
    }

    /*
     * The card shows what it will become, not merely that something will
     * change. This rewrites the standing instructions for every member, and
     * approving it blind would be approving a blank cheque.
     */
    const approved = await ctx.requestApproval({
      toolName: 'set_room_instructions',
      summary: `Rewrite the instructions for "${host.title()}"`,
      detail: next
        ? `New instructions:\n\n${next}`
        : 'This would REMOVE the room instructions entirely.',
      payload: { instructions: next },
    });

    if (!approved) {
      return {
        id: '',
        name: 'set_room_instructions',
        ok: false,
        errorCode: 'denied',
        content: 'The user did not approve the change; the instructions are unchanged.',
      };
    }

    await host.write(next);

    return {
      id: '',
      name: 'set_room_instructions',
      ok: true,
      content: next
        ? `The room instructions now read:\n\n${next}`
        : 'The room instructions were removed.',
      data: { previous: current, instructions: next },
    };
  },
  };
}
