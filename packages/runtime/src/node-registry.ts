/**
 * node-registry.ts — the machines a client has paired with.
 *
 * A client remembers each node's address, token and pinned fingerprint so it
 * can reconnect without pairing again. This is a *client-side* record: nodes
 * do not know about each other, and there is no coordinator.
 *
 * ## Why tokens live in the encrypted store
 *
 * A node token grants shell access on that machine for as long as it exists.
 * That is at least as sensitive as an API key, so it is kept the same way —
 * in `ghostbot-secrets.enc`, never in the plaintext settings file, and never
 * handed to the renderer.
 *
 * The rest of a node's record — name, address, fingerprint — is not secret
 * and lives in plain JSON, so a user can read, back up or hand-edit their
 * node list.
 */
import type { PairedNode } from './pairing.js';
import path from 'node:path';
import { readJson, writeJson } from './store.js';
import { getSecret, removeSecrets, upsertSecrets } from './secrets-store.js';
import { fileLog } from './filelog.js';

const NODES_FILE = 'nodes.json';

/** Where a node's token is kept in the encrypted store. */
function tokenKey(nodeId: string): string {
  return `GHOSTBOT_NODE_TOKEN_${nodeId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** A node as stored on disk: everything except the token. */
type StoredNode = Omit<PairedNode, 'token'>;

function readNodes(dataDir: string): StoredNode[] {
  const list = readJson<StoredNode[]>(path.join(dataDir, NODES_FILE), []);
  return Array.isArray(list) ? list : [];
}

/**
 * Every paired node, without tokens.
 *
 * This is what reaches the UI. A node list is useful to display; the tokens
 * in it are not, and sending them to a renderer would undo the reason they
 * are encrypted.
 */
export function listNodes(dataDir: string): StoredNode[] {
  return readNodes(dataDir);
}

/** A node with its token, for actually connecting. */
export function getNode(dataDir: string, nodeId: string): PairedNode | null {
  const record = readNodes(dataDir).find((n) => n.id === nodeId);
  if (!record) return null;
  const token = getSecret(dataDir, tokenKey(nodeId));
  if (!token) {
    // The record survived but its credential did not — most likely a secrets
    // store written by another backend. Say so rather than failing later with
    // an opaque authentication error.
    fileLog('[nodes] no token stored for', nodeId);
    return null;
  }
  return { ...record, token };
}

/** Record a newly paired node. */
export function addNode(
  dataDir: string,
  node: Omit<PairedNode, 'id' | 'pairedAt'> & { id?: string },
): StoredNode {
  const id = node.id ?? `node_${Date.now().toString(36)}`;
  const record: StoredNode = {
    id,
    name: node.name,
    address: node.address,
    fingerprint: node.fingerprint,
    pairedAt: Date.now(),
  };

  const others = readNodes(dataDir).filter((n) => n.id !== id);
  writeJson(path.join(dataDir, NODES_FILE), [...others, record]);
  upsertSecrets(dataDir, [{ key: tokenKey(id), value: node.token }]);
  fileLog('[nodes] paired', node.name, node.address);
  return record;
}

/**
 * Forget a node.
 *
 * Removes the token too. Leaving a credential behind for a node the user has
 * deliberately removed would be a quiet way to keep access they thought they
 * had revoked.
 */
export function removeNode(dataDir: string, nodeId: string): void {
  writeJson(
    path.join(dataDir, NODES_FILE),
    readNodes(dataDir).filter((n) => n.id !== nodeId),
  );
  removeSecrets(dataDir, [tokenKey(nodeId)]);
  fileLog('[nodes] removed', nodeId);
}

/** Note that a node answered, so the UI can show what is reachable. */
export function markNodeSeen(dataDir: string, nodeId: string): void {
  const nodes = readNodes(dataDir);
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return;
  node.lastSeenAt = Date.now();
  writeJson(path.join(dataDir, NODES_FILE), nodes);
}
