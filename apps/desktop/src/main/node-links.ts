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
]);

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

  const { host, port } = parseAddress(node.address);
  try {
    const client = await connectRemoteNode(
      { host, port, fingerprint: node.fingerprint, token: node.token },
      {
        clientName: 'wispcrew-desktop',
        onEvent,
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
export function routeForCall(
  agentNodeOf: (agentId: string) => string | undefined,
  method: string,
  args: unknown[],
): NodeClient | null {
  if (!AGENT_SCOPED.has(method)) return null;
  const agentId = args[0];
  if (typeof agentId !== 'string') return null;

  const nodeId = agentNodeOf(agentId);
  if (!nodeId) return null; // local agent
  return existingLink(nodeId);
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
