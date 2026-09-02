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
import {
  addNode,
  listNodes,
  pairWithNode,
  removeNode,
  type NodeClient,
} from '@wispcrew/runtime';
import { describeModelMismatch } from '@wispcrew/shared';
import type { Rendered } from './cli-output.js';
import { table } from './cli-output.js';

/** What a command receives. */
export interface CommandContext {
  client: NodeClient;
  args: Record<string, string | boolean>;
  /** Positional arguments after the command name. */
  positional: string[];
  /**
   * This machine's profile.
   *
   * Needed by the few commands that read client-side state rather than the
   * node's — the paired-machine registry is a record of who THIS machine
   * trusts, which no node can answer for it.
   */
  dataDir: string;
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
  /*
   * A provider and a model, both named, or nothing.
   *
   * `--model` used to be the only one of the two, with the provider
   * inherited from global settings — which is precisely how an agent ended
   * up with an OpenAI model pointed at NVIDIA. The command could create the
   * mismatch and had no flag capable of fixing it.
   *
   * Refused rather than defaulted. A default here would put the agent on
   * whichever provider the machine happened to be set to, which is the
   * behaviour being removed.
   */
  const presetId = text(ctx.args, 'provider');
  const model = text(ctx.args, 'model');

  if (!presetId || !model) {
    const providers = await ctx.client.call<Record<string, unknown>[]>('getPresets');
    const configured = providers.filter((p) => p.configured).map((p) => String(p.id));

    throw new Error(
      'An agent needs a provider and a model, chosen together.\n' +
        `  wispcrew agents create ${name} --provider <id> --model <model>\n` +
        (configured.length
          ? `  configured here: ${configured.join(', ')}\n`
          : '  no provider is configured yet — run: wispcrew configure\n') +
        '  models: wispcrew models <provider>',
    );
  }

  // The same rule the edit path applies, so an agent cannot be born in a
  // state `agents set` would refuse to put it in.
  const mismatch = describeModelMismatch(await presetList(ctx), presetId, model);
  if (mismatch) {
    throw new Error(`${mismatch} Nothing was created.\n  see: wispcrew models ${presetId}`);
  }

  const created = await ctx.client.call<Record<string, unknown>>('createAgent', [
    {
      name,
      description: text(ctx.args, 'description'),
      presetId,
      model,
      approvalPolicy: text(ctx.args, 'policy'),
      workspaceRoot: text(ctx.args, 'workspace'),
    },
  ]);

