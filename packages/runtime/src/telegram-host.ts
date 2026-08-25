/**
 * telegram-host.ts — a phone as a door into a room.
 *
 * Joins the three halves: the inbox that receives, the progress message that
 * shows work, and the engine that answers. The result is that a reply typed
 * on a train is the user's OWN turn in the same conversation, seen on the
 * desktop later as "You · via Telegram".
 *
 * That is the distinction the whole design rests on. A side-channel bot with
 * its own memory would be a different product — and a worse one, because it
 * would make the user repeat context every time they moved between devices.
 */
import type { ChannelId, ConversationRecord, GlobalSettings } from '@wispcrew/shared';
import { getConversation, listConversations, LOCAL_HUMAN_ID } from './conversations.js';
import { runPrompt } from './engine.js';
import { fileLog } from './filelog.js';
import { host } from './host.js';
import { getSecret } from './secrets-store.js';
import { readSettings, writeSettings } from './settings-file.js';
import * as store from './store.js';
import { startInbox, type Inbox, type InboundMessage } from './telegram-inbox.js';
import { startProgress } from './telegram-progress.js';
import { TELEGRAM_TOKEN_KEY } from './notify-host.js';

let inbox: Inbox | null = null;

/**
 * Which room a message from the phone belongs to.
 *
 * With one room the answer is obvious. With several it is genuinely
 * ambiguous, and guessing wrong sends work to the wrong agent — so the
 * choice is explicit and remembered: `/room <name>` switches, and the last
 * choice persists.
 *
 * Falling back to the most recently updated room is the least surprising
 * default: it is the conversation the user was last actually having.
 */
function targetRoom(text: string): { room?: ConversationRecord; reply?: string } {
  const rooms = listConversations();
  if (rooms.length === 0) return { reply: 'There are no conversations yet.' };

  const command = /^\/room\s+(.+)$/i.exec(text.trim());
  if (command) {
    const wanted = command[1]!.trim().toLowerCase();
    const found = rooms.find((r) => r.title.toLowerCase().includes(wanted));
    if (!found) {
      return {
        reply: `No conversation matches "${command[1]}". Available: ${rooms
          .map((r) => r.title)
          .join(', ')}`,
      };
    }
    setPreferredRoom(found.id);
    return { room: found, reply: `Now talking in "${found.title}".` };
  }

  if (text.trim().toLowerCase() === '/rooms') {
    return { reply: `Conversations: ${rooms.map((r) => r.title).join(', ')}` };
  }

  const preferred = preferredRoom();
  const room = (preferred && getConversation(preferred)) || rooms[0];
  return { room };
}

/** The room the phone is currently pointed at. */
function preferredRoom(): string | undefined {
  const settings = readSettings(host().dataDir, {}) as GlobalSettings & {
    telegramRoom?: string;
  };
  return settings.telegramRoom;
}

function setPreferredRoom(id: string): void {
  // `writeSettings` merges rather than replaces, so this cannot clobber
  // provider or channel settings written by another process.
  writeSettings(host().dataDir, { telegramRoom: id } as never);
}

/**
 * Handle one message from the phone.
 *
 * Exported for testing: the polling loop is hard to exercise, but the
 * decision of what to do with a message is exactly what needs pinning.
 */
export async function handleInbound(
  message: InboundMessage,
  deps: {
    token: string;
    chatId: string;
    run?: (agentId: string, prompt: string) => Promise<void>;
  },
): Promise<{ handled: boolean; reply?: string; agentId?: string }> {
  const { room, reply } = targetRoom(message.text);

  if (reply && !room) {
    await sendPlain(deps.token, deps.chatId, reply);
    return { handled: true, reply };
  }
  if (!room) return { handled: false };
  if (reply) await sendPlain(deps.token, deps.chatId, reply);

  const agent = room.participants.find((p) => p.kind === 'agent');
  if (!agent) {
    await sendPlain(deps.token, deps.chatId, `"${room.title}" has no agent in it.`);
    return { handled: true };
  }

  // A `/room` switch is a command, not something to answer.
  if (/^\/(room|rooms)\b/i.test(message.text.trim())) return { handled: true };

  /*
   * Record the user's message as their own turn, attributed to the door it
   * came through.
   *
   * This is what makes the desktop show "You · via Telegram" rather than a
   * message from a bot, and what lets the agent see one continuous
   * conversation.
   */
  store.upsertTranscriptEntry(room.id, {
    kind: 'message',
    id: store.newId('usr'),
    role: 'user',
    content: message.text,
    authorId: LOCAL_HUMAN_ID,
    via: 'telegram' as ChannelId,
    createdAt: Date.now(),
  });

  const record = store.listAgents().find((a) => a.id === agent.id);
  const progress = startProgress({
    token: deps.token,
    chatId: deps.chatId,
    agentName: record?.name ?? room.title,
  });

  try {
    await (deps.run ?? runPrompt)(agent.id, message.text);

    const transcript = store.loadTranscript(room.id);
    const answer = [...transcript]
      .reverse()
      .find((e) => e.kind === 'message' && e.role === 'assistant');

    await progress.finish(
      answer && answer.kind === 'message' && answer.content
        ? answer.content
        : 'Done, with nothing to report.',
    );
  } catch (err) {
    await progress.fail((err as Error).message);
    fileLog('[telegram] turn failed', (err as Error).message);
  }

  return { handled: true, agentId: agent.id };
}

async function sendPlain(token: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    fileLog('[telegram] reply failed', (err as Error).message);
  }
}

/**
 * Start listening, if Telegram is configured.
 *
 * Called by whichever process owns the engine — normally the daemon, which
 * is what lets the phone work with the app closed.
 */
export function startTelegram(): void {
  const dataDir = host().dataDir;
  const settings = readSettings(dataDir, {}) as GlobalSettings;
  const token = getSecret(dataDir, TELEGRAM_TOKEN_KEY);
  const chatId = settings.channels?.telegram?.chatId;

  if (!token || !chatId) return;
  if (!settings.channels?.enabled?.includes('telegram')) return;

  stopTelegram();
  inbox = startInbox({
    token,
    chatId,
    dataDir,
    // The result is for tests; the listener only needs it to settle.
    onMessage: async (message) => {
      await handleInbound(message, { token, chatId });
    },
  });

  fileLog('[telegram] listening for messages');
}

export function stopTelegram(): void {
  inbox?.stop();
  inbox = null;
}
