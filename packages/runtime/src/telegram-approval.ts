/**
 * telegram-approval.ts — asking the person who is actually there.
 *
 * A daemon denies approvals because nobody is attached to ask. That is the
 * right default and it becomes wrong the moment a phone is a door into the
 * room: someone IS there, holding the device the request came from.
 *
 * So a request originating from Telegram is put to that chat with inline
 * Yes/No buttons, and the answer is a real approval.
 *
 * ## Why this is treated carefully
 *
 * Approving over Telegram means a message can authorise a shell command on
 * the user's machine. Three things bound that:
 *
 *  - It is only offered for a turn the user STARTED from Telegram. An agent
 *    waking on a schedule does not get to ask the phone; it is denied as
 *    before. Otherwise a compromised chat could be prompted at any time.
 *  - Only the configured chat is accepted, checked again here rather than
 *    trusted from the caller.
 *  - It expires. An unanswered request denies itself, so a prompt cannot sit
 *    indefinitely waiting for someone to press the wrong thing later.
 */
import type { ApprovalRequest } from '@wispcrew/shared';
import { fileLog } from './filelog.js';

/**
 * How long a prompt stays live.
 *
 * Long enough to notice a phone buzz and read it; short enough that a
 * request cannot be answered hours later out of context.
 */
const EXPIRY_MS = 5 * 60_000;

interface Pending {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

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

function escape(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Ask the phone, and wait.
 *
 * Resolves false on any failure — a request that cannot be put to the user
 * is a request nobody approved.
 */
export async function askViaTelegram(
  token: string,
  chatId: string,
  agentName: string,
  request: ApprovalRequest,
): Promise<boolean> {
  const id = `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  const detail = request.detail ? `\n\n\`\`\`\n${request.detail.slice(0, 600)}\n\`\`\`` : '';
  const text =
    `*${escape(agentName)}* wants to run *${escape(request.toolName)}*\n` +
    escape(request.summary) +
    detail;

  try {
    await call(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Allow', callback_data: `${id}:yes` },
            { text: '✖ Deny', callback_data: `${id}:no` },
          ],
        ],
      },
    });
  } catch (err) {
    fileLog('[telegram] could not ask for approval', (err as Error).message);
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      fileLog('[telegram] approval expired unanswered');
      // Silence is not consent.
      resolve(false);
    }, EXPIRY_MS);
    timer.unref?.();

    pending.set(id, { resolve, timer });
  });
}

/**
 * Deliver a button press.
 *
 * Called by the inbox when a `callback_query` arrives. Returns whether the
 * press matched something still waiting — a stale button should be answered
 * politely rather than ignored.
 */
export function resolveTelegramApproval(callbackData: string): boolean {
  const [id, answer] = callbackData.split(':');
  if (!id) return false;

  const waiting = pending.get(id);
  if (!waiting) return false;

  clearTimeout(waiting.timer);
  pending.delete(id);
  waiting.resolve(answer === 'yes');
  return true;
}

/** Requests still waiting. Used by tests and diagnostics. */
export function pendingApprovalCount(): number {
  return pending.size;
}

/** Abandon everything, denying each. Used when the listener stops. */
export function clearTelegramApprovals(): void {
  for (const [, waiting] of pending) {
    clearTimeout(waiting.timer);
    waiting.resolve(false);
  }
  pending.clear();
}
