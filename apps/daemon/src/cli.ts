#!/usr/bin/env node
/**
 * cli.ts — `wispcrew serve` and friends.
 *
 * Small on purpose. Anything that looks like product behaviour belongs in
 * the runtime, so it behaves identically under the desktop app.
 */
import { serve } from './serve.js';
import { nodeMethods } from './methods.js';
import { daemonHost, defaultDataDir } from './daemon-host.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_NODE_PORT,
  host,
  listAgents,
  listRoutines,
  parseAddress,
  readSecrets,
  setHost,
} from '@wispcrew/runtime';
import {
  agentsCreate,
  agentsDelete,
  agentsList,
  approvalsAnswer,
  approvalsList,
  ask,
  capabilities,
  nodesList,
  roomsAdd,
  roomsRemove,
  roomsShow,
  roomsTail,
  tasksCancel,
  tasksList,
  tasksStatus,
  tasksWait,
  agentsShow,
  configure,
  roomsList,
  settingsShow,
  type CommandContext,
} from './cli-commands.js';
import { emit, fail, outputOptions, type Rendered } from './cli-output.js';
import { withDaemon } from './cli-connect.js';

const USAGE = `
wispcrew — run agents without a window open

  wispcrew serve [options]     run the engine until stopped
  wispcrew status              show what a daemon would use, then exit

  wispcrew agents              list the agents on this machine
  wispcrew agents show <name>  everything about one
  wispcrew agents create <name>
                               create an agent HERE, on this machine
  wispcrew agents delete <name> --yes
                               remove an agent and its conversation
  wispcrew ask <agent> "..."   send a message and wait for the reply
  wispcrew approvals           what is waiting for permission
  wispcrew approvals allow <id>
  wispcrew approvals deny <id>
  wispcrew tasks               work that has run or is running
  wispcrew tasks status <id>   the state of one
  wispcrew tasks wait <id>     block until it settles
  wispcrew tasks cancel <id>   stop an unfinished one
  wispcrew capabilities        what this binary can do, as data
  wispcrew rooms               list conversations
  wispcrew configure           set the provider, model and key
  wispcrew settings            show the current provider settings

Options
  --data-dir <path>   where agents, transcripts and secrets live
                      (default: the same profile the desktop app uses)
  --workspace <path>  default workspace for agents that set none
  --listen            accept clients from this machine
  --network [addr]    accept clients over the network (default 0.0.0.0:8787)
                      TLS with a self-signed certificate, pinned on pairing
  --pair              open a pairing window and print a code to enter
  --verbose           print agent output as it happens
  --help              this text

For scripts and other agents
  --json              one JSON object on stdout, nothing else
  --output ndjson     one JSON object per line, for streaming
  --quiet             suppress everything but the result
  --no-interactive    never prompt; fail instead of waiting

Configuring a headless machine
  wispcrew configure --provider nvidia --model <id> --key <api-key>
  wispcrew agents create Builder --description "You build things here"

  Both talk to a running daemon, so "wispcrew serve" must be up. Nothing
  reads the profile directly: two writers on one store lose updates.

Attaching this machine from elsewhere
  here:    wispcrew serve --listen --network --pair
  client:  add a node, then enter this host and the printed code

  The code is single-use and expires in five minutes. Compare the printed
  fingerprint against the one your client shows before accepting.

Environment
  WISPCREW_DATA_DIR   same as --data-dir
  WISPCREW_NODE_NAME  how this machine identifies itself (default: hostname)
`;

/**
 * Read `--network`, `--network 9000` or `--network 0.0.0.0:9000`.
 *
 * Defaults to all interfaces, because a node exposed to the network is
 * normally reached from another machine — binding loopback would look like
 * it worked and then refuse every connection.
 */
function parseNetwork(value: string | boolean): { host: string; port: number } {
  if (value === true) return { host: '0.0.0.0', port: DEFAULT_NODE_PORT };
  const text = String(value);
  if (/^\d+$/.test(text)) return { host: '0.0.0.0', port: Number(text) };
  const parsed = parseAddress(text);
  return { host: parsed.host, port: parsed.port };
}

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

