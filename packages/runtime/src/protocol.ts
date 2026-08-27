/**
 * protocol.ts — the wire format between a WispCrew client and a node.
 *
 * Deliberately boring: newline-delimited JSON over a stream. Every bridge
 * method becomes a request with an id; every engine event becomes an
 * unsolicited frame. The same shape works over a Unix socket, a Windows
 * named pipe and a TLS connection, which is why the local case and the
 * remote case do not need separate protocols.
 *
 * ## Why not JSON-RPC or gRPC
 *
 * Both would work. Neither earns its dependency here: the surface is 42
 * methods that already exist as a typed interface, the transport is a
 * stream, and hand-writing the framing is about eighty lines that anyone
 * can read. This app runs shell commands, so every dependency is a
 * supply-chain decision.
 *
 * ## Framing
 *
 * One JSON object per line, UTF-8. A line is a complete frame — no length
 * prefixes, no partial parses. Newlines inside strings are escaped by
 * `JSON.stringify`, so a payload can never split a frame.
 */

/** A method call from client to node. */
export interface RequestFrame {
  t: 'req';
  /** Correlates the response; unique per connection. */
  id: number;
  method: string;
  args: unknown[];
}

/** A successful result. */
export interface ResponseFrame {
  t: 'res';
  id: number;
  value: unknown;
}

/**
 * A failed call.
 *
 * The message is carried as a string rather than a serialised Error: only
 * the message survives a JSON round-trip anyway, and pretending otherwise
 * invites callers to inspect properties that will not be there.
 */
export interface ErrorFrame {
  t: 'err';
  id: number;
  message: string;
}

/** An engine event, pushed without being asked for. */
export interface EventFrame {
  t: 'evt';
  event: unknown;
}

/**
 * The node asking a connected client for permission.
 *
 * This is the one frame the node initiates and waits on, and it exists
 * because approvals could not cross the wire at all: an agent on a VPS that
 * needed the shell had nobody to ask, so the request parked until it timed
 * out as a denial and the conversation hung with no card and no explanation.
 *
 * Deliberately shaped like a request in reverse — `id` correlates the
 * answer, exactly as `RequestFrame` does — so both directions are one
 * mechanism rather than two that drift.
 */
export interface AskFrame {
  t: 'ask';
  /** Correlates the decision; unique per connection. */
  id: number;
  agentId: string;
  agentName: string;
  tool: string;
  summary: string;
}

/**
 * A client's decision.
 *
 * `deny` is the only safe default, so anything that is not an explicit
 * allow is treated as one — including an unknown value from a client
 * speaking a newer dialect, and a connection that drops before answering.
 */
export interface DecisionFrame {
  t: 'decision';
  id: number;
  /** The engine's own vocabulary, so nothing has to be translated. */
  resolution: 'allow-once' | 'allow-always' | 'deny';
}

/**
 * The first frame a client sends.
 *
 * Authentication happens before anything else, and an unauthenticated
 * connection can do nothing at all — this process runs shell commands, so a
 * connection that reaches the method table without a token is a remote code
 * execution hole.
 */
export interface HelloFrame {
  t: 'hello';
  token: string;
  /** Client build, for diagnostics and future compatibility checks. */
  client: string;
}

/** The node's answer to `hello`. */
export interface WelcomeFrame {
  t: 'welcome';
  nodeName: string;
  /** Protocol version; a mismatch is reported rather than guessed around. */
  version: number;
}

/**
 * A pairing attempt: the only frame accepted without a token.
 *
 * Carries the short code the node is displaying, exchanged once for a
 * long-lived token. See pairing.ts for why the code is short-lived and the
 * token is never spoken aloud.
 */
export interface PairFrame {
  t: 'pair';
  code: string;
  /** Client build, recorded so a user can recognise what they paired. */
  client: string;
}

/** A successful pairing: here is your token, reconnect with it. */
export interface PairedFrame {
  t: 'paired';
  token: string;
  nodeName: string;
  version: number;
}

/**
 * A refused pairing.
 *
 * Deliberately one message for wrong, expired and closed: distinguishing
 * them would tell someone guessing whether they were close.
 */
export interface PairFailedFrame {
  t: 'pair-failed';
  message: string;
}

export type ClientFrame = HelloFrame | RequestFrame | PairFrame | DecisionFrame;
export type NodeFrame =
  | WelcomeFrame
  | ResponseFrame
  | ErrorFrame
  | EventFrame
  | AskFrame
  | PairedFrame
  | PairFailedFrame;

/**
 * Bumped when a change would break an older client.
 *
 * Still 1 after adding `ask`/`decision`: an older client never sends a
 * decision, and an older node never asks. Both sides ignore a frame they do
 * not know, and the node's timeout still denies — so a version mismatch
 * degrades to exactly the behaviour that existed before, rather than
 * breaking a connection that otherwise works.
 */
export const PROTOCOL_VERSION = 1;

/** Serialise a frame for the wire. */
export function encodeFrame(frame: ClientFrame | NodeFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Split a buffer into complete frames, returning the unconsumed remainder.
 *
 * Streams do not respect message boundaries: one read may carry half a
 * frame, or three and a half. The leftover is handed back so the caller can
 * prepend it to the next chunk — without this, a large transcript entry
 * arriving in two packets would be a parse error.
 */
export function decodeFrames(buffer: string): { frames: unknown[]; rest: string } {
  const frames: unknown[] = [];
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline === -1) break;
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (!line) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      // A malformed line is dropped rather than killing the connection: one
      // corrupt frame should not end a session that is otherwise healthy.
    }
  }
  return { frames, rest };
}
