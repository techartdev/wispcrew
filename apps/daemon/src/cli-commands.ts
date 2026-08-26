/**
 * cli-commands.ts — the commands themselves.
 *
 * Each returns a `Rendered` value rather than printing, so `--json` cannot
 * accidentally acquire a heading and text mode cannot accidentally lose one.
 * The dispatcher prints; a command only decides what is true.
 *
 * Every one of these replaces a step this project performed by hand while
 * setting up a real VPS — reading a pairing code out of a log file,
 * extracting a provider key with a purpose-written probe, creating an agent
 * through a remote path that turned out to be broken.
 */
import type { NodeClient } from '@wispcrew/runtime';
import type { Rendered } from './cli-output.js';
import { table } from './cli-output.js';

/** What a command receives. */
export interface CommandContext {
  client: NodeClient;
  args: Record<string, string | boolean>;
  /** Positional arguments after the command name. */
  positional: string[];
}

const text = (args: Record<string, string | boolean>, name: string): string | undefined =>
  typeof args[name] === 'string' ? (args[name] as string) : undefined;

/* ------------------------------------------------------------------ */
/* agents                                                              */
/* ------------------------------------------------------------------ */

export async function agentsList(ctx: CommandContext): Promise<Rendered> {
  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');

  const value = agents.map((a) => ({
    id: a.id,
    name: a.name,
    model: a.model ?? null,
    // `null` rather than the string "local": a machine-readable field should
    // not require a caller to know which words are sentinels.
    node: a.nodeId ?? null,
    approvalPolicy: a.approvalPolicy ?? null,
  }));

  const lines =
    agents.length === 0
      ? ['No agents yet. Create one with:  wispcrew agents create <name>']
      : table(
          value.map((a) => [
            String(a.name),
            String(a.model ?? 'inherit'),
            String(a.node ?? 'this machine'),
          ]),
          ['NAME', 'MODEL', 'RUNS ON'],
        );

  return { value, lines };
}

export async function agentsShow(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which agent? Usage: wispcrew agents show <name>');

  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const agent = findAgent(agents, wanted);

  return {
    value: agent,
    lines: [
      `name         ${agent.name}`,
      `id           ${agent.id}`,
      `model        ${agent.model ?? '(inherits the global setting)'}`,
      `runs on      ${agent.nodeId ?? 'this machine'}`,
      `permissions  ${agent.approvalPolicy ?? '(inherits the global setting)'}`,
      `workspace    ${agent.workspaceRoot ?? '(the default)'}`,
      ...(agent.description ? ['', String(agent.description)] : []),
    ],
  };
}

export async function agentsCreate(ctx: CommandContext): Promise<Rendered> {
  const name = ctx.positional[0] ?? text(ctx.args, 'name');
  if (!name) throw new Error('What should it be called? Usage: wispcrew agents create <name>');

  /*
   * Created HERE, on the machine running the command.
   *
   * That is the whole point of a CLI on a headless host: the agent's
   * workspace, files and provider key are on this machine, so creating it
   * here needs no remote-creation protocol at all — which is just as well,
   * because the remote one is currently broken.
   */
  const created = await ctx.client.call<Record<string, unknown>>('createAgent', [
    {
      name,
      description: text(ctx.args, 'description'),
      model: text(ctx.args, 'model'),
      approvalPolicy: text(ctx.args, 'policy'),
      workspaceRoot: text(ctx.args, 'workspace'),
    },
  ]);

  return {
    value: created,
    lines: [
      `Created "${created.name}" on this machine.`,
      '',
      `  wispcrew ask ${created.name} "hello"`,
    ],
  };
}

