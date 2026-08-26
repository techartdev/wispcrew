/**
 * notify.ts — how an agent tells the user something.
 *
 * Without this, an unattended agent's only output is a transcript nobody is
 * reading. A routine that finds a broken build at 3am has, in practice,
 * found nothing.
 *
 * The tool is deliberately narrow. It does not choose channels — the user
 * decides where each agent may reach them, in Settings — and it cannot send
 * to anyone else. It says one thing, to its own owner, through channels
 * already permitted.
 *
 * ## Why it needs no approval
 *
 * Sending a message is not a side effect on the user's machine or data: it
 * is the agent doing the thing it was asked to do, addressed to the person
 * who asked. Gating it behind approval would mean an unattended agent could
 * never report, which defeats the purpose. The control that matters is
 * *which channels are enabled*, and that is the user's setting, not the
 * agent's choice.
 */
import type { Tool, ToolContext, ToolResult } from '@wispcrew/shared';

export interface NotifyArgs {
  summary: string;
  body?: string;
}

/**
 * Delivery is injected by the host.
 *
 * The tool package has no store, no settings and no network stack. The host
 * knows which channels the user permitted and how to reach them; this only
 * knows how to ask.
 */
export type NotifySender = (
  summary: string,
  body: string | undefined,
  ctx: ToolContext,
) => Promise<{ delivered: string[]; skipped?: string }>;

let send: NotifySender | null = null;

export function setNotifySender(sender: NotifySender | null): void {
  send = sender;
}

export const notifyTool: Tool<NotifyArgs> = {
  definition: {
    name: 'notify_user',
    /*
     * Deliberately phrased around when NOT to use it.
     *
     * The first version read "send the user a short message through the
     * channels they have enabled", and models used it to answer questions —
     * calling it twice in a room and then replying once, so the user saw
     * two notifications and one answer for two questions. A reply is
     * already delivered; a notification as well is duplicate and reads as a
     * malfunction. Measured on a real multi-agent conversation.
     */
    description:
      'Interrupt the user when they are NOT watching this conversation: a ' +
      'scheduled task that produced a result, work you finished while they ' +
      'were away, or something urgent enough to wake them for. ' +
      'Do NOT use it to answer or acknowledge a message they just sent — ' +
      'your ordinary reply already reaches them, and a notification on top ' +
      'of it is duplicate. ' +
      'Keep the summary to one line; put detail in the body.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One line. This is all a notification will show.',
        },
        body: {
          type: 'string',
          description: 'Optional detail for channels that can display more.',
        },
      },
      required: ['summary'],
    },
  },

  async run(args: NotifyArgs, ctx: ToolContext): Promise<ToolResult> {
    const summary = String(args.summary ?? '').trim();
    if (!summary) {
      return {
        id: '',
        name: 'notify_user',
        ok: false,
        errorCode: 'empty_summary',
        content: 'A message needs a summary.',
      };
    }

    if (!send) {
      return {
        id: '',
        name: 'notify_user',
        ok: false,
        errorCode: 'no_channels',
        content: 'Messaging is not available in this environment.',
      };
    }

    const result = await send(summary, args.body?.trim() || undefined, ctx);

    /*
     * Report exactly where it went.
     *
     * An agent that believes it notified the user, when in fact every
     * channel was disabled, will not try another way — so "sent" and "queued
     * but nothing is enabled" must be distinguishable to the model, not just
     * to the user.
     */
    if (result.delivered.length === 0) {
      return {
        id: '',
        name: 'notify_user',
        ok: false,
        errorCode: 'no_channels',
        content:
          result.skipped ??
          'No channels are enabled, so the user will not see this. ' +
            'It is recorded in the conversation only.',
      };
    }

    return {
      id: '',
      name: 'notify_user',
      ok: true,
      content: `Sent via ${result.delivered.join(', ')}.`,
      data: { delivered: result.delivered },
    };
  },
};
