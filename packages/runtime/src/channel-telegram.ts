/**
 * channel-telegram.ts — a real DM, delivered by the daemon.
 *
 * This is the only channel that reaches the user when they are nowhere near
 * the machine, which is the point of an agent that works unattended. It is
 * also the first thing in GhostBot that talks to a service outside the
 * user's own computer, so a few things are deliberate:
 *
 *  - **Entirely opt-in.** No token, no channel. Nothing is sent anywhere
 *    unless the user creates a bot and pastes its token.
 *  - **The bot is theirs.** Created through Telegram's @BotFather, owned by
 *    their account. There is no GhostBot service in the middle, nothing to
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
      agentName: 'GhostBot',
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
export async function discoverChatId(token: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      result?: { message?: { chat?: { id?: number } } }[];
    };

    // The most recent message wins: if several people have written to the
    // bot, the person setting it up just now is the relevant one.
    const chats = (payload.result ?? [])
      .map((update) => update.message?.chat?.id)
      .filter((id): id is number => typeof id === 'number');

    return chats.length ? String(chats[chats.length - 1]) : null;
  } catch {
    return null;
  }
}