export async function agentsDelete(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which agent? Usage: wispcrew agents delete <name>');

  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const agent = findAgent(agents, wanted);

  /*
   * Deleting takes a conversation with it, so an ambiguous name must never
   * be resolved by guessing — `findAgent` refuses rather than picking one.
   *
   * `--yes` is required in a script. A destructive command that proceeds
   * because nobody was there to object is how an automation loses data it
   * cannot get back.
   */
  if (ctx.args.yes !== true) {
    throw new Error(
      `This deletes "${agent.name}" and its conversation. Re-run with --yes to confirm.`,
    );
  }

  await ctx.client.call('deleteAgent', [agent.id]);

  return {
    value: { ok: true, deleted: agent.id, name: agent.name },
    lines: [`Deleted "${agent.name}".`],
  };
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export async function configure(ctx: CommandContext): Promise<Rendered> {
  const patch: Record<string, unknown> = {};
  for (const field of ['presetId', 'model', 'baseUrl'] as const) {
    const value = text(ctx.args, field === 'presetId' ? 'provider' : field);
    if (value) patch[field] = value;
  }

  /*
   * The key goes in the same call.
   *
   * The node's `writeSettings` peels `apiKey` off and routes it through
   * `setProviderKey`, so it is encrypted with that machine's own key file and
   * never lands in the plaintext settings. Doing it here rather than in a
   * separate command means there is no window where a profile has a provider
   * and no credential.
   */
  const key = text(ctx.args, 'key');
  if (key) patch.apiKey = key;

  if (Object.keys(patch).length === 0) {
    // Nothing to change: report the current state rather than doing nothing
    // silently, which reads as a failure.
    return settingsShow(ctx);
  }

  /*
   * `saveSettings`, not `writeSettings`.
   *
   * They are different methods, and the difference is invisible until it
   * matters: `writeSettings` writes the patch as given, so an `apiKey` in it
   * is dropped on the floor. `saveSettings` peels the key off and routes it
   * through `setProviderKey`, which encrypts it with this machine's own key
   * file.
   *
   * Measured: `configure --key ...` reported success and then `settings`
   * said the key was missing, because nothing had been stored.
   */
  const settings = await ctx.client.call<Record<string, unknown>>('saveSettings', [patch]);

  return {
    value: { ok: true, settings },
    lines: [
      'Configured.',
      `  provider  ${settings.presetId ?? '(none)'}`,
      `  model     ${settings.model ?? '(the provider default)'}`,
      `  key       ${settings.hasApiKey ? 'set' : 'MISSING'}`,
    ],
  };
}

export async function settingsShow(ctx: CommandContext): Promise<Rendered> {
  const settings = await ctx.client.call<Record<string, unknown>>('getSettings');

  return {
    value: settings,
    lines: [
      `provider   ${settings.presetId ?? '(none)'}`,
      `model      ${settings.model ?? '(the provider default)'}`,
      `base URL   ${settings.baseUrl ?? '(the provider default)'}`,
      `API key    ${settings.hasApiKey ? 'set' : 'not set'}`,
      `encrypted  ${settings.isEncrypted ? 'yes' : 'no'}`,
    ],
  };
}

/* ------------------------------------------------------------------ */
/* rooms                                                               */
/* ------------------------------------------------------------------ */

export async function roomsList(ctx: CommandContext): Promise<Rendered> {
  const rooms = await ctx.client.call<Record<string, unknown>[]>('listConversations');

  const value = rooms.map((r) => {
    const participants = (r.participants ?? []) as { kind: string; handle?: string }[];
    return {
      id: r.id,
      title: r.title,
      mode: r.mode,
      agents: participants.filter((p) => p.kind === 'agent').map((p) => p.handle),
    };
  });

  const lines =
    value.length === 0
      ? ['No conversations yet.']
      : table(
          value.map((r) => [
            String(r.title),
            String(r.mode),
            r.agents.map((h) => `@${h}`).join(' '),
          ]),
          ['ROOM', 'MODE', 'AGENTS'],
        );

  return { value, lines };
}

/* ------------------------------------------------------------------ */
/* asking                                                              */
/* ------------------------------------------------------------------ */

/**
 * Send a message and wait for the reply.
 *
 * The command that makes the CLI useful rather than merely administrative.
 * Deliberately blocking: a caller wants the answer, and a fire-and-forget
 * send that prints "queued" leaves them polling a transcript.
 */
export async function ask(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  const message = ctx.positional.slice(1).join(' ') || text(ctx.args, 'message');

  if (!wanted || !message) {
    throw new Error('Usage: wispcrew ask <agent> "your message"');
  }

  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const agent = findAgent(agents, wanted);
  const roomId = String(agent.id);

  /*
   * Where the reply will start.
   *
   * Counting from the current end means a busy transcript does not make the
   * command re-read history it has already seen, and two `ask`es running at
   * once cannot show each other's answers.
   */
  const before = (await ctx.client.call<unknown[]>('getTranscript', [roomId])).length;

  /*
   * Say that somebody is here before the turn starts.
   *
   * The daemon denies approvals when nothing is attached. This command IS
   * somebody — a person at a terminal waiting for the answer — so a tool
   * call that needs permission should reach them rather than being refused
   * before they see it.
   *
   * Listed again on every poll below, which keeps the window open for as
   * long as this command is waiting.
   */
  await ctx.client.call('listApprovals');

  await ctx.client.call('sendToRoom', [roomId, message]);

  const timeoutMs = Number(text(ctx.args, 'timeout') ?? 180) * 1000;
  const deadline = Date.now() + timeoutMs;

  let stable = 0;
  let previous = '';
  let entries: Record<string, unknown>[] = [];

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    /*
     * Keeps the "somebody is here" window open, and surfaces anything the
     * turn is blocked on. An approval raised mid-turn would otherwise sit
     * unseen until this command gave up.
     */
    const blocked = await ctx.client.call<Record<string, unknown>[]>('listApprovals');
    if (blocked.length > 0 && !ctx.args.quiet) {
      for (const p of blocked) {
        process.stderr.write(
          `waiting for approval: ${p.tool} — ${p.summary}\n` +
            `  wispcrew approvals allow ${String(p.id).slice(0, 8)}\n`,
        );
      }
    }

    entries = (await ctx.client.call<Record<string, unknown>[]>('getTranscript', [roomId])).slice(
      before,
    );

    const replies = entries.filter((e) => e.kind === 'message' && e.role === 'assistant');
    const signature = replies.map((e) => `${e.id}:${String(e.content ?? '').length}`).join('|');

    /*
     * Wait for the text to stop growing, not merely to appear.
     *
     * Replies stream, so the first chunk is not the answer. Two identical
     * samples mean the turn has settled.
     */
    if (replies.length > 0) {
      stable = signature === previous ? stable + 1 : 0;
      if (stable >= 2) break;
    }
    previous = signature;
  }

  const replies = entries.filter((e) => e.kind === 'message' && e.role === 'assistant');
  const errors = entries.filter((e) => e.kind === 'notice' && e.level === 'error');

  if (replies.length === 0 && errors.length > 0) {
    // A failed turn must not look like a quiet one: exit non-zero with the
    // reason, so a script can tell them apart.
    throw new Error(String(errors[0]!.text ?? 'The turn failed.'));
  }

  const answer = replies.map((e) => String(e.content ?? '')).join('\n\n');

  return {
    value: {
      agent: agent.name,
      answer,
      // Reported rather than hidden: a caller that got an answer AND an error
      // deserves to know a tool failed along the way.
      errors: errors.map((e) => e.text),
      timedOut: replies.length === 0,
    },
    lines: answer ? [answer] : ['No reply within the timeout.'],
  };
}

