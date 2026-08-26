/**
 * pending-approvals.ts — a headless node can ask, if someone is listening.
 *
 * A daemon denies anything needing approval, because there is nobody to ask.
 * That is right when nobody is attached, and wrong the moment a CLI is: a
 * person running `wispcrew approvals` on the same machine is exactly the
 * someone the rule assumes does not exist.
 *
 * So a request is parked here instead of refused outright, and answered by
 * whoever is attached. If nobody answers, it still ends in a denial — the
 * default stays safe, which is the property that matters. A headless install
 * is only headless until the first `ask` policy fires, and before this that
 * meant the agent simply stopped.
 *
 * What this is NOT: a way around approval. Every request still has to be
 * answered explicitly, and an unanswered one is denied.
 */
import { randomUUID } from 'node:crypto';

export interface PendingApproval {
  id: string;
  agentId: string;
  agentName: string;
  tool: string;
  /** What the tool was asked to do, summarised for a person. */
  summary: string;
  createdAt: number;
  expiresAt: number;
}

interface Waiting extends PendingApproval {
  settle(allowed: boolean): void;
}

/**
 * How long a request waits.
 *
 * Long enough for someone to notice and answer; short enough that an agent
 * is not wedged for an afternoon because a terminal was closed. The Telegram
 * approval path uses five minutes for the same reason.
 */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const waiting = new Map<string, Waiting>();

/**
 * Clients that have said they will answer approvals.
 *
 * Being connected is not enough. A script polling `agents --json` every
 * minute is attached and will never answer anything, so parking requests for
 * it would replace a fast denial with a five-minute stall — worse than the
 * behaviour it was meant to improve.
 *
 * So a client opts in by calling `watchApprovals`, and the count drops when
 * it disconnects.
 */
let lastSeen = 0;

/**
 * How long a watcher counts as present after its last check.
 *
 * Time-based rather than a connection count, because the client that most
 * needs this is `wispcrew ask` — which blocks waiting for a reply and is not
 * polling anything while it waits. Tying "someone is there" to an open
 * socket would deny exactly the case the feature exists for.
 *
 * Two minutes: long enough to cover a turn that pauses to ask, short enough
 * that a terminal closed an hour ago does not still count as attended.
 */
export const LISTENER_TTL_MS = 2 * 60_000;

export function hasApprovalListener(): boolean {
  return Date.now() - lastSeen < LISTENER_TTL_MS;
}

/** Note that a client capable of answering is around. */
export function touchApprovalListener(): void {
  lastSeen = Date.now();
}

/** Everything currently awaiting an answer, oldest first. */
export function listPending(): PendingApproval[] {
  const now = Date.now();
  return [...waiting.values()]
    .filter((w) => w.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(({ settle, ...rest }) => rest);
}

/**
 * Park a request and wait for an answer.
 *
 * Resolves `false` on timeout: an approval nobody answered is a denial, not
 * an allowance. This is the invariant that lets the whole mechanism exist
 * without weakening anything.
 */
export function askAndWait(request: {
  agentId: string;
  agentName: string;
  tool: string;
  summary: string;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = randomUUID();
    const now = Date.now();

    let settled = false;
    const settle = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      waiting.delete(id);
      resolve(allowed);
    };

    waiting.set(id, {
      id,
      agentId: request.agentId,
      agentName: request.agentName,
      tool: request.tool,
      summary: request.summary,
      createdAt: now,
      expiresAt: now + APPROVAL_TIMEOUT_MS,
      settle,
    });

    /*
     * Unreferenced, so a pending approval cannot hold the process open.
     * A daemon that will not exit because something is waiting for an answer
     * is worse than one that denies and moves on.
     */
    setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS).unref?.();
  });
}

/** Answer one request. Returns false if it is unknown or already settled. */
export function resolve(id: string, allowed: boolean): boolean {
  const found = waiting.get(id);
  if (!found) return false;
  found.settle(allowed);
  return true;
}

/**
 * Deny everything, for shutdown.
 *
 * A request left parked across a restart would resolve against an engine
 * that no longer exists, so they are settled rather than abandoned.
 */
export function denyAll(): void {
  for (const item of [...waiting.values()]) item.settle(false);
}