  return {
    value: created,
    lines: [
      `Created "${created.name}" on this machine, on ${presetId} / ${model}.`,
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

/**
 * The provider presets as THIS node reports them.
 *
 * Asked of the node rather than imported, because a node is entitled to a
 * different build — and because the pairing rule must be judged against the
 * list belonging to the machine the agent runs on, not this one's.
 */
async function presetList(ctx: CommandContext) {
  return ctx.client.call<{ id: string; label?: string; models?: string[]; local?: boolean }[]>(
    'getPresets',
  );
}

export async function agentsUpdate(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) {
    throw new Error(
      'Usage: wispcrew agents set <agent> [--provider id] [--model x]\n' +
        '                              [--policy ask|auto|readonly]\n' +
        '                              [--description "..."] [--workspace <path>]',
    );
  }

  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const agent = findAgent(agents, wanted);

  const patch: Record<string, unknown> = {};
  for (const [flag, field] of [
    ['provider', 'presetId'],
    ['model', 'model'],
    ['policy', 'approvalPolicy'],
    ['description', 'description'],
    ['workspace', 'workspaceRoot'],
    ['name', 'name'],
  ] as const) {
    const value = text(ctx.args, flag);
    if (value !== undefined) patch[field] = value;
  }

  if (Object.keys(patch).length === 0) {
    throw new Error(
      'Nothing to change. Pass at least one of --provider, --model, --policy, --description.',
    );
  }

  /*
   * A provider and a model are one decision, so they are checked together.
   *
   * Either may be given alone — moving to a newer model on the same
   * provider is the common case — but the PAIR that results is what must
   * make sense, so the missing half is taken from the record. Checking only
   * what was typed would let `--model gpt-5.6-terra` land on an NVIDIA
   * agent, which is exactly the mistake this whole change removes.
   *
   * Refused here rather than at the first message. An agent that cannot
   * work should not be saveable: it looks fine in the roster afterwards,
   * and the failure surfaces in whatever room it was added to.
   */
  const nextPreset = String(patch.presetId ?? agent.presetId ?? '');
  const nextModel = String(patch.model ?? agent.model ?? '');

  /*
   * `describeModelMismatch`, not `checkModelPairing`.
   *
   * The latter is the engine's turn-time check and ends with "Nothing was
   * sent", which is true there and false here — nothing was being sent, a
   * setting was being saved. Same rule, correct consequence.
   */
  const mismatch = describeModelMismatch(await presetList(ctx), nextPreset, nextModel);
  if (mismatch) {
    throw new Error(
      `${mismatch} Nothing was changed.\n` +
        `  move the provider too:  wispcrew agents set ${agent.name} --provider <id> --model ${nextModel}\n` +
        `  or see what ${nextPreset} serves:  wispcrew models ${nextPreset}`,
    );
  }

  const updated = await ctx.client.call<Record<string, unknown>>('updateAgent', [agent.id, patch]);

  return {
    value: updated,
    lines: [
      `Updated ${agent.name}.`,
      ...Object.entries(patch).map(([k, v]) => `  ${k}  ${String(v)}`),
    ],
  };
}

export async function agentsDuplicate(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which agent? Usage: wispcrew agents duplicate <agent>');

  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const agent = findAgent(agents, wanted);

  /*
   * Configuration is copied; the conversation is not. A duplicate is a fresh
   * teammate with the same instructions, not a clone mid-thought.
   */
  const copy = await ctx.client.call<Record<string, unknown>>('duplicateAgent', [agent.id]);

  return {
    value: copy,
    lines: [`Created "${copy.name}" from ${agent.name}.`, 'Its conversation starts empty.'],
  };
}

export async function agentsStop(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which agent? Usage: wispcrew agents stop <agent>');

  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const agent = findAgent(agents, wanted);

  await ctx.client.call('interrupt', [agent.id]);

  return {
    value: { ok: true, agent: agent.id },
    lines: [`Asked ${agent.name} to stop.`],
  };
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export async function providers(ctx: CommandContext): Promise<Rendered> {
  const presets = await ctx.client.call<Record<string, unknown>[]>('getPresets');

  return {
    value: presets,
    lines: table(
      presets.map((p) => [
        String(p.id),
        String(p.label ?? p.id),
        String(p.defaultModel ?? ''),
      ]),
      ['ID', 'PROVIDER', 'DEFAULT MODEL'],
    ),
  };
}

/**
 * What a provider actually serves, asked of the provider.
 *
 * Added because two error messages wanted to point at it. The curated list
 * in each preset is short and goes stale — NVIDIA serves 84 models and the
 * preset names six — so "pick a model this provider offers" is useless
 * advice without a way to see the real list.
 *
 * `--refresh` re-asks rather than reading the cache, which is what you want
 * the moment a model you expected is missing.
 */
export async function models(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) {
    const presets = await ctx.client.call<Record<string, unknown>[]>('getPresets');
    throw new Error(
      'Which provider? Usage: wispcrew models <provider>\n' +
        `  ${presets.map((p) => String(p.id)).join(', ')}`,
    );
  }

  const list = await ctx.client.call<Record<string, unknown>[]>('listProviderModels', [
    wanted,
    { refresh: ctx.args.refresh === true },
  ]);

  if (list.length === 0) {
    return {
      value: [],
      lines: [
        `${wanted} returned no model list.`,
        'It may be unreachable, or it may not publish one — a model can still be',
        'given by name if you know it serves one.',
      ],
    };
  }

  return {
    value: list,
    lines: table(
      // "verified with tools" is the only thing here that is not simply the
      // provider's own word, and it is the fact that matters most: a model
      // that cannot call a tool cannot do the job.
      list.map((m) => [String(m.id), m.tested ? 'verified with tools' : '']),
      ['MODEL', 'NOTES'],
    ),
  };
}

export async function personas(ctx: CommandContext): Promise<Rendered> {
  const list = await ctx.client.call<Record<string, unknown>[]>('getPersonas');

  return {
    value: list,
    lines: table(
      list.map((p) => [String(p.id), String(p.description ?? '').slice(0, 60)]),
      ['PERSONA', 'WHAT IT IS FOR'],
    ),
  };
}

/**
 * Check that the configured provider actually answers.
 *
 * The first thing to run after `configure`, and the difference between
 * "configured" and "working" — a key can be present, well-formed and wrong.
 */
export async function testProvider(ctx: CommandContext): Promise<Rendered> {
  const result = await ctx.client.call<Record<string, unknown>>('testConnection');

  const ok = result.ok === true;
  return {
    value: result,
    lines: ok
      ? ['The provider answered.']
      : [`The provider did not answer: ${result.error ?? 'no reason given'}`],
  };
}

export async function testChannel(ctx: CommandContext): Promise<Rendered> {
  const result = await ctx.client.call<Record<string, unknown>>('testTelegram');

  const ok = result.ok === true;
  return {
    value: result,
    lines: ok
      ? ['Telegram accepted a test message.']
      : [`Telegram refused: ${result.error ?? 'no reason given'}`],
  };
}

export async function signins(ctx: CommandContext): Promise<Rendered> {
  const status = await ctx.client.call<Record<string, unknown>[]>('listOAuthStatus');

  const lines =
    status.length === 0
      ? ['No subscription sign-ins.']
      : table(
          status.map((s) => [
            String(s.vendor),
            s.signedIn ? 'signed in' : 'signed out',
            String(s.detail ?? ''),
          ]),
          ['VENDOR', 'STATE', 'DETAIL'],
        );

  return { value: status, lines };
}

export async function signOut(ctx: CommandContext): Promise<Rendered> {
  const vendor = ctx.positional[0];
  if (!vendor) throw new Error('Which one? Usage: wispcrew signout <claude|chatgpt>');

  await ctx.client.call('oauthSignOut', [vendor]);
  return { value: { ok: true, vendor }, lines: [`Signed out of ${vendor}.`] };
}

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

  return sendAndWait(ctx, {
    conversationId: String(agent.id),
    label: String(agent.name),
    agentId: String(agent.id),
    message,
  });
}

/**
 * Say something in a room, and wait for whoever answers.
 *
 * The CLI could reach an agent and not a group, which made every group a
 * desktop-only feature — and `rooms new` printed a "send to it with" line
 * naming a `wispcrew room` command that did not exist. A hint pointing at
 * nothing is worse than no hint: it tells the reader the gap is theirs.
 *
 * Who replies is the room's business, not this command's: address someone
 * with `@handle`, use `@all`, or type nothing special to continue with
 * whoever you last addressed.
 */
export async function roomsSay(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  const message = ctx.positional.slice(1).join(' ') || text(ctx.args, 'message');

  if (!wanted || !message) {
    throw new Error('Usage: wispcrew rooms say <room> "your message"');
  }

  const room = await findRoom(ctx, wanted);
  return sendAndWait(ctx, {
    conversationId: String(room.id),
    label: String(room.title),
    message,
  });
}

/**
 * Send, then wait for the transcript to settle.
 *
 * Shared by `ask` and `rooms say` because the waiting is the hard part and
 * writing it twice is how two commands drift into disagreeing about when a
 * turn has finished — one of them would eventually stop honouring the
 * approval pause below, and only on a machine with approvals enabled.
 */
async function sendAndWait(
  ctx: CommandContext,
  input: {
    conversationId: string;
    /** What to call the answerer in the result. */
    label: string;
    /**
     * Whose approvals to report, when exactly one agent can be answering.
     *
     * Absent for a room: several agents may act on one message, and
     * filtering to one of them would hide a request from another.
     */
    agentId?: string;
    message: string;
  },
): Promise<Rendered> {
  const roomId = input.conversationId;
  const message = input.message;

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
  let deadline = Date.now() + timeoutMs;

  /** Approval ids already mentioned, so each is announced once. */
  const announced = new Set<string>();

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
    /*
     * Only this agent's approvals.
     *
     * A request left parked by an earlier, interrupted run is still in the
     * queue, and reporting it here told the user to allow an id that had
     * nothing to do with their turn — measured on the VPS, where allowing
     * the stale one let the real request time out.
     */
    const blocked = (
      await ctx.client.call<Record<string, unknown>[]>('listApprovals')
    ).filter((p) => !input.agentId || p.agentId === input.agentId);

    if (blocked.length > 0) {
      /*
       * Waiting for a person is not the agent being slow.
       *
       * The timeout exists to catch a turn that has stalled, and a turn
       * paused for approval has not stalled — somebody simply has not
       * answered yet. Counting that time against the deadline made `ask`
       * give up while the agent was still waiting, then return an empty
       * answer for a turn that went on to succeed. Measured on the VPS: the
       * transcript held a correct reply that the caller never saw.
       */
      deadline = Date.now() + timeoutMs;

      // Printed once per request, not once per poll — the same three lines
      // every two seconds buries anything else on the terminal.
      for (const p of blocked) {
        const id = String(p.id);
        if (announced.has(id)) continue;
        announced.add(id);

        if (!ctx.args.quiet) {
          process.stderr.write(
            `waiting for approval: ${p.tool} — ${p.summary}\n` +
              `  wispcrew approvals allow ${id.slice(0, 8)}\n`,
          );
        }
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
      agent: input.label,
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
/* machines                                                            */
/* ------------------------------------------------------------------ */

/**
 * Attach another machine from the command line.
 *
 * Runs in this process rather than through the daemon, because pairing
 * writes to the CLIENT's registry — the record of machines *this* one trusts
 * — and that is a different thing from the node's own state. `docs/
 * NODES-MODEL.md` records why a headless machine may hold one at all.
 *
 * The fingerprint is optional but strongly wanted: comparing it against what
 * the other machine printed is what stops someone intercepting the single
 * moment in this protocol with nothing established to trust.
 */
export async function pair(ctx: CommandContext): Promise<Rendered> {
  const [address, code] = ctx.positional;
  if (!address || !code) {
    throw new Error(
      'Usage: wispcrew pair <address> <code> [--fingerprint <value>]\n' +
        '  Run "wispcrew serve --network --pair" on the other machine for a code.',
    );
  }

  const expectFingerprint = text(ctx.args, 'fingerprint');
  if (!expectFingerprint && !ctx.args.yes) {
    /*
     * Refused rather than merely warned about.
     *
     * Pairing without checking the fingerprint trusts whatever answered the
     * address, which on a hostile network is not necessarily the machine the
     * user meant. `--yes` exists for the case where they have checked by
     * some other means and know what they are doing.
     */
    throw new Error(
      'Refusing to pair without a fingerprint to check.\n' +
        '  The other machine printed one — pass it with --fingerprint,\n' +
        '  or use --yes if you have verified it another way.',
    );
  }

  const result = await pairWithNode(address, code, {
    clientName: 'wispcrew-cli',
    ...(expectFingerprint ? { expectFingerprint } : {}),
  });

  const record = addNode(ctx.dataDir, {
    name: result.nodeName,
    address,
    token: result.token,
    fingerprint: result.fingerprint,
  });

  return {
    value: {
      ok: true,
      id: record.id,
      name: record.name,
      address: record.address,
      fingerprint: record.fingerprint,
    },
    lines: [
      `Paired with ${record.name}.`,
      `  address      ${record.address}`,
      `  fingerprint  ${record.fingerprint}`,
      '',
      /*
       * Said here rather than left to be discovered. A daemon stores the
       * peer but does not dial it, so pairing from a server records trust
       * without yet routing work.
       */
      'Recorded on this machine. A daemon does not yet dial its peers,',
      'so use the desktop to run agents that live on another machine.',
    ],
  };
}

export async function nodesForget(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which machine? Usage: wispcrew machines forget <name>');

  const nodes = listNodes(ctx.dataDir);
  const node =
    nodes.find((n) => n.id === wanted) ??
    nodes.find((n) => n.name?.toLowerCase() === wanted.toLowerCase());

  if (!node) {
    throw new Error(
      `No machine called "${wanted}". Paired:\n` +
        nodes.map((n) => `  ${n.name ?? n.id}`).join('\n'),
    );
  }

  removeNode(ctx.dataDir, node.id);

  return {
    value: { ok: true, forgotten: node.id, name: node.name },
    lines: [
      `Forgot ${node.name ?? node.id}.`,
      'Its token is deleted here; pair again to reattach.',
    ],
  };
}

export async function nodesList(ctx: CommandContext): Promise<Rendered> {
  /*
   * Read locally, not through the daemon.
   *
   * The registry is the record of machines THIS one trusts — a client-side
   * view, like the agent roster. Asking the node would return its own view,
   * which is not the same question.
   */
  const nodes = listNodes(ctx.dataDir) as unknown as Record<string, unknown>[];

  const lines =
    nodes.length === 0
      ? ['No other machines are paired.']
      : table(
          nodes.map((n) => [
            String(n.name ?? n.id),
            String(n.address ?? ''),
            String(n.fingerprint ?? '').slice(0, 17),
          ]),
          ['MACHINE', 'ADDRESS', 'FINGERPRINT'],
        );

  return { value: nodes, lines };
}

/* ------------------------------------------------------------------ */
/* rooms                                                               */
/* ------------------------------------------------------------------ */

export async function roomsShow(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which room? Usage: wispcrew rooms show <name>');

  const room = await findRoom(ctx, wanted);
  const participants = (room.participants ?? []) as Record<string, unknown>[];
  const transcript = await ctx.client.call<Record<string, unknown>[]>('getTranscript', [room.id]);

  return {
    value: { ...room, entries: transcript.length },
    lines: [
      `room     ${room.title}`,
      `id       ${room.id}`,
      `mode     ${room.mode}`,
      `entries  ${transcript.length}`,
      '',
      'In this room:',
      ...participants.map(
        (p) => `  ${p.kind === 'agent' ? `@${p.handle}` : String(p.name ?? p.id)}`,
      ),
    ],
  };
}

/**
 * Print the last part of a conversation.
 *
 * The command for finding out what an unattended agent has been doing —
 * which, on a headless machine, is otherwise invisible.
 */
export async function roomsTail(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which room? Usage: wispcrew rooms tail <name>');

  const room = await findRoom(ctx, wanted);
  const count = Number(text(ctx.args, 'lines') ?? 20);

  const transcript = await ctx.client.call<Record<string, unknown>[]>('getTranscript', [room.id]);
  const recent = transcript.slice(-count);

  return {
    value: recent,
    lines: recent.map((e) => {
      const who =
        e.kind === 'message' ? String(e.role === 'user' ? 'you' : 'agent') : String(e.kind);
      const body = String(e.content ?? e.text ?? '').replace(/\s+/g, ' ');
      return `${who.padEnd(8)} ${body}`;
    }),
  };
}

export async function roomsAdd(ctx: CommandContext): Promise<Rendered> {
  const [roomName, agentName] = ctx.positional;
  if (!roomName || !agentName) {
    throw new Error('Usage: wispcrew rooms add <room> <agent>');
  }

  const room = await findRoom(ctx, roomName);
  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const agent = findAgent(agents, agentName);

  await ctx.client.call('addRoomAgent', [room.id, agent.id]);

  return {
    value: { ok: true, room: room.id, agent: agent.id },
    lines: [`Added ${agent.name} to "${room.title}".`],
  };
}

/**
 * Make a group.
 *
 * At least two agents, refused rather than warned about: a group of one is a
 * direct chat, and every screen that renders a room would then have to cope
 * with a room that is not one.
 *
 * There is no `--model` and no `--provider`, and that absence is deliberate.
 * A room does not reconfigure the agents in it — they arrive configured, and
 * a room that could change that would make the same agent answer differently
 * depending on where it was spoken to.
 */
export async function roomsNew(ctx: CommandContext): Promise<Rendered> {
  const [title, ...members] = ctx.positional;
  if (!title || members.length === 0) {
    throw new Error('Usage: wispcrew rooms new <name> <agent> <agent> [--greeting "…"]');
  }

  if (members.length < 2) {
    throw new Error(
      'A group needs at least two agents. For one agent, talk to it directly: wispcrew ask <agent> "…"',
    );
  }

  const roster = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const chosen = members.map((name) => findAgent(roster, name));

  const greeting =
    typeof ctx.args.greeting === 'string' ? ctx.args.greeting : undefined;

  /*
   * Start from an existing conversation, optionally carrying its history.
   *
   * The desktop asks this as a question when a second agent is added to a
   * one-to-one. The CLI cannot ask, so it takes the answer as a flag —
   * present means bring it, absent means start empty. Never inferred: the
   * difference is whether a private conversation is handed to an agent that
   * was not part of it.
   */
  const from =
    typeof ctx.args.from === 'string' ? (await findRoom(ctx, ctx.args.from)).id : undefined;

  if (ctx.args['with-history'] === true && !from) {
    throw new Error('--with-history needs --from <room> to say which history to bring.');
  }

  const room = await ctx.client.call<Record<string, unknown>>('createRoom', [
    {
      title,
      agentIds: chosen.map((a) => a.id as string),
      greeting,
      fromConversationId: ctx.args['with-history'] === true ? from : undefined,
    },
  ]);

  return {
    value: room,
    lines: [
      `Created "${title}" with ${chosen.map((a) => a.name).join(', ')}.`,
      // A hint has to name a command that exists. This one used to point at
      // `wispcrew room`, which never did.
      `Say something:  wispcrew rooms say "${title}" "..."`,
    ],
  };
}

/**
 * How full a conversation's context is, and optionally compact it.
 *
 * Belongs here as much as in the window. A headless box running routines is
 * exactly where a conversation fills up unwatched, and where nobody is
 * looking at a meter — `wispcrew context <agent>` is how an operator finds
 * out, and `--compact` is how they act on it over ssh.
 */
export async function contextCommand(ctx: CommandContext): Promise<Rendered> {
  const [name] = ctx.positional;
  if (!name) throw new Error('Usage: wispcrew context <agent or room> [--compact]');

  const room = await findRoom(ctx, name);

  if (ctx.args.compact === true) {
    const result = await ctx.client.call<{
      ok: boolean;
      reason?: string;
      replaced?: number;
      kept?: number;
    }>('compactConversation', [room.id]);

    return {
      value: result,
      lines: result.ok
        ? [
            `Compacted "${room.title}".`,
            `  ${result.replaced} earlier entries replaced by a summary`,
            `  ${result.kept} recent entries kept exactly as they were`,
            '  the full version is saved — restore it from History',
          ]
        : // A refusal is an answer, not a failure: say which.
          [`Nothing was changed. ${result.reason ?? ''}`.trim()],
    };
  }

  const report = await ctx.client.call<{
    used: number;
    measured: boolean;
    limit?: number;
    fraction?: number;
    systemTokens: number;
    toolTokens: number;
    messageTokens: number;
    model?: string;
    agentName?: string;
  }[]>('getContextReports', [room.id]);

  /*
   * One block per member, fullest first.
   *
   * A room has ONE history and a different answer for every agent in it:
   * the same forty thousand tokens is a tenth of one model's window and a
   * third of another's. A single figure would be right for at most one
   * member, and the only question anyone asks of several meters is which
   * one is about to become a problem.
   */
  const lines: string[] = [`"${room.title}"`];

  for (const r of report) {
    const approx = r.measured ? '' : '~';
    const pct = r.fraction !== undefined ? ` (${Math.round(r.fraction * 100)}%)` : '';

    lines.push(
      '',
      `  ${r.agentName ?? 'agent'}${r.model ? ` — ${r.model}` : ''}`,
      `    ${approx}${r.used} of ${r.limit ?? 'an unknown number of'} tokens${pct}`,
      `    system prompt  ~${r.systemTokens}`,
      `    tools          ~${r.toolTokens}`,
      `    messages       ~${r.messageTokens}`,
      r.measured
        ? '    (reported by the provider for the last turn)'
        : '    (estimated — no turn has run on this build yet)',
    );

    if (!r.limit) {
      /*
       * Never invent a denominator — and say what would fix it. Without a
       * known window there is also no automatic compaction, which is the
       * consequence worth knowing about.
       */
      lines.push(
        '    no context size is known for this model, so there is no percentage',
        '    and nothing will be compacted automatically. Set one with:',
        `      wispcrew agents set "${r.agentName ?? name}" --context-window <tokens>`,
      );
    }
  }

  return { value: report, lines };
}

/**
 * Read or set the room's standing instructions.
 *
 * Reading is half the point. These instructions are visible to every member
 * and to the user by design, so there has to be a way to see what a room is
 * telling its agents without opening the desktop app.
 */
export async function roomsGreeting(ctx: CommandContext): Promise<Rendered> {
  const [roomName, ...rest] = ctx.positional;
  if (!roomName) {
    throw new Error('Usage: wispcrew rooms greeting <room> ["…"]   (omit the text to read it)');
  }

  const room = await findRoom(ctx, roomName);
  const text = rest.join(' ');

  // No text given: report what is there rather than silently clearing it.
  // Clearing is `--clear`, so it cannot happen by leaving an argument off.
  if (!text && ctx.args.clear !== true) {
    const current = String(room.greeting ?? '');
    return {
      value: { room: room.id, greeting: current || null },
      lines: current
        ? [`"${room.title}" tells everyone who joins:`, '', ...current.split('\n').map((l) => `  ${l}`)]
        : [`"${room.title}" has no standing instructions.`],
    };
  }

  const updated = await ctx.client.call<Record<string, unknown>>('setRoomGreeting', [
    room.id,
    ctx.args.clear === true ? '' : text,
  ]);

  return {
    value: updated,
    lines: [
      ctx.args.clear === true
        ? `Cleared the instructions for "${room.title}".`
        : `Everyone in "${room.title}" will now read that on arrival.`,
    ],
  };
}

/**
 * Delete a group and its transcript.
 *
 * Groups only. A private chat goes with its agent, so a second route to the
 * same end would only be a way to leave an agent with no conversation — the
 * node refuses it and says which command to use instead.
 *
 * Exists because a group now survives its founder: without it, deleting
 * every member left a room nobody could remove and nothing could answer.
 */
export async function roomsDelete(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which room? Usage: wispcrew rooms delete <room> --yes');

  const room = await findRoom(ctx, wanted);
  if (ctx.args.yes !== true) {
    throw new Error(`This deletes "${room.title}" and everything said in it. Re-run with --yes.`);
  }

  await ctx.client.call('deleteRoom', [room.id]);
  return {
    value: { ok: true, room: room.id },
    lines: [`Deleted "${room.title}". The agents that were in it are untouched.`],
  };
}

export async function roomsRemove(ctx: CommandContext): Promise<Rendered> {
  const [roomName, agentName] = ctx.positional;
  if (!roomName || !agentName) {
    throw new Error('Usage: wispcrew rooms remove <room> <agent>');
  }

  const room = await findRoom(ctx, roomName);
  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const agent = findAgent(agents, agentName);

  await ctx.client.call('removeRoomParticipant', [room.id, agent.id]);

  return {
    value: { ok: true, room: room.id, agent: agent.id },
    lines: [`Removed ${agent.name} from "${room.title}".`],
  };
}

/* ------------------------------------------------------------------ */
/* routines                                                            */
/* ------------------------------------------------------------------ */

export async function routinesList(ctx: CommandContext): Promise<Rendered> {
  const routines = await ctx.client.call<Record<string, unknown>[]>('listRoutines');
  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const nameOf = (id: unknown) => String(agents.find((a) => a.id === id)?.name ?? id);

  const lines =
    routines.length === 0
      ? ['No routines. Create one with:  wispcrew routines create <agent> <cron> "<prompt>"']
      : table(
          routines.map((r) => [
            String(r.name),
            nameOf(r.agentId),
            String(r.cron ?? (r.runAt ? 'once' : '')),
            r.enabled === false ? 'paused' : 'on',
          ]),
          ['NAME', 'AGENT', 'WHEN', 'STATE'],
        );

  return { value: routines, lines };
}

export async function routinesCreate(ctx: CommandContext): Promise<Rendered> {
  const [agentName, cron] = ctx.positional;
  const prompt = ctx.positional.slice(2).join(' ') || text(ctx.args, 'prompt');

  if (!agentName || !cron || !prompt) {
    throw new Error(
      'Usage: wispcrew routines create <agent> "<cron>" "<prompt>"\n' +
        '  e.g. wispcrew routines create Builder "0 9 * * *" "Check the build"',
    );
  }

  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const agent = findAgent(agents, agentName);

  const created = await ctx.client.call<Record<string, unknown>>('createRoutine', [
    {
      agentId: agent.id,
      name: text(ctx.args, 'name') ?? prompt.slice(0, 40),
      cron,
      prompt,
      enabled: ctx.args.paused !== true,
    },
  ]);

  return {
    value: created,
    lines: [
      `Created "${created.name}" for ${agent.name}.`,
      `  runs  ${cron}`,
      ...(ctx.args.paused === true ? ['  paused — enable it with routines resume'] : []),
    ],
  };
}

export async function routinesDelete(ctx: CommandContext): Promise<Rendered> {
  const routine = await findRoutine(ctx, ctx.positional[0]);

  if (ctx.args.yes !== true) {
    throw new Error(`This deletes the routine "${routine.name}". Re-run with --yes.`);
  }

  await ctx.client.call('deleteRoutine', [routine.id]);
  return {
    value: { ok: true, deleted: routine.id },
    lines: [`Deleted "${routine.name}".`],
  };
}

export async function routinesRun(ctx: CommandContext): Promise<Rendered> {
  const routine = await findRoutine(ctx, ctx.positional[0]);

  /*
   * Fire it now, without waiting for the schedule.
   *
   * The command that makes a cron routine testable: writing "0 9 * * *" and
   * finding out tomorrow whether the prompt was right is a poor loop.
   */
  await ctx.client.call('runRoutineNow', [routine.id]);

  return {
    value: { ok: true, id: routine.id, name: routine.name },
    lines: [
      `Started "${routine.name}".`,
      'Follow it with:  wispcrew tasks',
    ],
  };
}

export async function routinesPause(ctx: CommandContext, enabled: boolean): Promise<Rendered> {
  const routine = await findRoutine(ctx, ctx.positional[0]);
  await ctx.client.call('updateRoutine', [routine.id, { enabled }]);

  return {
    value: { ok: true, id: routine.id, enabled },
    lines: [`"${routine.name}" is now ${enabled ? 'active' : 'paused'}.`],
  };
}

/* ------------------------------------------------------------------ */
/* skills, grants, history                                             */
/* ------------------------------------------------------------------ */

export async function skillsList(ctx: CommandContext): Promise<Rendered> {
  const skills = await ctx.client.call<Record<string, unknown>[]>('listSkills');

  const lines =
    skills.length === 0
      ? ['No skills. A skill is a reusable instruction set, invoked with /name.']
      : table(
          skills.map((s) => [
            `/${s.name}`,
            String(s.description ?? '').slice(0, 60),
          ]),
          ['SKILL', 'WHAT IT DOES'],
        );

  return { value: skills, lines };
}

export async function grantsList(ctx: CommandContext): Promise<Rendered> {
  const grants = await ctx.client.call<Record<string, unknown>[]>('listToolGrants');
  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const nameOf = (id: unknown) => String(agents.find((a) => a.id === id)?.name ?? id);

  const lines =
    grants.length === 0
      ? ['No standing permissions. Every tool call asks.']
      : table(
          grants.map((g) => [nameOf(g.agentId), String(g.tool)]),
          ['AGENT', 'ALWAYS ALLOWED'],
        );

  return { value: grants, lines };
}

export async function grantsRevoke(ctx: CommandContext): Promise<Rendered> {
  if (ctx.args.all === true) {
    /*
     * The panic button, and the reason it is not the default: revoking
     * everything makes every agent ask again, which is safe and noisy.
     */
    await ctx.client.call('revokeAllToolGrants');
    return { value: { ok: true, revoked: 'all' }, lines: ['Revoked every standing permission.'] };
  }

  const [agentName, tool] = ctx.positional;
  if (!agentName || !tool) {
    throw new Error('Usage: wispcrew grants revoke <agent> <tool>   (or --all)');
  }

  const agents = await ctx.client.call<Record<string, unknown>[]>('listAgents');
  const agent = findAgent(agents, agentName);

  await ctx.client.call('revokeToolGrant', [agent.id, tool]);
  return {
    value: { ok: true, agent: agent.id, tool },
    lines: [`${agent.name} will be asked about "${tool}" again.`],
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
/* MCP servers                                                         */
/* ------------------------------------------------------------------ */

export async function mcpList(ctx: CommandContext): Promise<Rendered> {
  const servers = await ctx.client.call<Record<string, unknown>[]>('listMcpServers');

  const lines =
    servers.length === 0
      ? ['No MCP servers. Add one with:  wispcrew mcp add <name> <command> [args...]']
      : table(
          servers.map((s) => [
            String(s.name),
            String(s.command ?? ''),
            (s.tools as unknown[] | undefined)?.length
              ? `${(s.tools as unknown[]).length} tools`
              : 'not connected',
          ]),
          ['NAME', 'COMMAND', 'STATE'],
        );

  return { value: servers, lines };
}

export async function mcpAdd(ctx: CommandContext): Promise<Rendered> {
  const [name, command, ...args] = ctx.positional;
  if (!name || !command) {
    throw new Error(
      'Usage: wispcrew mcp add <name> <command> [args...]\n' +
        '  e.g. wispcrew mcp add files npx -y @modelcontextprotocol/server-filesystem /data',
    );
  }

  const created = await ctx.client.call<Record<string, unknown>>('addMcpServer', [
    { name, command, args },
  ]);

  return {
    value: created,
    lines: [`Added "${name}".`, `  ${command} ${args.join(' ')}`.trimEnd()],
  };
}

export async function mcpRemove(ctx: CommandContext): Promise<Rendered> {
  const name = ctx.positional[0];
  if (!name) throw new Error('Which server? Usage: wispcrew mcp remove <name>');

  if (ctx.args.yes !== true) {
    throw new Error(`This removes the MCP server "${name}". Re-run with --yes.`);
  }

  await ctx.client.call('removeMcpServer', [name]);
  return { value: { ok: true, removed: name }, lines: [`Removed "${name}".`] };
}

/* ------------------------------------------------------------------ */
/* history and recovery                                                */
/* ------------------------------------------------------------------ */

export async function historyList(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which room? Usage: wispcrew history <room>');

  const room = await findRoom(ctx, wanted);
  const versions = await ctx.client.call<Record<string, unknown>[]>('listHistory', [room.id]);

  const lines =
    versions.length === 0
      ? ['No earlier versions of this conversation.']
      : table(
          versions.map((v) => [
            String(v.id).slice(0, 8),
            ageOf(Number(v.savedAt)),
            `${v.entryCount ?? '?'} entries`,
            String(v.reason ?? ''),
          ]),
          ['ID', 'SAVED', 'SIZE', 'WHY'],
        );

  return { value: versions, lines };
}

export async function historyRestore(ctx: CommandContext): Promise<Rendered> {
  const [roomName, versionId] = ctx.positional;
  if (!roomName || !versionId) {
    throw new Error('Usage: wispcrew history restore <room> <id>');
  }

  const room = await findRoom(ctx, roomName);
  const versions = await ctx.client.call<Record<string, unknown>[]>('listHistory', [room.id]);

  const matches = versions.filter((v) => String(v.id).startsWith(versionId));
  if (matches.length === 0) throw new Error(`No saved version starts with "${versionId}".`);
  if (matches.length > 1) {
    throw new Error(`"${versionId}" matches ${matches.length} versions. Use more characters.`);
  }

  /*
   * Restoring replaces the current transcript, and the current one is saved
   * first — so this is reversible, which is why it does not demand --yes.
   */
  await ctx.client.call('restoreHistory', [room.id, matches[0]!.id]);

  return {
    value: { ok: true, room: room.id, version: matches[0]!.id },
    lines: [
      `Restored "${room.title}" to its earlier version.`,
      'The version you replaced was saved too.',
    ],
  };
}

export async function roomsRewind(ctx: CommandContext): Promise<Rendered> {
  const [roomName, entryId] = ctx.positional;
  if (!roomName || !entryId) {
    throw new Error(
      'Usage: wispcrew rooms rewind <room> <entry-id>\n' +
        '  Find an id with:  wispcrew rooms tail <room> --json',
    );
  }

  const room = await findRoom(ctx, roomName);
  await ctx.client.call('rewindConversation', [room.id, entryId]);

  return {
    value: { ok: true, room: room.id, to: entryId },
    lines: [
      `Rewound "${room.title}".`,
      'The removed part was saved — see:  wispcrew history ' + room.title,
    ],
  };
}

export async function roomsBranch(ctx: CommandContext): Promise<Rendered> {
  const [roomName, entryId] = ctx.positional;
  if (!roomName || !entryId) {
    throw new Error('Usage: wispcrew rooms branch <room> <entry-id> [--name <name>]');
  }

  const room = await findRoom(ctx, roomName);
  const created = await ctx.client.call<Record<string, unknown>>('branchConversation', [
    room.id,
    entryId,
    text(ctx.args, 'name'),
  ]);

  return {
    value: created,
    lines: [
      `Branched into "${created.name}".`,
      'The original is untouched.',
    ],
  };
}

export async function roomsClear(ctx: CommandContext): Promise<Rendered> {
  const wanted = ctx.positional[0];
  if (!wanted) throw new Error('Which room? Usage: wispcrew rooms clear <room> --yes');

  const room = await findRoom(ctx, wanted);
  if (ctx.args.yes !== true) {
    throw new Error(`This clears "${room.title}". Re-run with --yes.`);
  }

  await ctx.client.call('clearConversation', [room.id]);
  return {
    value: { ok: true, room: room.id },
    lines: [`Cleared "${room.title}".`, 'Recoverable from:  wispcrew history ' + room.title],
  };
}

export async function roomsMode(ctx: CommandContext): Promise<Rendered> {
  const [roomName, mode] = ctx.positional;
  if (!roomName || !mode) {
    throw new Error('Usage: wispcrew rooms mode <room> <directed|open|free>');
  }

  const room = await findRoom(ctx, roomName);
  await ctx.client.call('setRoomMode', [room.id, mode]);

  return {
    value: { ok: true, room: room.id, mode },
    lines: [`"${room.title}" is now ${mode}.`],
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
      { name: '--provider', required: true, description: 'preset id; see `providers`' },
      { name: '--model', required: true, description: 'one this provider serves; see `models`' },
      { name: '--description', required: false },
      { name: '--policy', required: false, description: 'ask | auto | readonly' },
      { name: '--workspace', required: false },
    ],
    returns: 'the created agent',
    notes:
      'Provider and model are both required and are one decision. Nothing is ' +
      'inherited from global settings: an agent carries where it runs and what it ' +
      'runs on, so changing a global setting can never silently move it.',
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
    name: 'rooms show',
    summary: 'One conversation: who is in it, and how much has been said.',
    args: [{ name: 'room', required: true, positional: true, description: 'title or id' }],
    returns: 'the room, plus an entry count',
  },
  {
    name: 'rooms tail',
    summary: 'The last part of a conversation.',
    args: [
      { name: 'room', required: true, positional: true },
      { name: '--lines', required: false, description: 'default 20' },
    ],
    returns: 'array of transcript entries',
    notes: 'How to see what an unattended agent has been doing.',
  },
  {
    name: 'rooms new',
    summary: 'Create a group: a place where configured agents talk to each other.',
    args: [
      { name: 'name', required: true, positional: true },
      { name: 'agents', required: true, positional: true, description: 'two or more, by name' },
      { name: '--greeting', required: false, description: 'tone and purpose; every member reads it' },
      { name: '--from', required: false, description: 'an existing conversation to start from' },
      {
        name: '--with-history',
        required: false,
        description: 'copy that conversation in, so a joining agent sees where things stand',
      },
    ],
    returns: 'the new room',
    notes:
      'A room has no model or provider — agents arrive configured. Two agents minimum: ' +
      'a group of one is a direct chat. --from without --with-history starts empty and ' +
      'leaves the original untouched either way.',
  },
  {
    name: 'rooms say',
    summary: 'Say something in a room, and wait for whoever answers.',
    args: [
      { name: 'room', required: true, positional: true },
      { name: 'message', required: true, positional: true },
      { name: '--timeout', required: false, description: 'seconds; default 180' },
    ],
    returns: '{ agent, answer, errors, timedOut }',
    notes:
      'Who replies is the room\u2019s business: address someone with @handle, use @all, or ' +
      'say nothing special to continue with whoever you last addressed. `ask` is the ' +
      'same thing aimed at one agent.',
  },
  {
    name: 'context',
    summary: "How full a conversation's context is; --compact to reclaim it.",
    args: [
      { name: 'agent', required: true, positional: true, description: 'agent or room' },
      { name: '--compact', required: false, description: 'replace older turns with a summary' },
    ],
    returns: '{ used, limit, fraction, systemTokens, toolTokens, messageTokens }',
    notes:
      'A model with no known window reports no percentage rather than a guessed one. ' +
      'Compaction checkpoints first, so the full conversation is restorable from History.',
  },
  {
    name: 'rooms greeting',
    summary: "Read or set a room's standing instructions.",
    args: [
      { name: 'room', required: true, positional: true },
      { name: 'text', required: false, positional: true, description: 'omit to read it' },
      { name: '--clear', required: false, description: 'remove the instructions' },
    ],
    returns: '{ room, greeting }',
    notes: 'Visible to every member and to the user; never a hidden system instruction.',
  },
  {
    name: 'rooms add',
    summary: 'Put an agent in a room, so it can be addressed there.',
    args: [
      { name: 'room', required: true, positional: true },
      { name: 'agent', required: true, positional: true },
    ],
    returns: '{ ok, room, agent }',
  },
  {
    name: 'rooms remove',
    summary: 'Take an agent out of a room.',
    args: [
      { name: 'room', required: true, positional: true },
      { name: 'agent', required: true, positional: true },
    ],
    returns: '{ ok, room, agent }',
  },
  {
    name: 'agents set',
    summary: 'Change an agent: provider, model, permissions, description, workspace.',
    notes:
      'Provider and model are checked as a PAIR, taking the missing half from the ' +
      'record — so `--model` alone cannot land a model this agent\u2019s provider does ' +
      'not serve. Refused at this point rather than at the first message.',
    args: [
      { name: 'agent', required: true, positional: true },
      { name: '--provider', required: false, description: 'preset id; see `providers`' },
      { name: '--model', required: false, description: 'one this provider serves' },
      { name: '--policy', required: false, description: 'ask | auto | readonly' },
      { name: '--description', required: false },
      { name: '--workspace', required: false },
      { name: '--name', required: false },
    ],
    returns: 'the updated agent',
  },
  {
    name: 'agents duplicate',
    summary: 'Copy an agent\u2019s configuration under a new name.',
    args: [{ name: 'agent', required: true, positional: true }],
    returns: 'the new agent',
    notes: 'Configuration only — the copy starts with an empty conversation.',
  },
  {
    name: 'agents stop',
    summary: 'Interrupt whatever an agent is doing.',
    args: [{ name: 'agent', required: true, positional: true }],
    returns: '{ ok, agent }',
  },
  {
    name: 'rooms delete',
    summary: 'Delete a group and everything said in it.',
    args: [
      { name: 'room', required: true, positional: true },
      { name: '--yes', required: true, description: 'destructive; required in scripts' },
    ],
    returns: '{ ok, room }',
    notes:
      'Groups only — a private chat goes with its agent, so use `agents delete` for that. ' +
      'The agents that were in the room are untouched.',
  },
  {
    name: 'rooms clear',
    summary: 'Empty a conversation.',
    args: [
      { name: 'room', required: true, positional: true },
      { name: '--yes', required: true, description: 'destructive; required in scripts' },
    ],
    returns: '{ ok, room }',
    notes: 'Recoverable — the previous version is kept, see history.',
  },
  {
    name: 'rooms mode',
    summary: 'How much the room constrains who speaks.',
    args: [
      { name: 'room', required: true, positional: true },
      { name: 'mode', required: true, positional: true, description: 'directed | open | free' },
    ],
    returns: '{ ok, room, mode }',
  },
  {
    name: 'rooms rewind',
    summary: 'Drop everything after an entry.',
    args: [
      { name: 'room', required: true, positional: true },
      { name: 'entry', required: true, positional: true, description: 'id from rooms tail --json' },
    ],
    returns: '{ ok, room, to }',
    notes: 'The removed part is saved and appears in history.',
  },
  {
    name: 'rooms branch',
    summary: 'Fork a conversation into a new agent from a chosen point.',
    args: [
      { name: 'room', required: true, positional: true },
      { name: 'entry', required: true, positional: true },
      { name: '--name', required: false },
    ],
    returns: 'the new agent',
    notes: 'The original is untouched.',
  },
  {
    name: 'history',
    summary: 'Earlier versions of a conversation, kept before anything was removed.',
    args: [{ name: 'room', required: true, positional: true }],
    returns: 'array of saved versions',
  },
  {
    name: 'history restore',
    summary: 'Put a conversation back to an earlier version.',
    args: [
      { name: 'room', required: true, positional: true },
      { name: 'id', required: true, positional: true, description: 'a prefix is enough' },
    ],
    returns: '{ ok, room, version }',
    notes: 'Reversible — the version being replaced is saved first.',
  },
  {
    name: 'mcp',
    summary: 'Model Context Protocol servers, and whether they connected.',
    args: [],
    returns: 'array of servers',
  },
  {
    name: 'mcp add',
    summary: 'Register an MCP server, extending every agent\u2019s tools.',
    args: [
      { name: 'name', required: true, positional: true },
      { name: 'command', required: true, positional: true },
      { name: 'args', required: false, positional: true, description: 'remaining words' },
    ],
    returns: 'the server',
  },
  {
    name: 'mcp remove',
    summary: 'Unregister an MCP server.',
    args: [
      { name: 'name', required: true, positional: true },
      { name: '--yes', required: true },
    ],
    returns: '{ ok, removed }',
  },
  {
    name: 'providers',
    summary: 'Provider presets this build knows about.',
    args: [],
    returns: 'array of { id, label, defaultModel }',
  },
  {
    name: 'models',
    summary: 'What a provider actually serves, asked of the provider.',
    args: [
      { name: 'provider', required: true, positional: true, description: 'preset id' },
      { name: '--refresh', required: false, description: 're-ask instead of reading the cache' },
    ],
    returns: 'array of { id, tested }',
    notes:
      'The curated list in each preset is short and goes stale — NVIDIA serves 84 ' +
      'and the preset names six. This is the real one.',
  },
  {
    name: 'personas',
    summary: 'Built-in agent personas.',
    args: [],
    returns: 'array of { id, description }',
  },
  {
    name: 'test provider',
    summary: 'Check the configured provider actually answers.',
    args: [],
    returns: '{ ok, error? }',
    notes: 'The difference between "configured" and "working" — run it after configure.',
  },
  {
    name: 'test telegram',
    summary: 'Send a test message through Telegram.',
    args: [],
    returns: '{ ok, error? }',
  },
  {
    name: 'signins',
    summary: 'Subscription sign-ins and whether they are still valid.',
    args: [],
    returns: 'array of { vendor, signedIn, detail }',
  },
  {
    name: 'signout',
    summary: 'Forget a subscription sign-in.',
    args: [{ name: 'vendor', required: true, positional: true, description: 'claude | chatgpt' }],
    returns: '{ ok, vendor }',
  },
  {
    name: 'routines',
    summary: 'Scheduled work: what runs, for whom, and when.',
    args: [],
    returns: 'array of routines',
  },
  {
    name: 'routines create',
    summary: 'Schedule a prompt to run on its own.',
    args: [
      { name: 'agent', required: true, positional: true },
      { name: 'cron', required: true, positional: true, description: 'five fields, e.g. "0 9 * * *"' },
      { name: 'prompt', required: true, positional: true },
      { name: '--name', required: false },
      { name: '--paused', required: false, description: 'create it inactive' },
    ],
    returns: 'the created routine',
  },
  {
    name: 'routines run',
    summary: 'Run a routine now, without waiting for its schedule.',
    args: [{ name: 'routine', required: true, positional: true }],
    returns: '{ ok, id, name }',
    notes: 'How to test a routine without waiting until tomorrow.',
  },
  {
    name: 'routines pause',
    summary: 'Stop a routine firing, without deleting it.',
    args: [{ name: 'routine', required: true, positional: true }],
    returns: '{ ok, id, enabled }',
  },
  {
    name: 'routines resume',
    summary: 'Let a paused routine fire again.',
    args: [{ name: 'routine', required: true, positional: true }],
    returns: '{ ok, id, enabled }',
  },
  {
    name: 'routines delete',
    summary: 'Remove a routine.',
    args: [
      { name: 'routine', required: true, positional: true },
      { name: '--yes', required: true, description: 'destructive; required in scripts' },
    ],
    returns: '{ ok, deleted }',
  },
  {
    name: 'skills',
    summary: 'Reusable instruction sets, invoked in a message with /name.',
    args: [],
    returns: 'array of skills',
  },
  {
    name: 'grants',
    summary: 'Standing permissions — tools an agent may use without asking.',
    args: [],
    returns: 'array of { agentId, tool }',
  },
  {
    name: 'grants revoke',
    summary: 'Take back a standing permission, so the agent asks again.',
    args: [
      { name: 'agent', required: false, positional: true },
      { name: 'tool', required: false, positional: true },
      { name: '--all', required: false, description: 'revoke every grant' },
    ],
    returns: '{ ok, agent, tool } or { ok, revoked }',
  },
  {
    name: 'machines',
    summary: 'Other machines paired with this one.',
    args: [],
    returns: 'array of { id, name, address, fingerprint }',
  },
  {
    name: 'machines forget',
    summary: 'Drop a paired machine and delete its token here.',
    args: [{ name: 'machine', required: true, positional: true, description: 'name or id' }],
    returns: '{ ok, forgotten, name }',
  },
  {
    name: 'pair',
    summary: 'Attach another machine, using a code it printed.',
    args: [
      { name: 'address', required: true, positional: true, description: 'host or host:port' },
      { name: 'code', required: true, positional: true, description: 'single-use, expires' },
      {
        name: '--fingerprint',
        required: false,
        description: 'what the other machine printed; checked before trusting it',
      },
      { name: '--yes', required: false, description: 'pair without checking a fingerprint' },
    ],
    returns: '{ ok, id, name, address, fingerprint }',
    notes:
      'Get a code with "wispcrew serve --network --pair" there. A daemon records ' +
      'the peer but does not dial it yet, so run cross-machine work from the desktop.',
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

/**
 * Find a room by title or id, refusing an ambiguous match.
 *
 * Two rooms may share a title — an agent's own room is named after it — so
 * guessing would send a message to the wrong conversation.
 */
async function findRoom(
  ctx: CommandContext,
  wanted: string,
): Promise<Record<string, unknown>> {
  const rooms = await ctx.client.call<Record<string, unknown>[]>('listConversations');

  const byId = rooms.find((r) => r.id === wanted);
  if (byId) return byId;

  const matches = rooms.filter(
    (r) => String(r.title).toLowerCase() === wanted.toLowerCase(),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `More than one room is called "${wanted}". Use an id:\n` +
        matches.map((r) => `  ${r.id}  ${r.title}`).join('\n'),
    );
  }

  throw new Error(
    `No room called "${wanted}". Available:\n` +
      rooms.map((r) => `  ${r.title}`).join('\n'),
  );
}

/** Find a routine by name or id, refusing an ambiguous match. */
async function findRoutine(
  ctx: CommandContext,
  wanted: string | undefined,
): Promise<Record<string, unknown>> {
  if (!wanted) throw new Error('Which routine? Its name or id.');

  const routines = await ctx.client.call<Record<string, unknown>[]>('listRoutines');

  const byId = routines.find((r) => r.id === wanted);
  if (byId) return byId;

  const matches = routines.filter(
    (r) => String(r.name).toLowerCase() === wanted.toLowerCase(),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `More than one routine is called "${wanted}". Use an id:\n` +
        matches.map((r) => `  ${r.id}  ${r.name}`).join('\n'),
    );
  }

  throw new Error(
    `No routine called "${wanted}". Available:\n` +
      routines.map((r) => `  ${r.name}`).join('\n'),
  );
}

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
