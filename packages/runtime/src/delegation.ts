/**
 * delegation.ts — let one agent hand work to another.
 *
 * The commercial alternatives expose this as "bots messaging bots". The
 * capability is genuinely useful — a researcher agent handing findings to a
 * writer agent, a coordinator fanning work out to specialists — but it is
 * also the easiest way to build a machine that burns money in a loop.
 *
 * The guarantees this module provides, and why each exists:
 *
 *  - **Depth limit.** A delegated agent may itself delegate, but only
 *    `MAX_DEPTH` levels deep. Without this, two agents that each think the
 *    other should handle a task ping-pong forever.
 *  - **Cycle detection.** An agent already on the call stack cannot be
 *    invoked again in the same chain. This catches A→B→A directly rather
 *    than waiting for the depth limit to expire.
 *  - **Fan-out limit.** One turn may delegate at most `MAX_CALLS_PER_TURN`
 *    times, so a model that decides to "ask everyone" cannot start twenty
 *    parallel conversations.
 *  - **No self-delegation.** Calling yourself is always a bug.
 *  - **Inherited approval policy.** A delegate never gets *more* permission
 *    than its caller. An agent restricted to read-only cannot escape that by
 *    asking a permissive agent to run the command for it — which would
 *    otherwise be a real privilege-escalation path.
 *
 * The delegate runs in its own conversation with its own history, so its
 * transcript is a first-class record the user can open and read, not a hidden
 * side effect.
 */
import type { AgentRecord, ApprovalPolicy, Tool, ToolContext, ToolResult } from '@wispcrew/shared';
import * as store from './store.js';
import { fileLog } from './filelog.js';

/** How many levels of delegation are allowed below the user's own message. */
export const MAX_DEPTH = 3;
/** How many delegations a single turn may make. */
export const MAX_CALLS_PER_TURN = 5;
/** Hard ceiling on how long a delegated turn may run. */
export const DELEGATE_TIMEOUT_MS = 300_000;

/**
 * Ambient state for one delegation chain.
 *
 * `stack` is the list of agent ids currently executing, innermost last.
 */
export interface DelegationContext {
  depth: number;
  stack: string[];
  /** Mutable counter shared by every tool call within one turn. */
  callsUsed: { count: number };
  /** The caller's policy; a delegate may not exceed it. */
  policy: ApprovalPolicy;
  /**
   * Agents already in this conversation, which are NOT delegates.
   *
   * Delegation and room membership are different relationships. A delegate
   * is asked privately and reports back; a room member is addressed with
   * `@handle` and answers in front of everyone. Offering both meant an
   * agent that had just been asked a question handed it to a room-mate
   * instead of answering it — measured, not theorised: two agents in a room
   * each delegated to a third, and the room filled with "Reply from
   * Assistant" while nobody actually answered.
   */
  roomMembers?: string[];
}

/** A fresh context for a turn started by the human. */
export function rootContext(
  policy: ApprovalPolicy,
  agentId: string,
  roomMembers?: string[],
): DelegationContext {
  return { depth: 0, stack: [agentId], callsUsed: { count: 0 }, policy, roomMembers };
}

/**
 * Narrow a policy so a delegate is never more privileged than its caller.
 *
 * `readonly` is the most restrictive, `auto` the least. A `readonly` caller
 * forces `readonly`; an `ask` caller forbids `auto`.
 */
export function narrowPolicy(caller: ApprovalPolicy, callee: ApprovalPolicy): ApprovalPolicy {
  if (caller === 'readonly') return 'readonly';
  if (caller === 'ask') return callee === 'auto' ? 'ask' : callee;
  return callee;
}

/** Runs a prompt against another agent. Injected to avoid a circular import. */
export type DelegateRunner = (
  agentId: string,
  prompt: string,
  ctx: DelegationContext,
) => Promise<string>;

interface AskAgentArgs {
  agent: string;
  task: string;
}

/**
 * A note appended to a delegate's task when it cannot delegate further.
 *
 * Without this, an agent whose instructions say "always hand this on" simply
 * finds no `ask_agent` tool and often echoes the request back instead of
 * answering — observed live with a deliberately cyclic pair. Telling it
 * plainly that it is the last link produces an actual answer.
 */
export const TERMINAL_NOTICE =
  '\n\n(Note: you cannot delegate this further — you are the final agent in this ' +
  'chain. Answer it yourself as best you can.)';

/** True when this context has no remaining delegation capacity. */
export function isTerminal(callerId: string, ctx: DelegationContext): boolean {
  if (ctx.depth >= MAX_DEPTH) return true;
  if (ctx.callsUsed.count >= MAX_CALLS_PER_TURN) return true;
  return (
    store
      .listAgents()
      .filter((a) => !a.archived && a.id !== callerId && !ctx.stack.includes(a.id)).length === 0
  );
}

/**
 * Build the `ask_agent` tool for one specific caller.
 *
 * The tool is constructed per run rather than registered globally because its
 * description must list the agents that actually exist, and its behaviour
 * depends on who is calling.
 */
