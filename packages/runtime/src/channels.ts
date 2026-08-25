/**
 * channels.ts — how an agent reaches the person who owns it.
 *
 * An agent that works unattended is only useful if it can say so. A routine
 * that finds something at 3am currently writes to a transcript nobody is
 * looking at, which is the same as finding nothing.
 *
 * A channel is somewhere a message can be delivered. Three exist:
 *
 *  - **app** — the transcript, always available, seen when the user looks.
 *  - **desktop** — a native notification. Only the desktop app can raise
 *    one, so the daemon queues instead and it appears when the app opens.
 *  - **telegram** — a real DM to a phone, delivered by the daemon itself.
 *
 * ## Why delivery is a queue, not a function call
 *
 * The process that *decides* to notify is often not the process that *can*.
 * A routine fires in the daemon; a desktop notification needs the GUI. Rather
 * than have the daemon reach into a window that may not exist, every message
 * is recorded and each channel drains what it can, when it can.
 *
 * That makes "the app was closed" an ordinary case rather than a failure,
 * and it means nothing is lost when nobody is watching.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileLog } from './filelog.js';
import { readJson, writeJson } from './store.js';

/** Where a message may be delivered. */
export type ChannelId = 'app' | 'desktop' | 'telegram';

export interface OutboundMessage {
  id: string;
  agentId: string;
  /** Agent name at the time of sending, so the user knows who is speaking. */
  agentName: string;
  /** One line; a notification has no room for more. */
  summary: string;
  /** Optional detail for channels that can show it. */
  body?: string;
  createdAt: number;
  /** Channels still to deliver on. Emptied as each succeeds. */
  pending: ChannelId[];
  /** Channels that were tried and failed, with why. */
  failures?: Record<string, string>;
}

/** A channel that can deliver, in whichever process it lives. */
export interface ChannelDeliverer {
  id: ChannelId;
  /**
   * Attempt delivery.
   *
   * Returning false means "not now, keep it queued" — the app is closed, the
   * network is down. Throwing means the message is undeliverable on this
   * channel and should not be retried forever.
   */
  deliver(message: OutboundMessage): Promise<boolean>;
}

const OUTBOX_FILE = 'outbox.json';
/**
 * How many delivered messages to remember.
 *
 * Enough that a user opening the app after a weekend sees what happened,
 * bounded so an agent that notifies hourly cannot grow the file without end.
 */
const MAX_HISTORY = 200;

function outboxPath(dataDir: string): string {
  return path.join(dataDir, OUTBOX_FILE);
}

function readOutbox(dataDir: string): OutboundMessage[] {
  const list = readJson<OutboundMessage[]>(outboxPath(dataDir), []);
  return Array.isArray(list) ? list : [];
}

function writeOutbox(dataDir: string, messages: OutboundMessage[]): void {
  // Newest last, trimmed from the front: a long-running agent must not grow
  // this file forever.
  writeJson(outboxPath(dataDir), messages.slice(-MAX_HISTORY));
}

/**
 * Queue a message for delivery.
 *
 * Recorded first, delivered second. If the process dies between the two, the
 * message survives and is delivered on the next drain — which is the whole
 * reason this is a queue.
 */
export function enqueue(
  dataDir: string,
  message: Omit<OutboundMessage, 'id' | 'createdAt' | 'pending'> & { channels: ChannelId[] },
): OutboundMessage {
  const record: OutboundMessage = {
    id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    agentId: message.agentId,
    agentName: message.agentName,
    summary: message.summary,
    body: message.body,
    createdAt: Date.now(),
    pending: [...message.channels],
  };

  const all = readOutbox(dataDir);
  all.push(record);
  writeOutbox(dataDir, all);
  fileLog('[channels] queued', record.summary.slice(0, 60), 'for', record.pending.join(', '));
  return record;
}

/**
 * Deliver everything the given channels can currently handle.
 *
 * Called by whichever process has the capability: the desktop app drains
 * `desktop` when it opens, the daemon drains `telegram` continuously. Each
 * channel only ever removes itself from a message's pending list, so two
 * processes draining at once cannot deliver the same thing twice.
 */
export async function drain(
  dataDir: string,
  deliverers: ChannelDeliverer[],
): Promise<number> {
  if (deliverers.length === 0) return 0;

  const all = readOutbox(dataDir);
  const mine = new Set(deliverers.map((d) => d.id));
  let delivered = 0;

  for (const message of all) {
    for (const channel of [...message.pending]) {
      if (!mine.has(channel)) continue;
      const deliverer = deliverers.find((d) => d.id === channel)!;

      try {
        const ok = await deliverer.deliver(message);
        if (ok) {
          message.pending = message.pending.filter((c) => c !== channel);
          delivered++;
        }
        // false means "not now" — left pending for the next drain.
      } catch (err) {
        /*
         * A throw means this channel cannot deliver this message at all: a
         * malformed chat id, a revoked token. Retrying forever would mean
         * every later message queues behind a permanent failure, so it is
         * recorded and dropped from the pending list.
         */
        message.pending = message.pending.filter((c) => c !== channel);
        message.failures = { ...message.failures, [channel]: (err as Error).message };
        fileLog('[channels] permanent failure on', channel, (err as Error).message);
      }
    }
  }

  if (delivered > 0 || all.some((m) => m.failures)) writeOutbox(dataDir, all);
  return delivered;
}

/** Messages still waiting on a channel. */
export function pending(dataDir: string, channel?: ChannelId): OutboundMessage[] {
  return readOutbox(dataDir).filter((m) =>
    channel ? m.pending.includes(channel) : m.pending.length > 0,
  );
}

/** Recent messages, newest first, for showing the user what was sent. */
export function history(dataDir: string, limit = 50): OutboundMessage[] {
  return readOutbox(dataDir).slice(-limit).reverse();
}

/** Forget everything. Used when a user clears their notification history. */
export function clearOutbox(dataDir: string): void {
  try {
    fs.rmSync(outboxPath(dataDir), { force: true });
  } catch {
    /* already gone */
  }
}
