/**
 * room-dispatch.ts — running a room's agents where they actually live.
 *
 * `runRoomTurn` calls `runPrompt` for every speaker, which is right when
 * every agent is on this machine and wrong the moment one is not. An agent
 * belongs to exactly one node: its workspace, its files and its provider key
 * are there, and running it here would give it none of them.
 *
 * ## Client-relayed, and honest about it
 *
 * `docs/DISTRIBUTED.md` is explicit that nodes do not know about each other
 * and there is no coordinator — only the client knows the nodes. So the
 * client carries room traffic:
 *
 * ```
 *        Windows agent          Linux agent
 *             ▲                      ▲
 *             │                      │
 *          desktop ──────────────────┘
 *             │
 *        local agent
 * ```
 *
 * That means a multi-node room needs a connected client, and pauses without
 * one. Single-node agents and routines keep running regardless, because they
 * never needed the relay.
 *
 * Saying so is the point. A room host with failover or true peer replication
 * would remove the limitation and both are considerably more to get wrong;
 * claiming either without building it would be worse than the limitation.
 */
import type { AgentParticipant } from '@wispcrew/shared';
import { fileLog } from './filelog.js';
import * as store from './store.js';

/**
 * Ask another node to run a turn for one of its agents.
 *
 * Injected rather than imported: the runtime has no idea what a node link
 * is, and must not — it runs inside the daemon as readily as the desktop.
 */
export type RemoteRunner = (
  nodeId: string,
  agentId: string,
  text: string,
) => Promise<void>;

let remoteRunner: RemoteRunner | null = null;

/**
 * Install the relay.
 *
 * The desktop does this at startup. A daemon does not: it has no node
 * registry, so a room it hosts can only run the agents it owns.
 */
export function setRemoteRunner(runner: RemoteRunner | null): void {
  remoteRunner = runner;
}

export interface Placement {
  /** Agents this machine owns and can run itself. */
  local: AgentParticipant[];
  /** Agents belonging to another node, grouped by node. */
  remote: { nodeId: string; agents: AgentParticipant[] }[];
  /**
   * Agents on a node with no relay installed or no link open.
   *
   * Reported rather than silently skipped: a message that reaches nobody
   * and says nothing is indistinguishable from a broken application.
   */
  unreachable: AgentParticipant[];
}

/** Sort a room's speakers by where they can actually run. */
export function placeSpeakers(speakers: AgentParticipant[]): Placement {
  const local: AgentParticipant[] = [];
  const byNode = new Map<string, AgentParticipant[]>();
  const unreachable: AgentParticipant[] = [];

  for (const speaker of speakers) {
    const agent = store.listAgents().find((a) => a.id === speaker.id);
    const nodeId = agent?.nodeId;

    if (!nodeId) {
      local.push(speaker);
      continue;
    }

    if (!remoteRunner) {
      // No relay: a daemon, or a desktop that has not installed one.
      unreachable.push(speaker);
      continue;
    }

    const existing = byNode.get(nodeId) ?? [];
    existing.push(speaker);
    byNode.set(nodeId, existing);
  }

  return {
    local,
    remote: [...byNode].map(([nodeId, agents]) => ({ nodeId, agents })),
    unreachable,
  };
}

/**
 * Run one agent on its own node.
 *
 * Returns an error message rather than throwing, so one unreachable machine
 * does not take down the agents that answered.
 */
export async function runRemote(
  nodeId: string,
  agent: AgentParticipant,
  text: string,
): Promise<string | undefined> {
  if (!remoteRunner) return 'no connection to that machine';

  try {
    await remoteRunner(nodeId, agent.id, text);
    return undefined;
  } catch (err) {
    const message = (err as Error).message;
    fileLog('[room] remote run failed', nodeId, agent.handle, message);
    return message;
  }
}

/** Whether cross-node dispatch is possible at all in this process. */
export function canReachOtherNodes(): boolean {
  return remoteRunner !== null;
}
