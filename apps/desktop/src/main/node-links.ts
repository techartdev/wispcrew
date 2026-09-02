/**
 * node-links.ts — live connections to the machines a user has paired.
 *
 * The desktop keeps one connection per reachable node and routes an agent's
 * calls to whichever node owns it. Connections are made lazily and dropped
 * quietly: a node that is asleep, unplugged or on another network is a
 * normal state, not an error to interrupt someone with.
 */
import {
  connectRemoteNode,
  fileLog,
  getNode,
  listNodes,
  markNodeSeen,
  parseAddress,
  type NodeClient,
} from '@wispcrew/runtime';

/** Methods whose FIRST argument is an agent id. */
const AGENT_SCOPED = new Set([
  'sendPrompt',
  'getTranscript',
  'clearTranscript',
  'clearConversation',
  'stopAgent',
  'interrupt',
  'updateAgent',
  'deleteAgent',
  'duplicateAgent',
  'rewindConversation',
  'branchConversation',
  // A remote agent's transcript lives on its node, so its saved versions do
  // too. Answering these locally would list this machine's checkpoints for a
  // conversation that never happened here.
  'listHistory',
  'restoreHistory',

  /*
   * Room methods, which this list predated.
   *
   * `sendPrompt` was here and `sendToRoom` was not, so a message to an agent
   * on another machine ran against the LOCAL daemon — which has no room for
   * it. The call succeeded, wrote nothing, and returned: the message never
   * appeared in the conversation and nothing reported a failure, because
   * `sendToRoom` is deliberately fire-and-forget.
   *
   * Reported as "I type a message and nothing happens", which is exactly how
   * it looks from the outside.
   *
   * All of these take a conversation id first, and an agent's own room
   * shares its id — so the existing routing works unchanged.
   */
  'sendToRoom',
  'addRoomAgent',
  'removeRoomParticipant',
  'setRoomMode',
  'setRoomGreeting',
  'deleteRoom',
  'getContextReport',
  'compactConversation',
  'renameConversation',
  'listTurns',
  'cancelTurn',
]);

/**
 * Which providers a particular machine can actually use.
 *
 * `getPresets` reports what is *configured*, and the Configure panel filters
 * its model list by exactly that — so for an agent on another machine it
 * offered this one's providers. A ChatGPT subscription model was selectable
 * for an agent on a VPS that has only Ollama, LM Studio and an NVIDIA key: a
 * choice that looks valid, saves cleanly, and cannot work.
 *
 * `getPresets` takes no arguments and the renderer fetches it once at
 * startup, so it cannot be routed by the ordinary rule. This asks a specific
 * node instead, and the panel calls it when editing a remote agent.
 */
export async function presetsForNode(nodeId: string): Promise<unknown[] | null> {
  const link = existingLink(nodeId);
  if (!link) return null;

  try {
    return await link.call<unknown[]>('getPresets');
  } catch {
    // A machine that cannot answer is one the user should be told about
    // rather than silently given this machine's list for.
    return null;
  }
}

interface Link {
  client: NodeClient;
  nodeId: string;
}

const links = new Map<string, Link>();

/**
 * Connect to a node, reusing an existing link.
 *
 * Returns null when the node cannot be reached. The caller falls back to the
 * local engine or reports the agent as unavailable — a paired laptop that is
 * closed should not make the app feel broken.
 */
export async function linkToNode(
  dataDir: string,
  nodeId: string,
  onEvent: (event: unknown) => void,
): Promise<NodeClient | null> {
  const existing = links.get(nodeId);
  if (existing) return existing.client;

  const node = getNode(dataDir, nodeId);
  if (!node) {
    fileLog('[nodes] no record or token for', nodeId);
    return null;
  }

  nodeNames.set(nodeId, node.name);
  const { host, port } = parseAddress(node.address);
  try {
    const client = await connectRemoteNode(
      { host, port, fingerprint: node.fingerprint, token: node.token },
      {
        clientName: 'wispcrew-desktop',
        onEvent,

        /*
         * A node asking this desktop for permission.
         *
         * Before this, an agent on another machine that needed a tool had
         * nobody to ask: the node parked the request until it timed out as
         * a denial, and the conversation hung with no card and no
         * explanation. Measured — asking the VPS agent to run `date`
         * produced only run-state events and zero approval cards.
         *
         * Routed through the same function a local request uses, so the
         * card, the standing grants and "always allow" stay one
         * implementation rather than two that drift.
         */
        onAsk: async (request) =>
          (await onAsk?.(request.agentId, {
            toolName: request.tool,
            summary: request.summary,
            detail: request.detail,
            /*
             * The node already wrote the card into its own transcript, so
             * the desktop must resolve THAT id and must not write a second
             * entry into a store the conversation is not reading from.
             */
            requestId: request.requestId,
            alreadyShown: true,
          }))
            ? 'allow-once'
            : 'deny',

        onClose: () => {
          // Drop the link so the next call reconnects rather than writing
          // into a dead socket.
          links.delete(nodeId);
          fileLog('[nodes] disconnected from', node.name);
        },
        timeoutMs: 8000,
      },
    );
    links.set(nodeId, { client, nodeId });
    markNodeSeen(dataDir, nodeId);
    fileLog('[nodes] connected to', node.name);
    return client;
  } catch (err) {
    fileLog('[nodes] could not reach', node.name, (err as Error).message);
    return null;
  }
}

