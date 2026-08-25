/**
 * node-server.ts — expose the engine to clients over a stream.
 *
 * Transport-agnostic on purpose: it is handed a `net.Server` that is already
 * listening, so the same code serves a Unix socket, a Windows named pipe, or
 * a TLS socket for a remote node. Only the listener differs.
 *
 * ## This is a remote-code-execution surface
 *
 * The methods behind it run shell commands and write files. Therefore:
 *
 *  - A connection is authenticated *before* it can call anything. The first
 *    frame must be `hello` with a valid token; anything else closes the
 *    socket.
 *  - Token comparison is constant-time, so a wrong token cannot be guessed
 *    byte by byte from timing.
 *  - There is no "local connections are trusted" shortcut. Any process on
 *    the machine can reach a loopback socket, so localhost is not an
 *    authorisation boundary.
 */
import type { Server, Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import type { BridgeEvent } from '@wispcrew/shared';
import { addEventSink } from './engine-events.js';
import type { PairingWindow } from './pairing.js';
import { fileLog } from './filelog.js';
import {
  decodeFrames,
  encodeFrame,
  PROTOCOL_VERSION,
  type RequestFrame,
  type HelloFrame,
} from './protocol.js';

/** Handles one bridge method call. */
export type MethodHandler = (method: string, args: unknown[]) => Promise<unknown>;

export interface NodeServerOptions {
  /** An already-listening server. */
  server: Server;
  /** Shared secret a client must present. */
  token: string;
  /** Name reported to clients, e.g. the hostname. */
  nodeName: string;
  /** Dispatches an authenticated call to the engine. */
  onCall: MethodHandler;
  /**
   * Open pairing window, when the node is accepting new clients.
   *
   * Absent means pairing is closed and a `pair` frame is refused — a node
   * should only be pairable when its owner has just asked for it, not
   * permanently.
   */
  pairing?: PairingWindow;
}

/**
 * Compare tokens without leaking length or content through timing.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself be a
 * signal, so both sides are hashed to a fixed width first by padding to the
 * longer length.
 */
function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still do a comparison of equal-length buffers so the failure path
    // costs roughly the same as a wrong-but-same-length token.
    const filler = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, filler);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function serveNode(options: NodeServerOptions): { close(): Promise<void> } {
  const { server, token, nodeName, onCall } = options;
  const connections = new Set<Socket>();

  /*
   * A TLS server emits `secureConnection`, not `connection`.
   *
   * `connection` does fire on a tls.Server — with the *raw* TCP socket,
   * before the handshake. Reading from it yields ciphertext, and writing to
   * it produces bytes the client cannot interpret. The symptom was a node
   * that silently ignored every frame: the client connected fine, sent a
   * pairing request, and received nothing at all.
   *
   * Detecting the server kind here keeps one implementation for both
   * transports, which is the point of taking a listening server rather than
   * creating one.
   */
  const isTls = typeof (server as { setSecureContext?: unknown }).setSecureContext === 'function';
  const connectionEvent = isTls ? 'secureConnection' : 'connection';

  server.on(connectionEvent, (socket: Socket) => {
    connections.add(socket);
    socket.setEncoding('utf8');

    let authenticated = false;
    let buffered = '';
    let detachEvents: (() => void) | null = null;

    const send = (frame: Parameters<typeof encodeFrame>[0]) => {
      if (!socket.destroyed) socket.write(encodeFrame(frame));
    };

    const shutdown = () => {
      detachEvents?.();
      detachEvents = null;
      connections.delete(socket);
      if (!socket.destroyed) socket.destroy();
    };

    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const { frames, rest } = decodeFrames(buffered);
      buffered = rest;

      for (const raw of frames) {
        const frame = raw as HelloFrame | RequestFrame;

        if (!authenticated) {
          /*
           * Pairing: the one exchange allowed without a token.
           *
           * Only while the owner has explicitly opened a window, only once
           * per window, and the connection is closed straight afterwards so
           * a paired client reconnects normally with its new token.
           */
          if ((frame as { t?: string }).t === 'pair') {
            const claimed = options.pairing?.claim(
              String((frame as { code?: unknown }).code ?? ''),
            );
            if (claimed) {
              fileLog('[node] paired a new client');
              send({ t: 'paired', token: claimed, nodeName, version: PROTOCOL_VERSION });
            } else {
              // One message for wrong, expired and closed alike: saying which
              // would tell an attacker whether a guess was close.
              fileLog('[node] pairing refused');
              send({ t: 'pair-failed', message: 'That pairing code is not valid.' });
            }
            /*
             * `end`, not `destroy`.
             *
             * `destroy` discards anything still buffered, so the frame just
             * written never left the machine and the client saw only a
             * closed socket — a refusal that looked like a network fault.
             * `end` flushes first, then closes.
             */
            detachEvents?.();
            connections.delete(socket);
            socket.end();
            return;
          }

          // Nothing but `hello` is accepted before authentication — not even
          // a harmless-looking read. The method table stays unreachable.
          if (frame?.t !== 'hello' || typeof frame.token !== 'string') {
            fileLog('[node] rejected: first frame was not hello');
            shutdown();
            return;
          }
          if (!tokensMatch(frame.token, token)) {
            fileLog('[node] rejected: bad token');
            shutdown();
            return;
          }
          authenticated = true;
          send({ t: 'welcome', nodeName, version: PROTOCOL_VERSION });

          // Only now does this connection start receiving engine events.
          detachEvents = addEventSink((event: BridgeEvent) => {
            send({ t: 'evt', event });
          });
          continue;
        }

        if (frame?.t !== 'req' || typeof frame.id !== 'number') continue;

        void onCall(frame.method, frame.args ?? [])
          .then((value) => send({ t: 'res', id: frame.id, value }))
          .catch((err: Error) =>
            send({ t: 'err', id: frame.id, message: err?.message ?? String(err) }),
          );
      }
    });

    socket.on('error', (err) => {
      // A client that vanishes mid-write is normal, not exceptional.
      fileLog('[node] socket error', err.message);
      shutdown();
    });
    socket.on('close', shutdown);
  });

  return {
    close() {
      for (const socket of connections) socket.destroy();
      connections.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
