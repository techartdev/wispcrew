/**
 * telegram-inbox.ts — receiving, so a phone is a door into the room.
 *
 * Sending was the easy half. This is the half that makes a conversation
 * genuinely reachable from elsewhere: a reply typed on a train arrives as
 * the user's own turn in the same room, not as a message to a side-channel
 * bot with its own memory.
 *
 * ## Long polling, not webhooks
 *
 * A webhook needs a public HTTPS endpoint, which means a domain, a
 * certificate, and a port open to the internet. That is a great deal to ask
 * of someone who wanted to talk to their agent from a phone, and it is
 * exactly the kind of infrastructure this project exists to avoid.
 *
 * `getUpdates` with a long timeout costs one idle connection and works from
 * behind any NAT.
 *
 * ## The offset is the whole correctness story
 *
 * Telegram redelivers an update until it is acknowledged by requesting a
 * higher offset. Lose the offset and every message is processed again on
 * restart — the agent answers a week-old question, or repeats an action it
 * already took. So the offset is persisted before the update is handled,
 * not after: at-most-once is right here, because a message that is missed
 * can be repeated by a human, while one that is acted on twice cannot be
 * undone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileLog } from './filelog.js';

/** How long Telegram holds the connection open with nothing to say. */
const POLL_SECONDS = 25;

/** Backoff after a network failure, so a flapping connection is not a storm. */
const RETRY_MS = 5_000;

export interface InboundMessage {
  /** Telegram's own message id, for editing a placeholder later. */
  messageId: number;
  chatId: string;
  text: string;
  /** Sender's Telegram user id, checked against the configured chat. */
  fromId: string;
  date: number;
}

export interface InboxOptions {
  token: string;
  /** Only this chat is accepted. */
  chatId: string;
  dataDir: string;
  onMessage: (message: InboundMessage) => void | Promise<void>;
  /**
   * A button press on an approval prompt.
   *
   * Returns whether it matched something still waiting, so a stale button
   * can be answered politely rather than ignored.
   */
  onCallback?: (data: string, fromId: string) => boolean;
}

export interface Inbox {
  stop(): void;
}

function offsetPath(dataDir: string): string {
  return path.join(dataDir, 'telegram-offset.json');
}

function readOffset(dataDir: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(offsetPath(dataDir), 'utf8')) as { offset?: number };
    return typeof parsed.offset === 'number' ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

function writeOffset(dataDir: string, offset: number): void {
  try {
    fs.writeFileSync(offsetPath(dataDir), JSON.stringify({ offset }), { mode: 0o600 });
  } catch (err) {
    // If this fails the next poll will redeliver, which is noisy but not
    // dangerous. Worth logging: silent redelivery is baffling to debug.
    fileLog('[telegram] could not persist offset', (err as Error).message);
  }
}

/**
 * Start listening for messages.
 *
 * Runs until stopped. Every failure is transient by assumption — a bot token
 * can be revoked, but the honest response to that is to keep trying and log
 * it, rather than silently stop listening and leave the user wondering why
 * their phone no longer works.
 */
export function startInbox(options: InboxOptions): Inbox {
  let stopped = false;
  let controller: AbortController | null = null;
  let offset = readOffset(options.dataDir);

  const poll = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController();

      try {
        const url =
          `https://api.telegram.org/bot${options.token}/getUpdates` +
          `?timeout=${POLL_SECONDS}&offset=${offset}&allowed_updates=["message","callback_query"]`;

        const response = await fetch(url, {
          signal: controller.signal,
          // Slightly longer than the server's own timeout, so a healthy long
          // poll is never cut short by the client.
          ...{},
        });

        if (!response.ok) {
          // 409 means another poller is running against the same bot.
          // Telegram allows only one, and two would silently steal each
          // other's updates, so it is worth naming rather than retrying
          // blindly.
          if (response.status === 409) {
            fileLog('[telegram] another poller is using this bot; backing off');
          }
          await sleep(RETRY_MS);
          continue;
        }

        const payload = (await response.json()) as {
          ok: boolean;
          result?: TelegramUpdate[];
        };

        for (const update of payload.result ?? []) {
          /*
           * Acknowledge BEFORE handling.
           *
           * Telegram redelivers until the offset moves past an update, so
           * handling first and acknowledging after means a crash mid-turn
           * replays the message on restart — the agent repeats an action it
           * already took. A missed message can be retyped by a human; a
           * repeated one cannot be undone.
           */
          offset = update.update_id + 1;
          writeOffset(options.dataDir, offset);

          /*
           * A button press on an approval prompt.
           *
           * Answered immediately whether or not it matched: Telegram shows a
           * spinner on the button until the query is acknowledged, and a
           * stale prompt that spins forever looks broken.
           */
          if (update.callback_query) {
            const query = update.callback_query;
            const matched =
              options.onCallback?.(query.data ?? '', String(query.from?.id ?? '')) ?? false;

            void fetch(`https://api.telegram.org/bot${options.token}/answerCallbackQuery`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                callback_query_id: query.id,
                text: matched ? 'Recorded.' : 'That request is no longer waiting.',
              }),
            }).catch(() => {
              /* acknowledgement is cosmetic */
            });
            continue;
          }

          const message = update.message;
          if (!message?.text) continue;

          const chatId = String(message.chat?.id ?? '');

          /*
           * Only the configured chat is accepted.
           *
           * A bot token is a bearer credential: anyone who learns the bot's
           * name can message it. Without this check, a stranger's message
           * would become the user's own turn in their room — able to
           * instruct their agents.
           */
          if (chatId !== options.chatId) {
            fileLog('[telegram] ignoring a message from an unexpected chat');
            continue;
          }

          try {
            await options.onMessage({
              messageId: message.message_id,
              chatId,
              text: message.text,
              fromId: String(message.from?.id ?? ''),
              date: message.date ?? Math.floor(Date.now() / 1000),
            });
          } catch (err) {
            // One bad turn must not stop the listener.
            fileLog('[telegram] handling failed', (err as Error).message);
          }
        }
      } catch (err) {
        if (stopped) return;
        // Offline, DNS failure, an aborted long poll — all expected.
        const message = (err as Error).message;
        if (!/abort/i.test(message)) fileLog('[telegram] poll failed', message);
        await sleep(RETRY_MS);
      }
    }
  };

  void poll();

  return {
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keep a process alive for a backoff.
    timer.unref?.();
  });
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number };
  };
  message?: {
    message_id: number;
    text?: string;
    date?: number;
    chat?: { id?: number };
    from?: { id?: number };
  };
}
