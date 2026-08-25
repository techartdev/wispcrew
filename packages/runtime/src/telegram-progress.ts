/**
 * telegram-progress.ts — showing work in a medium with no streaming.
 *
 * The desktop shows tokens arriving. Telegram has no such concept: a
 * five-minute turn would be five minutes of silence, and a user reasonably
 * concludes their agent is broken.
 *
 * So a placeholder is sent as soon as work begins and EDITED as it
 * progresses, then replaced by the final answer. The user sees "Working…",
 * then the tools being run, then the reply — in one message that never
 * scrolls away.
 *
 * ## Rate limits shape this
 *
 * Telegram throttles edits to roughly one every few seconds per message, and
 * exceeding it returns 429 with a retry delay. An agent making twenty tool
 * calls in ten seconds would trip that immediately, so updates are coalesced:
 * the latest state is remembered and sent when the window opens, rather than
 * queueing every intermediate step. Nobody needs to see a tool that already
 * finished.
 */
import { fileLog } from './filelog.js';

/** Minimum gap between edits to one message. */
const EDIT_INTERVAL_MS = 3_000;

export interface ProgressOptions {
  token: string;
  chatId: string;
  /** Name shown above the work, so a room with several agents is readable. */
  agentName: string;
}

export interface Progress {
  /** Note that a tool is running. Coalesced; safe to call constantly. */
  step(label: string): void;
  /** Replace the placeholder with the finished answer. */
  finish(text: string): Promise<void>;
  /** Abandon it, leaving a short explanation in place. */
  fail(reason: string): Promise<void>;
}

/**
 * Escape Telegram's MarkdownV2 metacharacters.
 *
 * Duplicated from the delivery channel rather than shared, because the two
 * have different lifetimes and this one must never throw — a progress update
 * that fails to format should degrade, not abort a turn.
 */
function escape(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

async function call(token: string, method: string, body: unknown): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${method} returned ${response.status}`);
  return response.json();
}

/**
 * Begin showing progress.
 *
 * Returns immediately with a handle; the placeholder is sent in the
 * background so a turn never waits on Telegram to start.
 */
export function startProgress(options: ProgressOptions): Progress {
  let messageId: number | null = null;
  let sending: Promise<void>;

  const steps: string[] = [];
  let lastEdit = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const header = `*${escape(options.agentName)}*`;

  sending = (async () => {
    try {
      const result = (await call(options.token, 'sendMessage', {
        chat_id: options.chatId,
        text: `${header}\n_Working…_`,
        parse_mode: 'MarkdownV2',
        // The placeholder should not buzz a phone; the answer will.
        disable_notification: true,
      })) as { result?: { message_id?: number } };
      messageId = result.result?.message_id ?? null;
    } catch (err) {
      // No placeholder is a cosmetic loss, not a failed turn.
      fileLog('[telegram] placeholder failed', (err as Error).message);
    }
  })();

  const render = (): string => {
    // The last few steps only: a long build would otherwise exceed the
    // message limit, and the earlier steps are the least interesting.
    const recent = steps.slice(-6).map((s) => `\\- ${escape(s)}`);
    return `${header}\n${recent.join('\n')}`;
  };

  const flush = async (): Promise<void> => {
    pending = null;
    if (finished || messageId === null) return;

    lastEdit = Date.now();
    try {
      await call(options.token, 'editMessageText', {
        chat_id: options.chatId,
        message_id: messageId,
        text: render(),
        parse_mode: 'MarkdownV2',
      });
    } catch (err) {
      /*
       * Edits fail for dull reasons — the text was identical, or the rate
       * limit was hit anyway. Neither is worth interrupting a turn for, and
       * the final answer is sent separately regardless.
       */
      fileLog('[telegram] progress edit skipped', (err as Error).message);
    }
  };

  return {
    step(label: string) {
      if (finished) return;
      steps.push(label);

      /*
       * Coalesce rather than queue.
       *
       * Twenty tool calls in ten seconds would trip Telegram's limit
       * instantly if each were an edit. The latest state is what matters —
       * nobody needs to watch a tool that has already finished — so a
       * pending edit is left to pick up whatever has accumulated.
       */
      if (pending) return;

      const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - lastEdit));
      pending = setTimeout(() => void flush(), wait);
      pending.unref?.();
    },

    async finish(text: string) {
      finished = true;
      if (pending) clearTimeout(pending);
      await sending;

      const body = `${header}\n${escape(text)}`.slice(0, 4096);

      // Editing the placeholder keeps the conversation to one message per
      // turn, which is what makes a phone readable.
      if (messageId !== null) {
        try {
          await call(options.token, 'editMessageText', {
            chat_id: options.chatId,
            message_id: messageId,
            text: body,
            parse_mode: 'MarkdownV2',
          });
          return;
        } catch (err) {
          fileLog('[telegram] final edit failed, sending instead', (err as Error).message);
        }
      }

      // No placeholder, or the edit failed: the answer still has to arrive.
      try {
        await call(options.token, 'sendMessage', {
          chat_id: options.chatId,
          text: body,
          parse_mode: 'MarkdownV2',
        });
      } catch (err) {
        fileLog('[telegram] could not deliver the answer', (err as Error).message);
      }
    },

    async fail(reason: string) {
      await this.finish(`Could not finish: ${reason}`);
    },
  };
}
