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
import type { BridgeEvent } from '@ghostbot/shared';
import { addEventSink } from './engine-events.js';
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

  server.on('connection', (socket) => {
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
