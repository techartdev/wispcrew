/**
 * serve.ts — the WispCrew engine as a long-running process.
 *
 * This is the whole point of detaching the engine: routines fire, MCP
 * servers stay connected and long tasks finish whether or not a window is
 * open, or a user is even logged in.
 *
 * What it deliberately does *not* do yet: listen on a socket. Step 2 is
 * proving the engine runs unattended; the transport arrives next, and
 * building it first would bake assumptions into a protocol before the seam
 * had been exercised.
 */
import {
  closeAllMcp,
  defaultSettings,
  emitEngineEvent,
  fileLog,
  initGrants,
  installNotifySender,
  installScheduler,
  initStore,
  listAgents,
  createAgent,
  readSettings,
  runRoutine,
  setApprovalAsker,
  setHost,
  startScheduler,
  stopWatches,
  syncWatches,
  stopScheduler,
  syncMcpServers,
  addEventSink,
  clearEndpoint,
  engineBuildStamp,
  generateToken,
  host,
  loadOrCreateIdentity,
  localAddress,
  PairingWindow,
  readEndpoint,
  serveNode,
  writeEndpoint,
  type HostEnvironment,
} from '@wispcrew/runtime';
import type { BridgeEvent } from '@wispcrew/shared';
import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { unlinkSync } from 'node:fs';

export interface ServeOptions {
  host: HostEnvironment;
  /** Print each engine event as it happens. Useful when run in a terminal. */
  verbose?: boolean;
  /**
   * Accept local client connections.
   *
   * Off by default so a daemon used purely for routines opens nothing at
   * all: this process runs shell commands, and a listener that nobody asked
   * for is attack surface for no benefit.
   */
  listen?: boolean;
  /** Dispatches an authenticated bridge call. Required when `listen`. */
  onCall?: (method: string, args: unknown[]) => Promise<unknown>;
  /**
   * Accept clients over the network, not only from this machine.
   *
   * Deliberately separate from `listen`: a local socket is protected by file
   * permissions, a network port is reachable by anything that can route to
   * it. Exposing one is a decision about risk, so it is made explicitly
   * rather than implied by wanting a UI to connect.
   */
  network?: { host: string; port: number };
  /** Open a pairing window at startup so a new client can attach. */
  pair?: boolean;
}

export interface RunningDaemon {
  /** Stop the scheduler, close the listener and disconnect MCP servers. */
  stop(): Promise<void>;
  /** Where local clients connect, when listening. */
  address?: string;
  /** The pairing code to display, when a window was opened. */
  pairing?: { code: string; fingerprint: string; expiresAt: number };
}

/**
 * Start the engine.
 *
 * Returns once everything is running. The process then stays alive because
 * the scheduler holds a timer — the caller does not need to keep it awake.
 */
