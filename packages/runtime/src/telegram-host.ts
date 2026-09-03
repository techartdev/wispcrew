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
import { currentApprovalAsker, setApprovalAsker } from './engine.js';
import { runRoomTurn } from './room-turn.js';
import { agentsIn, isGroup } from '@wispcrew/shared';
import { getAgent } from './store.js';

const NOT_CONNECTED = 'Not connected. Use /connect <name> to attach a conversation.';

/**
 * Where you are, and who is in it.
 *
 * The room's NAME alone is not much use from a phone. Addressing an agent
 * needs its handle, and handles are shown in the desktop's room panel —
 * the one place somebody on Telegram cannot look. Asked exactly that way:
 * "how can I see who's in, so I know who to tag?"
 *
 * Answered by the same command that says where you are, because "which room
 * is this" and "who is in it" are one question when you are about to type.
 */
function describeRoom(conversation: ConversationRecord): string {
  const members = agentsIn(conversation);

  const roster = members
    .map((m) => `@${m.handle} — ${getAgent(m.id)?.name ?? m.handle}`)
    .join('\n');

  if (!isGroup(conversation)) {
    // A one-to-one has exactly one agent and no addressing to do: naming a
    // handle nobody needs would be noise.
    return `This is "${conversation.title}".`;
  }

  return (
    `This is "${conversation.title}".\n\n` +
    `In this room:\n${roster}\n\n` +
    'Tag one to address them, or @all for everyone.'
  );
}
import {
  askViaTelegram,
  clearTelegramApprovals,
  resolveTelegramApproval,
} from './telegram-approval.js';
import {
  bindEndpoint,
  conversationFor,
  endpointsFor,
  sharingWarning,
  unbindEndpoint,
} from './channel-bindings.js';
import { authorOfTelegramMessage, recordTelegramAuthor } from './telegram-authors.js';
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
 * Which room a message belongs to.
 *
 * The endpoint IS the address. An earlier version kept a `telegramRoom`
 * setting — the last room somebody chose with `/room` — which works with one
 * conversation and misroutes with several: a reply typed into what the user
 * believes is the release discussion lands wherever the pointer was last
 * moved, silently.
 *
 * Every update already says where it came from, so nothing needs
 * remembering. A private chat with topics and a forum supergroup address
 * identically, and hundreds of rooms need no selection mechanism: the user
 * taps the topic.
 */
function roomFor(message: InboundMessage): ConversationRecord | undefined {
  const bound = conversationFor({ chatId: message.chatId, threadId: message.threadId });
  if (bound) return getConversation(bound);

  /*
   * Nothing bound, and no topic: the ordinary single-room case.
   *
   * Falling back to the only conversation keeps a simple setup working
   * without ceremony. With a topic present the silence is deliberate —
   * guessing which room a named topic meant is exactly the misrouting this
   * function exists to prevent.
   */
  if (message.threadId !== undefined) return undefined;

  const rooms = listConversations();
  return rooms.length === 1 ? rooms[0] : undefined;
}

/**
 * Which agent a reply is addressed to.
 *
 * Pressing Telegram's own Reply on an agent's message is a strong statement
 * of intent — stronger than "whoever spoke last" — so it outranks the
 * remembered addressee. No @mention, no menu.
 */
