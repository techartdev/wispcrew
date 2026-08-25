/**
 * serve.ts — the GhostBot engine as a long-running process.
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
  initStore,
  listAgents,
  createAgent,
  readSettings,
  runRoutine,
  setApprovalAsker,
  setHost,
  startScheduler,
  stopScheduler,
  syncMcpServers,
  addEventSink,
  host,
  type HostEnvironment,
} from '@ghostbot/runtime';
import type { BridgeEvent } from '@ghostbot/shared';

export interface ServeOptions {
  host: HostEnvironment;
  /** Print each engine event as it happens. Useful when run in a terminal. */
  verbose?: boolean;
}

export interface RunningDaemon {
  /** Stop the scheduler and disconnect MCP servers. */
  stop(): Promise<void>;
}

/**
 * Start the engine.
 *
 * Returns once everything is running. The process then stays alive because
 * the scheduler holds a timer — the caller does not need to keep it awake.
 */
export async function serve(options: ServeOptions): Promise<RunningDaemon> {
  setHost(options.host);

  const env = host();
  initStore(env.dataDir);
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

  startScheduler(runRoutine, () => {
    /* routine list changed; nothing to refresh without a UI attached */
  });

  fileLog('[daemon] started', env.nodeName, env.dataDir);

  return {
    async stop() {
      stopScheduler();
      await closeAllMcp().catch(() => {});
      fileLog('[daemon] stopped');
    },
  };
}