export async function serve(options: ServeOptions): Promise<RunningDaemon> {
  setHost(options.host);

  /*
   * Refuse to start if another daemon already owns this profile.
   *
   * Two engines on one JSON store lose data: each loads a collection,
   * appends to its own copy and saves it back, so the second silently erases
   * the first. Measured, not assumed — see the concurrency note in store.ts.
   *
   * Failing loudly here is far better than the symptom, which is a routine's
   * output or a user's message disappearing with nothing to explain it.
   */
  {
    const existing = readEndpoint(options.host.dataDir);
    if (existing && existing.pid !== process.pid) {
      throw new Error(
        `Another WispCrew daemon (pid ${existing.pid}) already uses ${options.host.dataDir}.\n` +
          'Two engines on one profile lose data. Stop that one first, or pass --data-dir.',
      );
    }
  }

  const env = host();
  initStore(env.dataDir);

  /*
   * Let agents reach the user.
   *
   * The daemon is the only process that can deliver a direct message
   * while the app is closed, which is exactly when an unattended agent
   * has something to say.
   */
  installNotifySender();
  installScheduler();
  initGrants(env.dataDir);

  /*
   * Approvals are DENIED here, and that is a deliberate default rather than
   * an omission.
   *
   * A daemon has nobody to ask. Silently allowing tool calls that the policy
   * marks as needing permission would mean an unattended routine quietly
   * gains authority the user never granted — precisely the failure mode the
   * approval layer exists to prevent. Agents that must act unattended should
   * be set to `auto` explicitly, which is a decision the user makes and can
   * see, rather than one the daemon makes on their behalf.
   */
  setApprovalAsker(async (agentId, req) => {
    fileLog('[daemon] denied unattended approval', agentId, req.toolName);
    emitEngineEvent({
      type: 'notice',
      level: 'error',
      text:
        `"${req.toolName}" needs approval, and nothing is attached to ask. ` +
        'Set this agent to auto-approve if it should act unattended.',
    });
    return false;
  });

  if (options.verbose) {
    addEventSink((event: BridgeEvent) => {
      if (event.type === 'transcript' && event.entry.kind === 'message') {
        const text = String(event.entry.content ?? '').replace(/\s+/g, ' ').slice(0, 100);
        if (text) console.log(`  [${event.entry.role}] ${text}`);
      } else if (event.type === 'notice') {
        console.log(`  [${event.level}] ${event.text}`);
      } else if (event.type === 'run-state') {
        console.log(`  [state] ${event.agentId} ${event.state}`);
      }
    });
  }

  // Every install has at least one agent, so a fresh daemon is usable
  // immediately rather than presenting an empty roster.
  if (listAgents().length === 0) {
    createAgent({ name: 'Assistant', persona: 'general' });
    fileLog('[daemon] created default agent');
  }

  const settings = readSettings(env.dataDir, defaultSettings());
  await syncMcpServers(settings as never).catch((err: Error) =>
    fileLog('[daemon] mcp sync failed', err.message),
  );

  // Watches wake the same routines through the same runner, so a
  // file-triggered run records its history like a scheduled one.
  syncWatches(runRoutine);

  startScheduler(runRoutine, () => {
    /* routine list changed; nothing to refresh without a UI attached */
  });

  let listener: { close(): Promise<void> } | null = null;
  let address: string | undefined;
  let pairingOffer: { code: string; fingerprint: string; expiresAt: number } | undefined;

  if (options.listen) {
    if (!options.onCall) {
      throw new Error('serve({ listen: true }) needs an onCall handler to dispatch bridge methods.');
    }

    address = localAddress(env.dataDir);

    /*
     * A stale socket file blocks binding after an unclean shutdown. Removing
     * it is safe because `readEndpoint` already established that no live
     * daemon owns this profile — otherwise we would be stealing a running
     * daemon's address.
     */
    if (process.platform !== 'win32') {
      try {
        unlinkSync(address);
      } catch {
        /* nothing there, which is the normal case */
      }
    }

    const token = generateToken();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => resolve());
    });

    listener = serveNode({ server, token, nodeName: env.nodeName, onCall: options.onCall });

    /*
     * A second, TLS listener for clients on other machines.
     *
     * The local socket keeps its own token and stays as it is: a machine's
     * own UI should not need the network path, and leaving it alone means
     * exposing a node never changes how the local case works.
     */
    if (options.network) {
      const identity = loadOrCreateIdentity(env.dataDir, [
        env.nodeName,
        'localhost',
        options.network.host,
      ]);
      const netToken = generateToken();
      const window = new PairingWindow();

      const tlsServer = createTlsServer({ cert: identity.cert, key: identity.key });
      await new Promise<void>((resolve, reject) => {
        tlsServer.once('error', reject);
        tlsServer.listen(options.network!.port, options.network!.host, () => resolve());
      });

      const tlsListener = serveNode({
        server: tlsServer,
        token: netToken,
        nodeName: env.nodeName,
        onCall: options.onCall,
        pairing: window,
      });

      if (options.pair) {
        const offer = window.open(identity.fingerprint, netToken);
        pairingOffer = offer;
      }

      const localOnly = listener;
      listener = {
        async close() {
          await Promise.all([localOnly.close(), tlsListener.close()]);
        },
      };

      fileLog('[daemon] network listener on', `${options.network.host}:${options.network.port}`);
    }

    // Publish where and how to connect. Written 0600 — the token is a
    // credential, and on a loopback socket it is the only thing standing
    // between another local process and shell access.
    writeEndpoint(env.dataDir, {
      address,
      token,
      pid: process.pid,
      nodeName: env.nodeName,
      startedAt: Date.now(),
      // Lets a client notice it is talking to an engine older than its own
      // code and restart it, instead of silently using stale behaviour.
      buildStamp: engineBuildStamp(),
    });
  }

  fileLog('[daemon] started', env.nodeName, env.dataDir, address ?? '(no listener)');

  return {
    address,
    pairing: pairingOffer,
    async stop() {
      stopScheduler();
      stopWatches();
      await listener?.close().catch(() => {});
      if (options.listen) clearEndpoint(env.dataDir);
      await closeAllMcp().catch(() => {});
      fileLog('[daemon] stopped');
    },
  };
}