function repliedAgent(
  conversation: ConversationRecord,
  replyToMessageId: number | undefined,
): string | undefined {
  if (replyToMessageId === undefined) return undefined;

  const authorId = authorOfTelegramMessage(replyToMessageId);
  if (!authorId) return undefined;

  const participant = conversation.participants.find(
    (p) => p.kind === 'agent' && p.id === authorId,
  );
  return participant?.kind === 'agent' ? participant.handle : undefined;
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
  /*
   * Connecting happens from inside the chat.
   *
   * The endpoint is wherever this message was typed, so there is nothing for
   * the user to identify by hand — and it works in a topic, which is the
   * case a settings form makes awkward.
   */
  const command = /^\/(connect|disconnect|here|who)\b\s*(.*)$/i.exec(message.text.trim());
  if (command) {
    const verb = command[1]!.toLowerCase();
    const argument = command[2]!.trim();
    const endpoint = { chatId: message.chatId, threadId: message.threadId };

    if (verb === 'disconnect') {
      unbindEndpoint(endpoint);
      await sendPlain(deps.token, message.chatId, 'Disconnected. Nothing here reaches WispCrew now.', message.threadId);
      return { handled: true };
    }

    if (verb === 'here' || verb === 'who') {
      const current = conversationFor(endpoint);
      const conversation = current ? getConversation(current) : undefined;

      /*
       * Who is in the room, and what to call them.
       *
       * The name of the room alone is not much use from a phone: addressing
       * an agent needs its handle, and the handles are only visible in the
       * desktop's room panel — which is the one place somebody on Telegram
       * cannot look. Asked directly: "how can I see who's in, so I know who
       * to tag?"
       *
       * Reported by the same command that answers "where am I", because
       * "which room is this" and "who is in it" are one question when you
       * are about to type a message.
       */
      await sendPlain(
        deps.token,
        message.chatId,
        conversation ? describeRoom(conversation) : NOT_CONNECTED,
        message.threadId,
      );
      return { handled: true };
    }

    const rooms = listConversations();
    const wanted = argument.toLowerCase();
    const match = wanted
      ? rooms.find((r) => r.title.toLowerCase().includes(wanted))
      : undefined;

    if (!wanted) {
      await sendPlain(
        deps.token,
        message.chatId,
        `Which conversation? ${rooms.map((r) => r.title).join(', ')}`,
        message.threadId,
      );
      return { handled: true };
    }

    if (!match) {
      await sendPlain(
        deps.token,
        message.chatId,
        `No conversation matches "${argument}". Available: ${rooms.map((r) => r.title).join(', ')}`,
        message.threadId,
      );
      return { handled: true };
    }

    /*
     * Say when this makes an existing room reachable from somewhere new.
     *
     * Correct per the conversation model and surprising enough to matter: a
     * message typed in a private topic becomes visible in a company group.
     */
    const warning = sharingWarning(match, endpointsFor(match.id));
    bindEndpoint({ conversationId: match.id, endpoint, label: argument });

    await sendPlain(
      deps.token,
      message.chatId,
      warning
        ? `Connected to "${match.title}". ${warning}`
        : `Connected to "${match.title}".`,
      message.threadId,
    );
    return { handled: true };
  }

  const room = roomFor(message);

  if (!room) {
    /*
     * Nothing is bound here. Say so rather than answering into some other
     * conversation — a message that goes to the wrong room is worse than
     * one that goes nowhere.
     */
    await sendPlain(
      deps.token,
      message.chatId,
      'This chat is not connected to a WispCrew conversation yet. Use /connect <name>.',
      message.threadId,
    );
    return { handled: true };
  }

  const agent = room.participants.find((p) => p.kind === 'agent');
  if (!agent) {
    await sendPlain(deps.token, deps.chatId, `"${room.title}" has no agent in it.`);
    return { handled: true };
  }

  /*
   * A reply outranks everything except an explicit mention.
   *
   * Prefixing the handle rather than passing it separately keeps one
   * addressing mechanism: the floor rules already know what `@handle` means,
   * and a second path into them would be a second thing to keep correct.
   */
  const replied = repliedAgent(room, message.replyToMessageId);
  const prompt =
    replied && !/(?:^|\s)@[a-z0-9]/i.test(message.text)
      ? `@${replied} ${message.text}`
      : message.text;

  /*
   * Record the user's message as their own turn, attributed to the door it
   * came through.
   *
   * This is what makes the desktop show "You · via Telegram" rather than a
   * message from a bot, and what lets the agent see one continuous
   * conversation.
   */


  const record = store.listAgents().find((a) => a.id === agent.id);
  const progress = startProgress({
    token: deps.token,
    chatId: message.chatId,
    threadId: message.threadId,
    agentName: record?.name ?? room.title,
    // So replying to this message addresses this agent.
    agentId: agent.id,
  });

  /*
   * Ask the phone, for this turn only.
   *
   * A daemon normally denies approvals because nobody is attached to ask —
   * right by default, and wrong here, because someone IS there: they just
   * sent the message. The asker is installed around this turn and removed
   * afterwards, so an agent waking on a SCHEDULE never gets to prompt the
   * phone. Otherwise a compromised chat could be presented with a request
   * at any moment, rather than only in reply to something the user did.
   */
  const previousAsker = currentApprovalAsker();
  setApprovalAsker(async (_agentId, request) =>
    askViaTelegram(deps.token, deps.chatId, record?.name ?? 'An agent', request),
  );

  try {
    /*
     * Tell the engine which door this came through.
     *
     * Without it, an agent set to `auto` would run shell commands for
     * anyone holding the user's phone — the exact case the per-channel
     * policy exists to prevent.
     */
    /*
     * Through the room, with the Telegram message id as the entry id.
     *
     * The inbox replays anything it has not acknowledged, so the same
     * message genuinely can arrive twice — this is the path where duplicate
     * suppression matters most, and it was the one without it.
     */
    const result = await runRoomTurn({
      conversationId: room.id,
      text: prompt,
      speakerId: LOCAL_HUMAN_ID,
      channel: 'telegram',
      entryId: `tg_${message.chatId}_${message.messageId}`,
      // The test seam only cares about (agentId, prompt); the rest of the
      // real signature is accepted and ignored.
      run: deps.run as Parameters<typeof runRoomTurn>[0]['run'],
    });

    /*
     * A failure is reported as a failure.
     *
     * The room catches a throwing agent so it cannot take down the others,
     * which meant this path saw a "successful" turn with no answer and said
     * "Done, with nothing to report" — confidently wrong, and worse than
     * saying nothing.
     */
    if (result.failures?.length) {
      await progress.fail(result.failures.map((f) => f.error).join('; '));
      return { handled: true, agentId: agent.id };
    }

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
  } finally {
    /*
     * Put the previous asker back, always.
     *
     * A thrown turn that left this installed would let a later scheduled
     * run prompt the phone — exactly the window this scoping exists to
     * close.
     */
    setApprovalAsker(previousAsker);
    clearTelegramApprovals();
  }

  return { handled: true, agentId: agent.id };
}

