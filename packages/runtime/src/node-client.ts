/**
 * node-client.ts — talk to a GhostBot node over a stream.
 *
 * Presents the same shape the desktop already uses: call a method, await a
 * value, and receive pushed events. The difference is that the engine may be
 * in another process — or on another machine — and may go away mid-call.
 *
 * ## Losing the connection is normal
 *
 * A daemon restarts, a laptop sleeps, a network blips. The client therefore
 * treats disconnection as an expected state rather than an error:
 *
 *  - Pending calls reject immediately with a clear message, instead of
 *    hanging until something times out. A UI that says "the node went away"
 *    is far better than a spinner that never resolves.
 *  - Reconnection is the caller's decision. This module does not silently
 *    retry, because a silent reconnect after a failed call would leave the
 *    user unsure whether their action took effect.
 */
import type { Socket } from 'node:net';
import { decodeFrames, encodeFrame, type NodeFrame } from './protocol.js';

export interface NodeClientOptions {
  socket: Socket;
  token: string;
  /** Identifies this client in node logs. */
  clientName?: string;
  onEvent?: (event: unknown) => void;
  onClose?: (reason: string) => void;
}

export interface NodeClient {
  /** The node's reported name, available after the handshake. */
  nodeName: string;
  call<T = unknown>(method: string, args?: unknown[]): Promise<T>;
  close(): void;
}

/**
 * Connect and complete the handshake.
 *
 * Resolves once the node has accepted the token, so a caller that gets a
 * client back knows it is usable — an authentication failure surfaces here
 * rather than on the first method call.
 */
export function connectNode(options: NodeClientOptions): Promise<NodeClient> {
  const { socket, token, clientName = 'ghostbot-desktop', onEvent, onClose } = options;

  return new Promise((resolve, reject) => {
    let buffered = '';
    let ready = false;
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

    const failAll = (reason: string) => {
      const error = new Error(reason);
      for (const { reject: rejectCall } of pending.values()) rejectCall(error);
      pending.clear();
    };

    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const { frames, rest } = decodeFrames(buffered);
      buffered = rest;

      for (const raw of frames) {
        const frame = raw as NodeFrame;
        switch (frame.t) {
          case 'welcome':
            ready = true;
            resolve({
              nodeName: frame.nodeName,
              call<T>(method: string, args: unknown[] = []): Promise<T> {
                if (socket.destroyed) {
                  return Promise.reject(new Error('Not connected to the node.'));
                }
                const id = nextId++;
                return new Promise<T>((res, rej) => {
                  pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
                  socket.write(encodeFrame({ t: 'req', id, method, args }));
                });
              },
              close: () => socket.destroy(),
            });
            break;

          case 'res': {
            const entry = pending.get(frame.id);
            pending.delete(frame.id);
            entry?.resolve(frame.value);
            break;
          }

          case 'err': {
            const entry = pending.get(frame.id);
            pending.delete(frame.id);
            entry?.reject(new Error(frame.message));
            break;
          }

          case 'evt':
            onEvent?.(frame.event);
            break;
        }
      }
    });

    socket.on('error', (err) => {
      failAll(`Lost connection to the node: ${err.message}`);
      if (!ready) reject(err);
      onClose?.(err.message);
    });

    socket.on('close', () => {
      // A close before `welcome` almost always means the token was refused:
      // the node drops unauthenticated sockets without explaining, so as not
      // to help someone probing for a valid token.
      const reason = ready
        ? 'The node closed the connection.'
        : 'The node refused the connection (wrong token, or it is not accepting clients).';
      failAll(reason);
      if (!ready) reject(new Error(reason));
      onClose?.(reason);
    });

    socket.write(encodeFrame({ t: 'hello', token, client: clientName }));
  });
}
