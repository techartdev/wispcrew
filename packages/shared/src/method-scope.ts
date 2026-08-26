/**
 * method-scope.ts — which side of the wire each bridge method belongs on.
 *
 * With an engine that can live in another process, every method has to
 * answer one question: does this act on *engine state*, or on *this
 * client*?
 *
 *  - **Engine methods** read or write the store, run agents, manage MCP
 *    servers and secrets. They must execute where the engine is, so that a
 *    profile has exactly one writer. Two processes editing one JSON store
 *    silently lose updates — measured, see the note in `store.ts`.
 *
 *  - **Client methods** need a screen, a window, or this application's own
 *    identity. A file picker on a headless VPS is meaningless; the app
 *    version of a remote node is not the version the user is looking at.
 *
 * Keeping the list here rather than inferring it means adding a method
 * forces an explicit decision, instead of defaulting to whichever side the
 * author happened to be editing.
 */

/**
 * Methods that must run on the client, never forwarded to a node.
 *
 * Deliberately short. Anything not listed is an engine method, because the
 * failure mode of wrongly forwarding a local concern (a dialog that never
 * appears) is far easier to notice than the failure mode of wrongly running
 * an engine method locally (a second writer quietly corrupting the store).
 */
export const CLIENT_ONLY_METHODS = [
  /** Opens a native file dialog; a remote node has no screen. */
  'pickFiles',
  /** Same, for directories. */
  'pickDirectory',
  /** Opens a path in the user's file manager — theirs, not the node's. */
  'openPath',
  /** Describes the running application, which differs per client. */
  'getAppInfo',

  /*
   * Node management is the client's own business.
   *
   * The registry of paired machines, their tokens and their pinned
   * fingerprints belong to whoever is doing the pairing. Nodes do not know
   * about each other and there is no coordinator, so forwarding these to an
   * engine asks a question it cannot answer — which is exactly what happened:
   * a daemon replied `Unknown method "listNodes"` and the Machines panel came
   * up empty.
   */
  'listNodes',
  'pairNode',
  'forgetNode',
  /*
   * Addresses a node BY ID rather than being about one agent, so the client
   * has to pick the link itself. Forwarding it would send a node's key to
   * whichever engine answered, which is the opposite of the intent.
   */
  'configureNode',
] as const;

export type ClientOnlyMethod = (typeof CLIENT_ONLY_METHODS)[number];

export function isClientOnlyMethod(method: string): boolean {
  return (CLIENT_ONLY_METHODS as readonly string[]).includes(method);
}

/**
 * Methods that need a human to answer, and therefore only work when a client
 * is attached.
 *
 * These *are* engine methods — they run on the node — but a node with no
 * client attached cannot complete them. The engine denies rather than
 * waiting forever, which is why an unattended routine that hits an approval
 * gate fails cleanly instead of hanging.
 */
export const INTERACTIVE_METHODS = ['resolveApproval', 'oauthSignIn'] as const;

export function isInteractiveMethod(method: string): boolean {
  return (INTERACTIVE_METHODS as readonly string[]).includes(method);
}