export function makeAskAgentTool(
  callerId: string,
  ctx: DelegationContext,
  run: DelegateRunner,
): Tool<AskAgentArgs> | null {
  const caller = store.listAgents().find((a) => a.id === callerId);

  /*
   * Could this agent do something the caller cannot?
   *
   * Delegation is worth its cost — a second model call, a second
   * transcript, a relayed answer — only when the delegate brings something:
   * another MACHINE, or a stated specialism. An agent with neither is pure
   * indirection, and measured behaviour is that a model offered such a tool
   * will use it: "what is 3 + 4?" went to a general-purpose agent, came
   * back as "7", and was relayed.
   *
   * Prose did not fix this. Three instructions to answer from its own
   * knowledge were all ignored, because a tool that is offered gets used.
   */
  const couldPlausiblyHelp = (a: AgentRecord): boolean => {
    // A different machine is a real capability: the work has to happen there.
    if ((a.nodeId ?? '') !== (caller?.nodeId ?? '')) return true;

    /*
     * The default agent is not a delegate.
     *
     * Every fresh profile creates one so the roster is not empty. It is
     * general-purpose by definition, on this machine, with no stated
     * specialism — so it can never do anything the caller cannot, and
     * measured behaviour is that a model offered it will use it: "what is
     * 3 + 4?" went there, came back as "7", and was relayed.
     *
     * Narrowed deliberately to this case. "Undescribed agents cannot be
     * delegates" also worked, and would have silently broken delegation for
     * anyone who created "Rust expert" and forgot the description.
     */
    const isDefaultAgent =
      a.name === 'Assistant' && a.persona === 'general' && !a.description?.trim();

    return !isDefaultAgent;
  };

  const candidates = store
    .listAgents()
    .filter(
      (a) =>
        !a.archived &&
        a.id !== callerId &&
        !ctx.stack.includes(a.id) &&
        // A room-mate is addressed with @handle, not delegated to.
        !(ctx.roomMembers ?? []).includes(a.id) &&
        couldPlausiblyHelp(a),
    );

  // Nothing to delegate to: do not advertise a tool that can only fail.
  if (candidates.length === 0) return null;
  if (ctx.depth >= MAX_DEPTH) return null;

  const roster = candidates
    .map((a) => `- "${a.name}"${a.description ? `: ${a.description.slice(0, 120)}` : ''}`)
    .join('\n');

  return {
    definition: {
      name: 'ask_agent',
      description:
        'Delegate a self-contained task to another agent and get its answer back. ' +
        'Use this when a different agent is clearly better suited (different instructions, ' +
        'model, or workspace). The other agent does not see this conversation, so the task ' +
        'must be complete and standalone.\n\nAvailable agents:\n' +
        roster,
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Name of the agent to ask (exactly as listed)' },
          task: {
            type: 'string',
            description: 'A complete, standalone description of the work, including all context',
          },
        },
        required: ['agent', 'task'],
      },
    },

    async run(args: AskAgentArgs): Promise<ToolResult> {
      const fail = (content: string, errorCode: string): ToolResult => ({
        id: '',
        name: 'ask_agent',
        ok: false,
        errorCode,
        content,
      });

      if (ctx.callsUsed.count >= MAX_CALLS_PER_TURN) {
        return fail(
          `Delegation limit reached (${MAX_CALLS_PER_TURN} per turn). Complete the work yourself or report what you have.`,
          'limit',
        );
      }

      const wanted = String(args.agent ?? '').trim().toLowerCase();
      const target: AgentRecord | undefined = candidates.find(
        (a) => a.name.trim().toLowerCase() === wanted,
      );
      if (!target) {
        return fail(
          `No agent named "${args.agent}" is available. Choose one of: ${candidates.map((a) => a.name).join(', ')}.`,
          'unknown_agent',
        );
      }

      const task = String(args.task ?? '').trim();
      if (!task) return fail('The task description was empty.', 'bad_request');

      ctx.callsUsed.count++;
      const childCtx: DelegationContext = {
        depth: ctx.depth + 1,
        stack: [...ctx.stack, target.id],
        callsUsed: ctx.callsUsed,
        policy: narrowPolicy(ctx.policy, target.approvalPolicy ?? ctx.policy),
      };

      fileLog('[delegate]', callerId, '->', target.id, `depth=${childCtx.depth}`);

      try {
        const answer = await withTimeout(
          run(target.id, task, childCtx),
          DELEGATE_TIMEOUT_MS,
          `Agent "${target.name}" did not finish within ${Math.round(DELEGATE_TIMEOUT_MS / 1000)}s.`,
        );
        return {
          id: '',
          name: 'ask_agent',
          ok: true,
          content: `Reply from "${target.name}":\n\n${answer}`,
          data: { agentId: target.id, agentName: target.name },
        };
      } catch (err) {
        return fail(`Agent "${target.name}" failed: ${(err as Error).message}`, 'delegate_failed');
      }
    },
  };
}

/** Reject a promise that outlives `ms`, so one stuck delegate cannot hang the chain. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Unused import guard: `ToolContext` documents the tool signature. */
export type { ToolContext };
