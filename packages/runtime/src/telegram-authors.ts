/**
 * telegram-authors.ts — which agent sent which Telegram message.
 *
 * Telegram's own Reply is the most natural way to address one agent among
 * several: tap the message, type. But the reply only carries a message id,
 * so something has to remember that message 944 was Coder speaking.
 *
 * Small and deliberately bounded. This is a convenience for addressing, not
 * a record of the conversation — the transcript is that — so an entry aging
 * out means a reply falls back to the ordinary rules rather than losing
 * anything.
 */
import { fileLog } from './filelog.js';
import * as store from './store.js';

/**
 * How many message→author pairs to keep.
 *
 * Generous enough that replying to something from yesterday still works, and
 * small enough that the file stays trivial. A user scrolling far enough back
 * to miss it can still @mention.
 */
const MAX_ENTRIES = 500;

interface AuthorRecord {
  /** Telegram's message id, unique within a chat. */
  messageId: number;
  chatId: string;
  /** The agent that said it. */
  agentId: string;
  at: number;
}

function authorsPath(): string {
  return store.filePathFor('telegram-authors.json');
}

function readAuthors(): AuthorRecord[] {
  const all = store.readJson<AuthorRecord[]>(authorsPath(), []);
  return Array.isArray(all) ? all : [];
}

/** Remember that an agent sent this message. */
export function recordTelegramAuthor(patch: {
  messageId: number;
  chatId: string;
  agentId: string;
}): void {
  try {
    const all = readAuthors().filter(
      (a) => !(a.messageId === patch.messageId && a.chatId === patch.chatId),
    );

    all.push({ ...patch, at: Date.now() });

    // Newest first, then truncate: an old entry expiring costs a convenience,
    // never a message.
    all.sort((a, b) => b.at - a.at);
    store.writeJson(authorsPath(), all.slice(0, MAX_ENTRIES));
  } catch (err) {
    // Addressing is a nicety; failing to record it must not fail a turn.
    fileLog('[telegram] could not record an author', (err as Error).message);
  }
}

/**
 * Who sent this message?
 *
 * Returns the agent id, or `undefined` when it was the user, an unknown
 * message, or one old enough to have aged out.
 */
export function authorOfTelegramMessage(
  messageId: number,
  chatId?: string,
): string | undefined {
  return readAuthors().find(
    (a) => a.messageId === messageId && (chatId === undefined || a.chatId === chatId),
  )?.agentId;
}
