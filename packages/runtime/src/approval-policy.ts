/**
 * approval-policy.ts — who may authorise what, from where.
 *
 * A keyboard you are sitting at and a chat reachable by anyone who
 * compromises your Telegram account are not the same risk. Sharing one
 * policy between them forces a choice nobody should have to make: either
 * approve everything twice, or grant a remote channel the same authority as
 * physical presence.
 *
 * So policy resolves in three steps:
 *
 *   1. the agent's setting for THIS channel   (most specific)
 *   2. the agent's setting                     (anywhere)
 *   3. the global default                      (`ask`)
 *
 * ## The rule that matters
 *
 * A remote channel does not inherit `auto`.
 *
 * An agent set to run unattended at the desk is a statement about trusting
 * that agent while you are watching it. It is not a statement about letting
 * anyone with your phone run shell commands on your machine. So `auto`
 * inherited from a lower level becomes `ask` when the request arrives from
 * a remote door — unless the user set `auto` for that door explicitly, which
 * is the YOLO they asked for and got deliberately rather than by accident.
 */
import type { AgentRecord, ApprovalPolicy, ChannelId, GlobalSettings } from '@wispcrew/shared';

/**
 * Channels that are not physical presence at this machine.
 *
 * `app` and `desktop` both mean "someone is at the computer". Telegram does
 * not: it means "someone holds a credential that can reach the computer",
 * which is a different and weaker claim.
 */
const REMOTE_CHANNELS: ReadonlySet<ChannelId> = new Set<ChannelId>(['telegram']);

export function isRemoteChannel(channel: ChannelId | undefined): boolean {
  return channel !== undefined && REMOTE_CHANNELS.has(channel);
}

/** Per-channel overrides, stored on the agent. */
export type ChannelPolicies = Partial<Record<ChannelId, ApprovalPolicy>>;

export interface PolicyResolution {
  policy: ApprovalPolicy;
  /**
   * Why, in one phrase — shown to the user and written to the transcript
   * when a remote request is downgraded, because "it asked me again" is
   * otherwise indistinguishable from a bug.
   */
  reason: string;
  /** True when an inherited `auto` was reduced because the door is remote. */
  downgraded: boolean;
}

/**
 * Resolve the policy for one request.
 *
 * `channel` is where the request came from — undefined means the local app,
 * which is the ordinary case and never downgraded.
 */
export function resolvePolicy(
  agent: AgentRecord | undefined,
  settings: GlobalSettings,
  channel?: ChannelId,
): PolicyResolution {
  const perChannel = channel
    ? (agent?.channelPolicies as ChannelPolicies | undefined)?.[channel]
    : undefined;

  // An explicit per-channel setting is the user's last word. Even `auto` on
  // a remote channel stands: they said it about that door specifically.
  if (perChannel) {
    return {
      policy: perChannel,
      reason: `set for ${channel} on this agent`,
      downgraded: false,
    };
  }

  const inherited = agent?.approvalPolicy ?? settings.approvalPolicy ?? 'ask';
  const from = agent?.approvalPolicy ? 'this agent' : 'the global default';

  /*
   * The downgrade.
   *
   * `readonly` is already more restrictive than `ask`, so it passes through
   * — reducing it further would be meaningless. Only `auto` is affected,
   * because only `auto` grants authority without a human present.
   */
  if (inherited === 'auto' && isRemoteChannel(channel)) {
    return {
      policy: 'ask',
      reason: `${from} allows this automatically, but the request came from ${channel}`,
      downgraded: true,
    };
  }

  return { policy: inherited, reason: `from ${from}`, downgraded: false };
}

/**
 * A sentence for the transcript when a remote request was downgraded.
 *
 * Recorded as a room event so it is visible to everyone in the room, not
 * only to whoever happened to be looking — and so a user who wonders why
 * their `auto` agent is asking can see the answer rather than guess.
 */
export function downgradeNotice(agentName: string, channel: ChannelId): string {
  /*
   * Say WHERE, not just that a setting exists.
   *
   * "Set a per-channel policy to change that" named a thing without naming
   * its home, so somebody approving the same read-only check for the fourth
   * time reasonably concluded there was no way to stop being asked: "how am
   * I supposed to approve these permanently? Each time I need to approve on
   * each new request?"
   *
   * The setting was there the whole time, one panel away, labelled exactly
   * this. Advice that cannot be acted on is worse than none, because it
   * suggests the reader missed something.
   */
  const where =
    channel === 'telegram'
      ? `Configure ${agentName} \u2192 "When asked from Telegram" to stop being asked.`
      : `Set a per-channel policy in Configure ${agentName} to change that.`;

  return (
    `${agentName} runs automatically here, but this request came from ${channel}, ` +
    `so it needs approval. ${where}`
  );
}
