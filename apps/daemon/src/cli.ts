#!/usr/bin/env node
/**
 * cli.ts — `ghostbot serve` and friends.
 *
 * Small on purpose. Anything that looks like product behaviour belongs in
 * the runtime, so it behaves identically under the desktop app.
 */
import { serve } from './serve.js';
import { nodeMethods } from './methods.js';
import { daemonHost, defaultDataDir } from './daemon-host.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { host, listAgents, listRoutines, readSecrets, setHost } from '@ghostbot/runtime';

const USAGE = `
ghostbot — run agents without a window open

  ghostbot serve [options]     run the engine until stopped
  ghostbot status              show what a daemon would use, then exit

Options
  --data-dir <path>   where agents, transcripts and secrets live
                      (default: the same profile the desktop app uses)
  --workspace <path>  default workspace for agents that set none
  --verbose           print agent output as it happens
  --help              this text

Environment
  GHOSTBOT_DATA_DIR   same as --data-dir
  GHOSTBOT_NODE_NAME  how this machine identifies itself (default: hostname)
`;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[name] = next;
      i++;
    } else {
      out[name] = true;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [command = 'serve', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (args.help || command === '--help' || command === 'help') {
    console.log(USAGE.trim());
    return;
  }

  const env = daemonHost({
    dataDir: typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined,
    workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
  });

  if (command === 'status') {
    // Deliberately reports the *resolved* paths rather than the defaults, so
    // a user can confirm the daemon and the desktop app share one profile
    // before wondering why a provider they configured is "missing".
    console.log(`node       ${env.nodeName}`);
    console.log(`data dir   ${env.dataDir}`);
    console.log(`workspace  ${env.defaultWorkspaceRoot}`);
    console.log(`secrets    ${env.crypto.describe()}`);

    /*
     * The failure this exists to catch: the desktop app encrypts secrets with
     * the OS keychain, and a daemon on the same machine has no access to it.
     * Both point at one profile, so everything looks fine until every routine
     * fails with "needs an API key" for a provider that is plainly configured.
     *
     * Better to say so here than to let someone debug it at 3am.
     */
    setHost(env);
    const secretCount = Object.keys(readSecrets(env.dataDir)).length;
    const storeExists = existsSync(join(env.dataDir, 'ghostbot-secrets.enc'));
    if (storeExists && secretCount === 0) {
      console.log('');
      console.log('WARNING  a secret store exists here but cannot be read with this backend.');
      console.log('         It was most likely written by the desktop app using the OS');
      console.log('         keychain, which a headless process cannot open.');
      console.log('         Configure this node\'s providers separately, or run the daemon');
      console.log('         as the desktop user with a keychain available.');
    } else {
      console.log(`providers  ${secretCount} credential(s) readable`);
    }
    return;
  }

  if (command !== 'serve') {
    console.error(`Unknown command "${command}".\n`);
    console.log(USAGE.trim());
    process.exitCode = 1;
    return;
  }

  /*
 * `--listen` is opt-in. A daemon used only for routines opens no socket at
 * all: this process runs shell commands, and a listener nobody asked for is
 * attack surface for no benefit. The desktop app passes it because it needs
 * to drive the engine; a cron-only node on a VPS does not.
 */
  const listen = Boolean(args.listen);
  const methods = listen ? nodeMethods() : null;

  const running = await serve({
    host: env,
    verbose: Boolean(args.verbose),
    listen,
    onCall: methods
      ? async (method, callArgs) => {
          const fn = methods[method];
          if (!fn) throw new Error(`Unknown method "${method}".`);
          return (fn as (...a: unknown[]) => unknown)(...callArgs);
        }
      : undefined,
  });

  const agents = listAgents();
  const routines = listRoutines().filter((r) => r.enabled !== false);

  console.log(`GhostBot daemon on ${host().nodeName}`);
  console.log(`  data      ${host().dataDir}`);
  console.log(`  secrets   ${host().crypto.describe()}`);
  console.log(`  agents    ${agents.length}`);
  if (routines.length === 0) {
    console.log('  routines  none scheduled');
  } else {
    for (const routine of routines) {
      // `nextRunAt` is computed by the scheduler when it arms, so printing it
      // here shows what the daemon will actually do rather than a recomputed
      // guess that might disagree.
      console.log(
        `  routine   ${routine.name} — ${routine.cron}` +
          (routine.nextRunAt ? ` (next ${new Date(routine.nextRunAt).toLocaleString()})` : ''),
      );
    }
  }
  console.log('\nRunning. Ctrl+C to stop.');

  // Shut down cleanly so MCP child processes do not outlive us as orphans.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} — stopping…`);
    await running.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  console.error(`ghostbot: ${err.message}`);
  process.exitCode = 1;
});
