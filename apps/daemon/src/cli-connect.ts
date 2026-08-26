/**
 * cli-connect.ts — reaching the engine, never the store.
 *
 * The rule this file exists to enforce: **the CLI never reads or writes the
 * profile directly.** Two engines on one JSON store lose updates — measured,
 * not assumed, which is why the desktop refuses to run its own scheduler when
 * a daemon owns the profile. A CLI that read `agents.json` would reintroduce
 * exactly that, intermittently, which is worse than doing it always.
 *
 * So every command goes through the same NDJSON protocol the desktop uses.
 * The CLI is a third client, not a second engine.
 */
import net from 'node:net';
import {
  connectNode,
  isProcessAlive,
  localAddress,
  readEndpoint,
  type NodeClient,
} from '@wispcrew/runtime';

export interface Connection {
  client: NodeClient;
  close(): void;
}

/**
 * Why a connection could not be made, in terms a person can act on.
 *
 * "ECONNREFUSED" tells someone nothing; "no daemon is running, start one with
 * wispcrew serve" tells them the next command to type.
 */
export class NoDaemonError extends Error {
  constructor(readonly dataDir: string) {
    super(
      'No WispCrew daemon is running for this profile.\n' +
        `  profile  ${dataDir}\n` +
        '  start it with:  wispcrew serve',
    );
    this.name = 'NoDaemonError';
  }
}

/**
 * Connect to the daemon that owns this profile.
 *
 * Deliberately does NOT start one. A command that silently spawns a daemon
 * makes `wispcrew agents` a state-changing operation, and leaves a process
 * behind that the user never asked for and will not think to stop.
 */
export async function connectLocal(dataDir: string): Promise<Connection> {
  const endpoint = readEndpoint(dataDir);

  /*
   * An endpoint file outlives the process that wrote it.
   *
   * A daemon killed with SIGKILL leaves its file behind, so its presence
   * proves nothing. Checking the pid is what distinguishes "running" from
   * "crashed last Tuesday" — and this project already learned that a
   * recycled pid must be verified rather than trusted.
   */
  if (!endpoint || !isProcessAlive(endpoint.pid)) {
    throw new NoDaemonError(dataDir);
  }

  /*
   * A local node listens on a unix socket or a named pipe, so the address is
   * a path rather than a host and port.
   */
  const socket = net.connect(endpoint.address ?? localAddress(dataDir));

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', (err: Error) => reject(err));
  });

  /*
   * Deliberately NOT unreferenced.
   *
   * The desktop unrefs its link so an open socket cannot keep Electron alive
   * at quit, and copying that here was wrong: a one-shot command has the
   * opposite problem. Unreferencing removes the only handle holding the loop
   * open, so Node exits before the reply arrives — measured as no output, no
   * error and exit code 0, which is the worst way for a command to fail.
   *
   * `withDaemon` closes the socket explicitly when the call is done, so the
   * process ends at the right moment rather than by accident.
   */

  const client = await connectNode({
    socket,
    token: endpoint.token,
    clientName: 'wispcrew-cli',
  });

  return {
    client,
    close: () => client.close(),
  };
}

/**
 * Run one call against the local daemon and close cleanly.
 *
 * Most commands are a single round trip, and leaving a socket open would keep
 * the process alive after its output was printed — a CLI that does not exit
 * is worse than one that fails.
 */
export async function withDaemon<T>(
  dataDir: string,
  fn: (client: NodeClient) => Promise<T>,
): Promise<T> {
  const connection = await connectLocal(dataDir);
  try {
    return await fn(connection.client);
  } finally {
    connection.close();
  }
}