/**
 * Commands that need a running daemon.
 *
 * Everything here goes over the protocol rather than touching the profile.
 * `serve` and `status` are deliberately absent: one IS the engine, and the
 * other reports what a daemon would use before one exists.
 */
const CONNECTED: Record<string, (ctx: CommandContext) => Promise<Rendered>> = {
  agents: agentsList,
  'agents show': agentsShow,
  'agents create': agentsCreate,
  'agents delete': agentsDelete,
  ask,
  tasks: tasksList,
  'tasks list': tasksList,
  'tasks status': tasksStatus,
  'tasks wait': tasksWait,
  'tasks cancel': tasksCancel,
  capabilities,
  approvals: approvalsList,
  'approvals list': approvalsList,
  'approvals allow': (ctx) => approvalsAnswer(ctx, true),
  'approvals deny': (ctx) => approvalsAnswer(ctx, false),
  rooms: roomsList,
  'rooms list': roomsList,
  'rooms show': roomsShow,
  'rooms tail': roomsTail,
  'rooms add': roomsAdd,
  'rooms remove': roomsRemove,
  machines: nodesList,
  configure,
  settings: settingsShow,
};

/**
 * Resolve a command that may be two words.
 *
 * `agents create Builder` is one command and one positional argument, not
 * three arguments — so the longer match is tried first.
 */
function resolveCommand(
  command: string,
  rest: string[],
): { run?: (ctx: CommandContext) => Promise<Rendered>; positional: string[] } {
  const two = `${command} ${rest[0] ?? ''}`.trim();
  if (CONNECTED[two]) return { run: CONNECTED[two], positional: rest.slice(1) };
  if (CONNECTED[command]) return { run: CONNECTED[command], positional: rest };
  return { positional: rest };
}

async function runConnectedCommand(
  run: (ctx: CommandContext) => Promise<Rendered>,
  dataDir: string,
  args: Record<string, string | boolean>,
  positional: string[],
): Promise<void> {
  const opts = outputOptions(args);

  try {
    const result = await withDaemon(dataDir, (client) =>
      run({ client, args, positional }),
    );
    emit(result, opts);
  } catch (err) {
    /*
     * A missing daemon is the common case and deserves the next command to
     * type rather than a stack trace. Anything else is reported as-is:
     * inventing a friendlier message for an error I have not anticipated
     * would hide what actually happened.
     */
    fail((err as Error).message, opts);
  }
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

  const resolved = resolveCommand(command, rest.filter((a) => !a.startsWith('--')));
  if (resolved.run) {
    await runConnectedCommand(resolved.run, env.dataDir, args, resolved.positional);
    return;
  }

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
    const storeExists = existsSync(join(env.dataDir, 'wispcrew-secrets.enc'));
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
  /*
   * `--network` implies `--listen`: exposing a node to other machines while
   * refusing its own is not a state anyone wants, and silently doing nothing
   * would be worse than assuming the obvious.
   */
  const network = args.network ? parseNetwork(args.network) : null;
  const listen = Boolean(args.listen) || network !== null;
  const methods = listen ? nodeMethods() : null;

  const running = await serve({
    host: env,
    verbose: Boolean(args.verbose),
    listen,
    network: network ?? undefined,
    pair: Boolean(args.pair),
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

  console.log(`WispCrew daemon on ${host().nodeName}`);
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
  if (network) {
    console.log(`  network   ${network.host}:${network.port} (TLS)`);
  }

  if (running.pairing) {
    const minutes = Math.round((running.pairing.expiresAt - Date.now()) / 60000);
    console.log('');
    console.log('  Pair a client with this node');
    console.log('');
    console.log(`    code         ${running.pairing.code}`);
    console.log(`    expires in   ${minutes} minute(s), single use`);
    console.log('');
    // Printed so a cautious user can compare it against what the client
    // shows: that comparison is what closes the one window where an
    // interceptor could pair someone with the wrong machine.
    console.log(`    fingerprint  ${running.pairing.fingerprint}`);
    console.log('');
    console.log('  Enter the code in your client, and check the fingerprint matches.');
  } else if (network) {
    console.log('\n  No pairing window is open. Restart with --pair to attach a new client.');
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
  console.error(`wispcrew: ${err.message}`);
  process.exitCode = 1;
});
