/**
 * notify-host.ts — deciding where an agent's message may go.
 *
 * The tool asks; this decides. Keeping the two apart means the tool package
 * needs no store, no settings and no network, and the policy about who may
 * reach the user lives in one readable place.
 */
import type { AgentRecord, ChannelId, GlobalSettings } from '@wispcrew/shared';
import { setNotifySender } from '@wispcrew/tools';
import { drain, enqueue, type ChannelDeliverer } from './channels.js';
import { telegramChannel } from './channel-telegram.js';
import { getSecret } from './secrets-store.js';
import { readSettings } from './settings-file.js';
import { fileLog } from './filelog.js';
import { host } from './host.js';
import * as store from './store.js';

/** Where the Telegram bot token lives in the encrypted store. */
export const TELEGRAM_TOKEN_KEY = 'WISPCREW_TELEGRAM_TOKEN';

/**
 * Is a Telegram bot token actually stored?
 *
 * The settings file carries a `configured` flag, and it was a SECOND record
 * of this fact — set to true whenever the Settings panel saved, with or
 * without a token attached. On the reporter's profile it claimed a token
 * that was not there; the panel duly said "saved; enter a new one to
 * replace it", and every failure downstream blamed Telegram.
 *
 * Both hosts derive it from the store now, through this one function. The
 * desktop and the daemon each build their own settings view — they already
 * report `hasApiKey` this derived way — and two copies of one rule is how
 * this class of bug starts.
 */
export function hasTelegramToken(dataDir: string): boolean {
  return Boolean(getSecret(dataDir, TELEGRAM_TOKEN_KEY));
}

/**
 * A settings object whose `configured` flag tells the truth.
 *
 * Applied by both hosts as the last step of building their settings view.
 */
export function withTelegramTruth<T extends GlobalSettings>(dataDir: string, settings: T): T {
  const telegram = settings.channels?.telegram;
  if (!telegram) return settings;

  return {
    ...settings,
    channels: {
      ...settings.channels,
      telegram: { ...telegram, configured: hasTelegramToken(dataDir) },
    },
  };
}

/**
 * Which channels this agent may use.
 *
 * A per-agent list overrides the global one entirely, including an empty
 * array — an agent explicitly set to stay silent must stay silent, not fall
 * back to the global default.
 *
 * `app` is always included. Writing to the transcript needs no permission
 * and costs nothing, and it means a message is never lost even when every
 * other channel is off.
 */
export function channelsFor(agent: AgentRecord | undefined, settings: GlobalSettings): ChannelId[] {
  const configured = agent?.channels ?? settings.channels?.enabled ?? [];
  return [...new Set<ChannelId>(['app', ...configured])];
}

/**
 * Deliverers this process can actually run.
 *
 * The daemon can reach Telegram but cannot raise a desktop notification; the
 * desktop app is the reverse. Each drains what it can, and anything else
 * stays queued for whichever process can handle it.
 */
export function availableDeliverers(dataDir: string): ChannelDeliverer[] {
  const deliverers: ChannelDeliverer[] = [];

  const settings = readSettings(dataDir, {}) as GlobalSettings;
  const token = getSecret(dataDir, TELEGRAM_TOKEN_KEY);
  const chatId = settings.channels?.telegram?.chatId;

  if (token && chatId) {
    deliverers.push(telegramChannel({ token, chatId }));
  }

  return deliverers;
}

/**
 * Install the sender the notify tool calls.
 *
 * Queues first, then drains what this process can deliver. The queue is what
 * makes "the app was closed" an ordinary case rather than a lost message.
 */
export function installNotifySender(): void {
  setNotifySender(async (summary, body, ctx) => {
    const dataDir = host().dataDir;
    const settings = readSettings(dataDir, {}) as GlobalSettings;

    /*
     * Find the agent from the workspace root.
     *
     * The tool context deliberately carries no agent id — tools act on
     * files and shells, not on records. Rather than widen that contract for
     * one tool, the owning agent is matched by the workspace it was given,
     * falling back to global settings when there is no match.
     */
    const agent = store
      .listAgents()
      .find((a) => a.workspaceRoot && a.workspaceRoot === ctx.workspaceRoot);

    const channels = channelsFor(agent, settings);
    const external = channels.filter((c) => c !== 'app');

    enqueue(dataDir, {
      agentId: agent?.id ?? 'unknown',
      agentName: agent?.name ?? 'WispCrew',
      summary,
      body,
      channels: external,
    });

    // Deliver whatever this process can, now. The rest waits.
    const deliverers = availableDeliverers(dataDir);
    const delivered = await drain(dataDir, deliverers).catch((err: Error) => {
      fileLog('[notify] drain failed', err.message);
      return 0;
    });

    /*
     * Report honestly.
     *
     * "app" always counts as delivered because the message is in the
     * transcript. Anything queued for a process that is not running is
     * reported as queued, not sent — an agent told it reached the user when
     * it did not will simply stop trying.
     */
    const result: string[] = ['the conversation'];
    if (delivered > 0) result.push('a direct message');

    const waiting = external.filter((c) => c === 'desktop').length;
    return {
      delivered: result,
      skipped: waiting > 0 ? 'A desktop notification will appear when the app is open.' : undefined,
    };
  });
}
