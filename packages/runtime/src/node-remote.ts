/**
 * node-remote.ts — connecting to a node across a network.
 *
 * The local case connects to a socket protected by file permissions. This is
 * the other one: a host and port, TLS, and a certificate the client pinned
 * when it paired.
 *
 * ## Trust
 *
 * There is no certificate authority, so `rejectUnauthorized` is false and
 * the fingerprint is checked by hand. That combination is normally a red
 * flag, and it is worth being explicit about why it is right here:
 *
 *  - A user cannot obtain a CA-signed certificate for `raspberrypi.local`.
 *    Requiring one would push them to disable verification altogether.
 *  - Pinning is *stronger* than CA validation for this case: it trusts one
 *    specific machine rather than anything a public CA will vouch for.
 *  - The check is mandatory. A mismatch aborts before a single frame is
 *    sent, so a substituted certificate never sees the token.
 */
import tls from 'node:tls';
import { connectNode, type NodeClient } from './node-client.js';
import { fingerprintMatches } from './pairing.js';
import { decodeFrames, encodeFrame, type NodeFrame } from './protocol.js';

/** Default port for a networked node. Chosen to be memorable and unassigned. */
export const DEFAULT_NODE_PORT = 8787;

export interface RemoteTarget {
  host: string;
  port?: number;
  /** Pinned certificate fingerprint. */
  fingerprint: string;
  token: string;
}

/**
 * Is this a bare IP address rather than a hostname?
 *
 * RFC 6066 forbids sending SNI for an IP literal, and Node warns about it.
 * Nodes are commonly reached by address, so this is the normal case, not an
 * edge one.
 */
function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(':'); // IPv6 literal
}

/** Split `host`, `host:port` or `[v6]:port` into parts. */
export function parseAddress(address: string): { host: string; port: number } {
  const trimmed = address.trim();
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    return { host: bracketed[1]!, port: Number(bracketed[2] ?? DEFAULT_NODE_PORT) };
  }
  const parts = trimmed.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1]!)) {
    return { host: parts[0]!, port: Number(parts[1]) };
  }
  return { host: trimmed, port: DEFAULT_NODE_PORT };
}

/**
 * Open a TLS socket and verify the certificate against a pinned fingerprint.
 *
 * Rejects — and destroys the socket — before returning if it does not match,
 * so no caller can accidentally proceed with an unverified peer.
 */
function connectPinned(
  host: string,
  port: number,
  fingerprint: string,
  timeoutMs: number,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        // No CA exists for a machine the user owns; the fingerprint below is
        // the actual check, and it is not optional.
        rejectUnauthorized: false,
        // Omitted for IP literals: RFC 6066 forbids SNI there.
        ...(isIpLiteral(host) ? {} : { servername: host }),
      },
      () => {
        const peer = socket.getPeerCertificate();
        const presented = peer?.fingerprint256 ?? '';
        if (!fingerprintMatches(fingerprint, presented)) {
          socket.destroy();
          reject(
            new Error(
              `This node presented a different certificate than the one you paired with.\n` +
                `  expected ${fingerprint}\n  received ${presented || '(none)'}\n` +
                'Either the node was reinstalled, or something is impersonating it. ' +
                'Pair again only if you know why it changed.',
            ),
          );
          return;
        }
        resolve(socket);
      },
    );

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}.`));
    });
    socket.on('error', (err) => reject(err));
  });
}

/** Connect to a paired node. */
export async function connectRemoteNode(
  target: RemoteTarget,
  options: {
    clientName?: string;
    onEvent?: (event: unknown) => void;
    onClose?: (reason: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<NodeClient> {
  const port = target.port ?? DEFAULT_NODE_PORT;
  const socket = await connectPinned(
    target.host,
    port,
    target.fingerprint,
    options.timeoutMs ?? 10_000,
  );
  // The handshake succeeded and the pin matched; clear the connect timeout so
  // a long-running idle session is not dropped for being quiet.
  socket.setTimeout(0);

  return connectNode({
    socket,
    token: target.token,
    clientName: options.clientName,
    onEvent: options.onEvent,
    onClose: options.onClose,
  });
}

export interface PairResult {
  token: string;
  nodeName: string;
  fingerprint: string;
}

/**
 * Pair with a node that is displaying a code.
 *
 * The fingerprint is *learned* here rather than checked: this is the first
 * contact, so there is nothing to compare against. That is the one moment of
 * trust in the whole scheme, which is why the node also prints its
 * fingerprint — a cautious user compares the two before continuing.
 */
export async function pairWithNode(
  address: string,
  code: string,
  options: { clientName?: string; timeoutMs?: number; expectFingerprint?: string } = {},
): Promise<PairResult> {
  const { host, port } = parseAddress(address);

  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect(
      { host, port, rejectUnauthorized: false, ...(isIpLiteral(host) ? {} : { servername: host }) },
      () =>
      resolve(s),
    );
    s.setTimeout(options.timeoutMs ?? 10_000, () => {
      s.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}.`));
    });
    s.on('error', reject);
  });

  const fingerprint = socket.getPeerCertificate()?.fingerprint256 ?? '';

  /*
   * If the user was given a fingerprint to expect, honour it.
   *
   * This closes the one gap in the scheme: someone able to intercept the
   * first connection could pair the user with their own node. Comparing the
   * printed fingerprint removes that, and costs nothing when skipped.
   */
  if (options.expectFingerprint && !fingerprintMatches(options.expectFingerprint, fingerprint)) {
    socket.destroy();
    throw new Error(
      'The node presented a different fingerprint than the one you were shown. Not pairing.',
    );
  }

  return new Promise<PairResult>((resolve, reject) => {
    let buffered = '';
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const { frames, rest } = decodeFrames(buffered);
      buffered = rest;
      for (const raw of frames) {
        const frame = raw as NodeFrame;
        if (frame.t === 'paired') {
          socket.end();
          resolve({ token: frame.token, nodeName: frame.nodeName, fingerprint });
          return;
        }
        if (frame.t === 'pair-failed') {
          socket.end();
          reject(new Error(frame.message));
          return;
        }
      }
    });

    socket.on('error', reject);
    socket.on('close', () =>
      reject(new Error('The node closed the connection without pairing.')),
    );

    socket.write(
      encodeFrame({ t: 'pair', code, client: options.clientName ?? 'ghostbot' }),
    );
  });
}
