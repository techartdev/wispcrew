/**
 * channel-telegram.ts — a real DM, delivered by the daemon.
 *
 * This is the only channel that reaches the user when they are nowhere near
 * the machine, which is the point of an agent that works unattended. It is
 * also the first thing in WispCrew that talks to a service outside the
 * user's own computer, so a few things are deliberate:
 *
 *  - **Entirely opt-in.** No token, no channel. Nothing is sent anywhere
 *    unless the user creates a bot and pastes its token.
 *  - **The bot is theirs.** Created through Telegram's @BotFather, owned by
 *    their account. There is no WispCrew service in the middle, nothing to
 *    sign up for, and no third party who can read the messages.
 *  - **Only what the agent says.** The summary and body of a message the
 *    user's own agent produced. No transcripts, no telemetry, no keys.
 *
 * Chosen over email or a webhook because it needs no server, no domain and
 * no SMTP credentials — a user with a phone can be receiving messages in
 * about two minutes.
 */
import type { ChannelDeliverer, OutboundMessage } from './channels.js';
import { fileLog } from './filelog.js';

export interface TelegramConfig {
  /** Bot token from @BotFather. */
  token: string;
  /** Chat to deliver to — the user's own chat with their bot. */
  chatId: string;
}

/** Telegram rejects messages above this; longer bodies are trimmed. */
const MAX_MESSAGE = 4096;

/**
 * Build the message text.
 *
 * The agent's name leads, because a user with several agents needs to know
 * which one is speaking before reading anything else.
 */
function formatMessage(message: OutboundMessage): string {
  const parts = [`*${escapeMarkdown(message.agentName)}*`, escapeMarkdown(message.summary)];
  if (message.body) parts.push('', escapeMarkdown(message.body));

  const text = parts.join('\n');
  if (text.length <= MAX_MESSAGE) return text;

  // Trim the body rather than dropping the message: a truncated report still
  // tells the user something happened and to go and look.
  return `${text.slice(0, MAX_MESSAGE - 40)}\n\n…(truncated)`;
}

/**
 * Escape Telegram's MarkdownV2 metacharacters.
 *
 * Agent output routinely contains underscores, brackets and backticks — file
 * paths, code, issue references. Unescaped, Telegram rejects the whole
 * message with a parse error, so a report about a build failure would simply
 * never arrive.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Deliver through the Telegram Bot API.
 *
 * Network trouble returns false so the message stays queued; a rejection
 * from Telegram itself throws, because retrying a malformed chat id or a
 * revoked token forever would block everything behind it.
 */
export function telegramChannel(config: TelegramConfig): ChannelDeliverer {
  return {
    id: 'telegram',
    async deliver(message: OutboundMessage): Promise<boolean> {
      const url = `https://api.telegram.org/bot${config.token}/sendMessage`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.chatId,
            text: formatMessage(message),
            parse_mode: 'MarkdownV2',
            disable_notification: false,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        // Offline, DNS failure, timeout — all temporary by nature.
        fileLog('[telegram] deferred:', (err as Error).message);
        return false;
      }

      if (response.ok) return true;

      const detail = await response.text().catch(() => '');

      /*
       * 5xx and 429 are Telegram having a moment; keep the message queued.
       * 4xx means this will never work as sent — a wrong chat id, a token
       * that was revoked — and must not be retried indefinitely.
       */
      if (response.status >= 500 || response.status === 429) {
        fileLog('[telegram] deferred:', String(response.status));
        return false;
      }

      throw new Error(
        `Telegram rejected the message (${response.status}). ${detail.slice(0, 200)}`,
      );
    },
  };
}

/**
 * Confirm a token and chat id work, for the Settings screen.
 *
 * Sends a real message: the only way to know a chat id is right is for
 * something to arrive. A user who sees nothing knows immediately, rather
 * than discovering it the first time an agent has something to say.
 */
export async function testTelegram(config: TelegramConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const channel = telegramChannel(config);
    const ok = await channel.deliver({
      id: 'test',
      agentId: 'test',
      agentName: 'WispCrew',
      summary: 'Connected. Your agents can reach you here.',
      createdAt: Date.now(),
      pending: ['telegram'],
    });
    return ok
      ? { ok: true }
      : { ok: false, error: 'Could not reach Telegram. Check the connection and try again.' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Find the chat id for a bot the user has already messaged.
 *
 * Asking someone to discover their own numeric chat id is a genuinely bad
 * first experience. Telegram will report it once they have sent the bot any
 * message, so Settings can say "message your bot, then press this".
 */
/**
 * What discovery found, or why it found nothing.
 *
 * A bare `null` used to cover four completely different situations — no
 * token stored, a rejected token, a webhook holding the updates, and simply
 * no messages yet — and the UI could only guess at one of them. It guessed
 * "send your bot something first", which is unhelpful when the user has
 * just sent three messages and infuriating when the real problem is that no
 * token was ever saved.
 */
export interface ChatDiscovery {
  chatId?: string;
  /** Present when there is nothing to report; written for a person. */
  error?: string;
}

export async function discoverChatId(token: string): Promise<ChatDiscovery> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      signal: AbortSignal.timeout(15_000),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { message?: { chat?: { id?: number } } }[];
    };

    /*
     * Telegram answers 200 with `ok: false` for some failures and a real
     * status for others, so both are checked. Its `description` is written
     * for developers but is specific and true, which beats a friendly
     * sentence that names the wrong cause.
     */
    if (!response.ok || payload.ok === false) {
      const detail = payload.description ?? `HTTP ${response.status}`;

      if (response.status === 401) {
        return { error: `Telegram rejected this bot token (${detail}). Check it and save again.` };
      }
      if (response.status === 409) {
        /*
         * 409 means something else is already polling this bot — usually a
         * webhook, occasionally a second copy of WispCrew. Telegram allows
         * exactly one reader, and the other one is taking the messages.
         */
        return {
          error:
            `Something else is already receiving this bot's messages (${detail}). ` +
            'Delete its webhook, or stop the other program, then try again.',
        };
      }
      return { error: `Telegram said: ${detail}` };
    }

    // The most recent message wins: if several people have written to the
    // bot, the person setting it up just now is the relevant one.
    const chats = (payload.result ?? [])
      .map((update) => update.message?.chat?.id)
      .filter((id): id is number => typeof id === 'number');

    if (!chats.length) {
      return {
        error:
          'Telegram has no recent messages for this bot. Send it one — anything — and ' +
          'press this again. Messages older than a day are dropped, and a bot only sees ' +
          'a group chat if you make it an administrator.',
      };
    }

    return { chatId: String(chats[chats.length - 1]) };
  } catch (err) {
    /*
     * Named rather than swallowed. A timeout, a DNS failure and a proxy
     * refusing the connection all used to arrive as "no message found",
     * which sent the user looking at Telegram instead of at their network.
     */
    return { error: `Could not reach Telegram: ${(err as Error).message}` };
  }
}