/** An already-open link, without attempting to connect. */
export function existingLink(nodeId: string): NodeClient | null {
  return links.get(nodeId)?.client ?? null;
}

/**
 * Which node should serve this call, if any.
 *
 * Only returns a link that is already open: a bridge method is synchronous
 * at this point, and blocking every call on a possibly-unreachable node
 * would make the whole UI wait on a sleeping Raspberry Pi. Connections are
 * established in the background by `connectKnownNodes`.
 */
/**
 * The name a person gave a machine, for an error they have to act on.
 *
 * "node_mtafffpj is not connected" tells nobody anything; "evtinsait-host1
 * is not connected" names the thing they can go and check.
 *
 * Remembered when a link is attempted, because `routeForCall` has no
 * `dataDir` to look one up with and threading one through every caller to
 * improve an error message is the wrong trade.
 */
const nodeNames = new Map<string, string>();

/**
 * Who answers when a node asks this desktop for permission.
 *
 * Set once at startup. Null until then, and a node that asks before it is
 * set gets a denial — the safe answer, and the same one it would reach by
 * timing out.
 */
let onAsk:
  | ((
      agentId: string,
      req: {
        toolName: string;
        summary: string;
        detail?: string;
        requestId?: string;
        alreadyShown?: boolean;
      },
    ) => Promise<boolean>)
  | null = null;

export function setNodeApprovalAsker(
  asker: (
    agentId: string,
    req: {
      toolName: string;
      summary: string;
      detail?: string;
      requestId?: string;
      alreadyShown?: boolean;
    },
  ) => Promise<boolean>,
): void {
  onAsk = asker;
}

export function routeForCall(
  agentNodeOf: (agentId: string) => string | undefined,
  method: string,
  args: unknown[],
): NodeClient | null {
  /*
   * `createAgent` names its node in the patch, not as an agent id.
   *
   * Every other routed method takes an existing agent's id as its first
   * argument. This one creates the agent, so there is no id yet — the node
   * is chosen by the caller and travels in `patch.nodeId`.
   *
   * Without this the call was forwarded to the local daemon like any other,
   * and an agent assigned to a VPS was created on this machine instead:
   * correct node shown in the interface, nothing on the node itself, and a
   * message to it silently doing nothing.
   */
  if (method === 'createAgent') {
    const patch = args[0] as { nodeId?: string } | undefined;
    return patch?.nodeId ? existingLink(patch.nodeId) : null;
  }

  if (!AGENT_SCOPED.has(method)) return null;
  const agentId = args[0];
  if (typeof agentId !== 'string') return null;

  const nodeId = agentNodeOf(agentId);
  if (!nodeId) return null; // genuinely local

  const link = existingLink(nodeId);
  if (link) return link;

  /*
   * The agent belongs to another machine, and that machine is not connected.
   *
   * Returning null here meant "run it locally", and the local daemon has no
   * room for an agent that lives elsewhere — so `runRoomTurn` created one,
   * the message went into a conversation nobody was looking at, and the
   * composer cleared as though it had been sent. The user typed "hey",
   * pressed Enter, and watched the text disappear.
   *
   * Failing is the only honest answer: an agent's conversation, files and
   * keys live on its own machine, so a turn that cannot reach that machine
   * has not happened. Silently doing it here would also write to the wrong
   * store.
   */
  throw new Error(
    `${nodeNames.get(nodeId) ?? 'That machine'} is not connected, so this agent cannot be reached. ` +
      'Check it under Machines.',
  );
}

/**
 * Open links to every paired node, in the background.
 *
 * Failures are logged and otherwise ignored: this runs at startup, and a
 * node being unreachable must not delay or break launching.
 */
export async function connectKnownNodes(
  dataDir: string,
  onEvent: (event: unknown) => void,
): Promise<void> {
  const nodes = listNodes(dataDir);
  if (nodes.length === 0) return;
  await Promise.all(
    nodes.map((node) =>
      linkToNode(dataDir, node.id, onEvent).catch(() => null),
    ),
  );
}

/** Close every link. Used at quit. */
export function closeNodeLinks(): void {
  for (const { client } of links.values()) client.close();
  links.clear();
}
