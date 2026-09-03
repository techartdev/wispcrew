/**
 * channel-mirror.ts — showing a connected chat what happened elsewhere.
 *
 * `/connect` binds a Telegram chat to a conversation, and that read as
 * "attach this conversation" — but the binding was one-way. A message typed
 * in Telegram ran a turn and the answer came back to Telegram, because a
 * reply goes to wherever its message came from. Anything said in the DESKTOP
 * side of the same room was invisible from the phone. Reported as: "why in
 * telegram I do not see anything written on desktop?"
 *
 * ## What crosses, and what does not
 *
 * People and answers, not the machinery. Your messages and each agent's
 * final reply are mirrored; tool cards, approval notices, room events and
 * streaming updates are not. A busy agent makes dozens of the latter, and a
 * phone that buzzes for every shell command is a phone with notifications
 * turned off by the end of the day.
 *
 * ## What is NOT mirrored, and why it would be wrong to
 *
 * An entry that ORIGINATED in a chat is never sent back to it. The user's
 * own message is already on their screen — they typed it — and the answer
 * to a Telegram-initiated turn is delivered by `telegram-progress`, which
 * edits a placeholder in place. Mirroring either would duplicate it.
 */
import type { ChannelId, TranscriptEntry } from '@wispcrew/shared';
import { endpointsFor } from './channel-bindings.js';
import { fileLog } from './filelog.js';
import { getSecret } from './secrets-store.js';
import { host } from './host.js';
import { TELEGRAM_TOKEN_KEY } from './notify-host.js';

/**
 * Telegram's hard limit on one message.
 *
 * Exceeding it is a 400, not a truncation, so a long answer must be split
 * or it simply never arrives.
 */
const TELEGRAM_LIMIT = 4096;

/**
 * Split for sending, preferring a break somebody would have chosen.
 *
 * A blank line, then a line end, then a space, then — only if a single
 * unbroken run is longer than the limit, which happens with a base64 blob
 * or a minified file — a hard cut.
 */
export function splitForTelegram(text: string, limit = TELEGRAM_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const at =
      window.lastIndexOf('\n\n') >= limit * 0.5
        ? window.lastIndexOf('\n\n')
        : window.lastIndexOf('\n') >= limit * 0.5
          ? window.lastIndexOf('\n')
          : window.lastIndexOf(' ') >= limit * 0.5
            ? window.lastIndexOf(' ')
            : limit;

    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }

  if (rest.trim()) parts.push(rest);
  return parts;
}

/** Should this entry be shown to somebody watching from another device? */
export function shouldMirror(entry: TranscriptEntry, origin?: ChannelId): boolean {
  // Machinery: tool cards, notices, approvals, room events. Useful on a
  // screen you are already looking at; noise on a phone.
  if (entry.kind !== 'message') return false;

  // A half-written answer. The final push settles with `isStreaming` unset.
  if (entry.role === 'assistant' && entry.isStreaming) return false;

  if (!entry.content?.trim()) return false;

  /*
   * Already delivered where it came from.
   *
   * `telegram-progress` edits its placeholder into the final answer for a
   * turn that started in Telegram, and the user's own message is on their
   * screen because they typed it.
   */
  if (origin === 'telegram' || entry.via === 'telegram') return false;

  return true;
}

/** Who said it, so a reader on a phone can tell people apart. */
function attribute(
  entry: Extract<TranscriptEntry, { kind: 'message' }>,
  nameOf: (id: string) => string | undefined,
): string {
  if (entry.role === 'user') return `You:\n${entry.content}`;
  const who = entry.authorId ? nameOf(entry.authorId) : undefined;
  return who ? `${who}:\n${entry.content}` : entry.content;
}

/**
 * Send an entry to every chat bound to this conversation.
 *
 * Failures are logged and swallowed: a mirror that cannot reach Telegram
 * must not fail the turn that produced the entry. The conversation is the
 * record; this is a convenience on top of it.
 */
export async function mirrorEntry(
  conversationId: string,
  entry: TranscriptEntry,
  opts: { origin?: ChannelId; nameOf: (id: string) => string | undefined },
): Promise<void> {
  if (!shouldMirror(entry, opts.origin)) return;

  const bindings = endpointsFor(conversationId);
  if (bindings.length === 0) return;

  const token = getSecret(host().dataDir, TELEGRAM_TOKEN_KEY);
  if (!token) return;

  const chunks = splitForTelegram(
    attribute(entry as Extract<TranscriptEntry, { kind: 'message' }>, opts.nameOf),
  );

  for (const binding of bindings) {
    for (const chunk of chunks) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: binding.endpoint.chatId,
            ...(binding.endpoint.threadId !== undefined
              ? { message_thread_id: binding.endpoint.threadId }
              : {}),
            text: chunk,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        const json = (await response.json()) as { ok: boolean; description?: string };
        if (!json.ok) fileLog('[mirror] telegram refused:', json.description ?? 'unknown');
      } catch (err) {
        fileLog('[mirror] failed:', (err as Error).message);
        return; // One unreachable endpoint is enough; do not hammer it.
      }
    }
  }
}