async function sendPlain(
  token: string,
  chatId: string,
  text: string,
  threadId?: number,
): Promise<void> {
  try {
    const send = async (withThread: boolean) => {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          ...(withThread && threadId !== undefined ? { message_thread_id: threadId } : {}),
          text,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return (await response.json()) as { ok: boolean; description?: string };
    };

    const first = await send(true);

    /*
     * The topic is gone.
     *
     * A binding outlives the topic it names — someone deletes it, or the
     * chat leaves topic mode — and every message would then fail silently.
     * The main view is visible and recoverable; silence is not.
     *
     * Only this error retries. Blanket fallback would silently redirect
     * topic messages into the main chat whenever anything went wrong, which
     * is the documented Bot API 10 trap.
     */
    if (!first.ok && /message thread not found/i.test(first.description ?? '')) {
      fileLog('[telegram] topic missing, replying in the main chat instead');
      await send(false);
    }
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
    /*
     * Anything bound, plus the chat the user configured.
     *
     * The configured chat is accepted even with nothing bound to it, or
     * `/connect` could never arrive: the command that creates a binding
     * would be refused for want of one.
     *
     * A bot token is a bearer credential, so this is the gate that matters —
     * a stranger who finds the bot gets silence rather than a turn in
     * somebody else's conversation.
     */
    accepts: (incomingChat, threadId) =>
      incomingChat === chatId ||
      conversationFor({ chatId: incomingChat, threadId }) !== undefined,
    // The result is for tests; the listener only needs it to settle.
    // Button presses on approval prompts.
    onCallback: (data) => resolveTelegramApproval(data),
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