/* ------------------------------------------------------------------ */
/* approvals                                                           */
/* ------------------------------------------------------------------ */

export async function approvalsList(ctx: CommandContext): Promise<Rendered> {
  const pending = await ctx.client.call<Record<string, unknown>[]>('listApprovals');

  const lines =
    pending.length === 0
      ? ['Nothing is waiting for approval.']
      : table(
          pending.map((p) => [
            String(p.id).slice(0, 8),
            String(p.agentName),
            String(p.tool),
            String(p.summary).slice(0, 50),
          ]),
          ['ID', 'AGENT', 'TOOL', 'WHAT'],
        );

  return { value: pending, lines };
}

export async function approvalsAnswer(
  ctx: CommandContext,
  allowed: boolean,
): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) {
    throw new Error(
      `Which request? Usage: wispcrew approvals ${allowed ? 'allow' : 'deny'} <id>`,
    );
  }

  const pending = await ctx.client.call<Record<string, unknown>[]>('listApprovals');

  /*
   * A short id is enough, because nobody wants to type a UUID.
   *
   * An ambiguous prefix is refused rather than resolved: allowing the wrong
   * request would run a command the user did not look at, which is the exact
   * failure the approval layer exists to prevent.
   */
  const matches = pending.filter((p) => String(p.id).startsWith(wanted));
  if (matches.length === 0) {
    throw new Error(`No pending approval starts with "${wanted}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `"${wanted}" matches ${matches.length} requests. Use more characters:\n` +
        matches.map((p) => `  ${String(p.id).slice(0, 12)}  ${p.tool}`).join('\n'),
    );
  }

  const target = matches[0]!;
  await ctx.client.call('resolveApproval', [target.id, allowed]);

  return {
    value: { ok: true, id: target.id, allowed },
    lines: [`${allowed ? 'Allowed' : 'Denied'}: ${target.tool} for ${target.agentName}.`],
  };
}

/* ------------------------------------------------------------------ */
/* tasks                                                               */
/* ------------------------------------------------------------------ */

/**
 * A task is a turn, seen from outside.
 *
 * Nothing new is stored. A turn is already durable and already survives a
 * restart — it exists so a claim is not lost when a node dies mid-run — and
 * an orchestrator needs exactly what it already carries: a stable id whose
 * state can be asked about later, from a different process.
 *
 * That is the difference between this and `ask`. `ask` blocks and returns
 * the answer, which is what a person wants. A task is for work nobody is
 * sitting in front of: start it, go away, come back.
 */
export async function tasksList(ctx: CommandContext): Promise<Rendered> {
  const turns = await ctx.client.call<Record<string, unknown>[]>('listTurns');
  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const nameOf = (id: unknown) =>
    String(agents.find((a) => a.id === id)?.name ?? String(id).slice(0, 8));

  const value = turns.map((t) => ({
    id: t.id,
    agent: nameOf(t.agentId),
    state: t.state,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt ?? null,
    detail: t.detail ?? null,
  }));

  const lines =
    value.length === 0
      ? ['No tasks recorded.']
      : table(
          value.map((t) => [
            String(t.id).slice(0, 8),
            String(t.agent),
            String(t.state),
            ageOf(Number(t.startedAt)),
          ]),
          ['ID', 'AGENT', 'STATE', 'STARTED'],
        );

  return { value, lines };
}

export async function tasksStatus(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which task? Usage: wispcrew tasks status <id>');

  const task = await findTask(ctx, wanted);

  return {
    value: task,
    lines: [
      `id        ${task.id}`,
      `state     ${task.state}`,
      `started   ${new Date(Number(task.startedAt)).toISOString()}`,
      ...(task.finishedAt
        ? [`finished  ${new Date(Number(task.finishedAt)).toISOString()}`]
        : []),
      ...(task.detail ? [`detail    ${task.detail}`] : []),
    ],
  };
}

/**
 * Block until a task settles.
 *
 * The command that makes asynchronous work usable from a script: start
 * something, do other things, then wait for it here. Exits non-zero when the
 * task failed or was cancelled, so `&&` behaves the way a caller expects.
 */
export async function tasksWait(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which task? Usage: wispcrew tasks wait <id>');

  const timeoutMs = Number(text(ctx.args, 'timeout') ?? 600) * 1000;
  const deadline = Date.now() + timeoutMs;

  const SETTLED = new Set(['completed', 'failed', 'cancelled']);
  let task = await findTask(ctx, wanted);

  while (!SETTLED.has(String(task.state)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    task = await findTask(ctx, String(task.id));
  }

  if (!SETTLED.has(String(task.state))) {
    throw new Error(`Task ${String(task.id).slice(0, 8)} is still ${task.state} after the timeout.`);
  }

  if (task.state !== 'completed') {
    // A failed task must not exit zero: a script chaining on it would carry
    // on as though the work had been done.
    throw new Error(`Task ${task.state}: ${task.detail ?? 'no detail'}`);
  }

  return {
    value: task,
    lines: [`Task ${String(task.id).slice(0, 8)} completed.`],
  };
}

export async function tasksCancel(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which task? Usage: wispcrew tasks cancel <id>');

  const task = await findTask(ctx, wanted);
  await ctx.client.call('cancelTurn', [task.id]);

  return {
    value: { ok: true, id: task.id },
    lines: [`Cancelled ${String(task.id).slice(0, 8)}.`],
  };
}

/* ------------------------------------------------------------------ */
/* discovery                                                           */
/* ------------------------------------------------------------------ */

/**
 * What this binary can do, as data.
 *
 * Written for another coding agent rather than a person: every agent already
 * knows how to run a shell command, so a machine-readable description is the
 * whole integration. Parsing help prose is guesswork, and it breaks the
 * moment the wording is improved.
 */
export async function capabilities(ctx: CommandContext): Promise<Rendered> {
  const settings = await ctx.client.call<Record<string, unknown>>('getSettings');
  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');

  const value = {
    product: 'wispcrew',
    /*
     * The protocol version, not the release. A caller cares whether the
     * commands below behave as documented, which is what this promises.
     */
    schema: 1,
    node: ctx.client.nodeName,
    provider: {
      preset: settings.presetId ?? null,
      model: settings.model ?? null,
      configured: Boolean(settings.hasApiKey),
    },
    agents: agents.map((a) => ({ id: a.id, name: a.name })),
    commands: COMMAND_SCHEMA,
  };

  return {
    value,
    lines: [
      `node      ${value.node}`,
      `provider  ${value.provider.preset ?? '(none)'}${value.provider.configured ? '' : '  (no key)'}`,
      `agents    ${value.agents.length}`,
      `commands  ${COMMAND_SCHEMA.length}`,
      '',
      'For the full machine-readable description:  wispcrew capabilities --json',
    ],
  };
}

/**
 * Every command, its arguments, and what it returns.
 *
 * Hand-written rather than derived, because a description generated from the
 * dispatcher would say what each command IS called and nothing about when to
 * use it — which is the part a caller actually needs.
 */
const COMMAND_SCHEMA = [
  {
    name: 'agents',
    summary: 'List the agents on this machine.',
    args: [],
    returns: 'array of { id, name, model, node, approvalPolicy }',
  },
  {
    name: 'agents show',
    summary: 'Everything about one agent.',
    args: [{ name: 'agent', required: true, description: 'name or id' }],
    returns: 'object',
  },
  {
    name: 'agents create',
    summary: 'Create an agent on THIS machine, with its own room.',
    args: [
      { name: 'name', required: true, positional: true },
      { name: '--description', required: false },
      { name: '--model', required: false },
      { name: '--policy', required: false, description: 'ask | auto | readonly' },
    ],
    returns: 'the created agent',
  },
  {
    name: 'agents delete',
    summary: 'Remove an agent and its conversation.',
    args: [
      { name: 'agent', required: true, positional: true },
      { name: '--yes', required: true, description: 'destructive; required in scripts' },
    ],
    returns: '{ ok, deleted, name }',
  },
  {
    name: 'ask',
    summary: 'Send a message and wait for the reply. Blocks.',
    args: [
      { name: 'agent', required: true, positional: true },
      { name: 'message', required: true, positional: true },
      { name: '--timeout', required: false, description: 'seconds; default 180' },
    ],
    returns: '{ agent, answer, errors, timedOut }',
    notes: 'Exits non-zero if the turn failed. For work nobody waits on, use tasks.',
  },
  {
    name: 'tasks',
    summary: 'List turns, past and present.',
    args: [],
    returns: 'array of { id, agent, state, startedAt, finishedAt, detail }',
  },
  {
    name: 'tasks status',
    summary: 'The state of one task.',
    args: [{ name: 'id', required: true, positional: true, description: 'a prefix is enough' }],
    returns: 'the task',
  },
  {
    name: 'tasks wait',
    summary: 'Block until a task settles.',
    args: [
      { name: 'id', required: true, positional: true },
      { name: '--timeout', required: false, description: 'seconds; default 600' },
    ],
    returns: 'the task',
    notes: 'Exits non-zero if it failed or was cancelled.',
  },
  {
    name: 'tasks cancel',
    summary: 'Stop an unfinished task.',
    args: [{ name: 'id', required: true, positional: true }],
    returns: '{ ok, id }',
  },
  {
    name: 'approvals',
    summary: 'What is waiting for permission to run.',
    args: [],
    returns: 'array of { id, agentId, agentName, tool, summary, createdAt, expiresAt }',
    notes: 'An unanswered request is denied after five minutes.',
  },
  {
    name: 'approvals allow',
    summary: 'Permit one pending tool call.',
    args: [{ name: 'id', required: true, positional: true, description: 'a prefix is enough' }],
    returns: '{ ok, id, allowed }',
  },
  {
    name: 'approvals deny',
    summary: 'Refuse one pending tool call.',
    args: [{ name: 'id', required: true, positional: true }],
    returns: '{ ok, id, allowed }',
  },
  {
    name: 'rooms',
    summary: 'List conversations and who is in them.',
    args: [],
    returns: 'array of { id, title, mode, agents }',
  },
  {
    name: 'configure',
    summary: 'Set the provider, model and key for THIS machine.',
    args: [
      { name: '--provider', required: false },
      { name: '--model', required: false },
      { name: '--key', required: false, description: 'stored encrypted; never leaves this node' },
    ],
    returns: '{ ok, settings }',
  },
  {
    name: 'settings',
    summary: 'The current provider settings.',
    args: [],
    returns: 'object; the key itself is never returned',
  },
  {
    name: 'capabilities',
    summary: 'This description, as data.',
    args: [],
    returns: 'object',
  },
];

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** How long ago, in words a person reads faster than a timestamp. */
function ageOf(when: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - when) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * Find a task by id or unambiguous prefix.
 *
 * Nobody wants to type a full id, and an ambiguous prefix is refused rather
 * than resolved — cancelling the wrong task would stop work somebody wanted.
 */
async function findTask(
  ctx: CommandContext,
  wanted: string,
): Promise<Record<string, unknown>> {
  const turns = await ctx.client.call<Record<string, unknown>[]>('listTurns');

  const exact = turns.find((t) => t.id === wanted);
  if (exact) return exact;

  const matches = turns.filter((t) => String(t.id).startsWith(wanted));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `"${wanted}" matches ${matches.length} tasks. Use more characters:\n` +
        matches.map((t) => `  ${String(t.id).slice(0, 12)}  ${t.state}`).join('\n'),
    );
  }

  throw new Error(`No task starts with "${wanted}".`);
}

/**
 * Find an agent by name or id.
 *
 * Names are what a person types and ids are what a script keeps, so both
 * work. An ambiguous name is an error rather than a guess: picking the first
 * of two agents called "Builder" would send work to the wrong machine.
 */
export function findAgent(
  agents: Record<string, unknown>[],
  wanted: string,
): Record<string, unknown> {
  const byId = agents.find((a) => a.id === wanted);
  if (byId) return byId;

  const matches = agents.filter(
    (a) => String(a.name).toLowerCase() === wanted.toLowerCase(),
  );

  if (matches.length === 1) return matches[0]!;

  if (matches.length > 1) {
    throw new Error(
      `More than one agent is called "${wanted}". Use an id instead:\n` +
        matches.map((a) => `  ${a.id}  ${a.name}`).join('\n'),
    );
  }

  throw new Error(
    `No agent called "${wanted}". Available:\n` +
      agents.map((a) => `  ${a.name}`).join('\n'),
  );
}
