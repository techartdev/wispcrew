/**
 * channel-bindings.ts — which external endpoint is a door onto which room.
 *
 * The first version of Telegram routing kept a single `telegramRoom` setting:
 * the last room somebody chose with `/room`. That works with one
 * conversation and is a bug waiting to happen with several — a reply typed
 * into what the user believes is the release discussion lands wherever the
 * pointer was last moved, and nothing in the interface says so.
 *
 * An outside review named this exactly: routing must not be mutable state.
 * Every Telegram update already carries where it came from, so the endpoint
 * *is* the address:
 *
 * ```
 *   (chatId, threadId) ─────► conversationId
 * ```
 *
 * A private chat with topics and a forum supergroup then behave identically,
 * and hundreds of rooms need no selection mechanism at all — the user taps
 * the topic, exactly as they would tap a channel in any chat application.
 */
import type { ConversationRecord } from '@wispcrew/shared';
import { fileLog } from './filelog.js';
import * as store from './store.js';

/** Where a message arrived from, or should be sent to. */
export interface TelegramEndpoint {
  chatId: string;
  /**
   * The forum topic, when there is one.
   *
   * Absent for an ordinary chat with no topics. Present for both a forum
   * supergroup and a private chat in topic mode — the same field addresses
   * both, which is what makes one routing table serve every arrangement.
   */
  threadId?: number;
}

export interface ChannelBinding {
  conversationId: string;
  channel: 'telegram';
  endpoint: TelegramEndpoint;
  /** For the UI: what this endpoint is called in Telegram. */
  label?: string;
  createdAt: number;
}

function bindingsPath(): string {
  return store.filePathFor('channel-bindings.json');
}

export function listBindings(): ChannelBinding[] {
  const all = store.readJson<ChannelBinding[]>(bindingsPath(), []);
  return Array.isArray(all) ? all : [];
}

function saveBindings(all: ChannelBinding[]): void {
  store.writeJson(bindingsPath(), all);
}

/**
 * A stable key for an endpoint.
 *
 * `undefined` and `0` must not collide: Telegram uses no thread id for an
 * ordinary chat, and a topic id is always positive. Encoding the absence
 * explicitly keeps "the group itself" distinct from "topic zero".
 */
function keyFor(endpoint: TelegramEndpoint): string {
  return `${endpoint.chatId}:${endpoint.threadId ?? 'main'}`;
}

/**
 * Which conversation does this endpoint belong to?
 *
 * Returns `undefined` when nothing is bound, which the caller should treat
 * as "not for us" rather than guessing — answering into an arbitrary room is
 * the failure this table exists to prevent.
 */
export function conversationFor(endpoint: TelegramEndpoint): string | undefined {
  const key = keyFor(endpoint);
  return listBindings().find((b) => keyFor(b.endpoint) === key)?.conversationId;
}

/** Every endpoint that is a door onto this conversation. */
export function endpointsFor(conversationId: string): ChannelBinding[] {
  return listBindings().filter((b) => b.conversationId === conversationId);
}

/**
 * Bind an endpoint to a conversation.
 *
 * One endpoint maps to exactly one conversation: two rooms sharing a topic
 * would make every message ambiguous. Rebinding replaces, so moving a topic
 * to a different room is one action rather than a leak.
 */
export function bindEndpoint(patch: {
  conversationId: string;
  endpoint: TelegramEndpoint;
  label?: string;
}): ChannelBinding {
  const key = keyFor(patch.endpoint);
  const binding: ChannelBinding = {
    conversationId: patch.conversationId,
    channel: 'telegram',
    endpoint: patch.endpoint,
    label: patch.label,
    createdAt: Date.now(),
  };

  saveBindings([...listBindings().filter((b) => keyFor(b.endpoint) !== key), binding]);
  fileLog('[bindings] bound', key, 'to', patch.conversationId);
  return binding;
}

export function unbindEndpoint(endpoint: TelegramEndpoint): void {
  const key = keyFor(endpoint);
  saveBindings(listBindings().filter((b) => keyFor(b.endpoint) !== key));
}

/** Remove every binding for a conversation, e.g. when it is deleted. */
export function unbindConversation(conversationId: string): void {
  saveBindings(listBindings().filter((b) => b.conversationId !== conversationId));
}

/**
 * What a user should be told before a second door is added to a room.
 *
 * A room reachable from a private topic AND a company group means a message
 * typed in either is visible in both. That is exactly what the conversation
 * model promises, and surprising enough to be a security incident if nobody
 * says it out loud.
 */
export function sharingWarning(
  conversation: ConversationRecord,
  existing: ChannelBinding[],
): string | undefined {
  if (existing.length === 0) return undefined;

  const where = existing.map((b) => b.label ?? b.endpoint.chatId).join(', ');
  return (
    `"${conversation.title}" is already reachable from ${where}. ` +
    'Anything said here will be visible there too.'
  );
}
