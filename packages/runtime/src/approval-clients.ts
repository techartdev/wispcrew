/**
 * approval-clients.ts — who a headless node can ask for permission.
 *
 * A node runs shell commands. When an agent needs approval, somebody has to
 * decide, and until now a node had only two answers: a CLI attached on the
 * same machine, or a denial.
 *
 * That left the common case broken. An agent on a VPS, driven from a desktop
 * on someone's laptop, could not ask the person actually driving it: the
 * request parked until it timed out, and the conversation hung with no card
 * and no explanation. Measured — asking the VPS agent to run `date` produced
 * only `run-state` events and zero approval cards.
 *
 * A connected client is a person. This is the registry of them.
 */
import type { ApprovalResolution } from '@wispcrew/shared';

export interface ApprovalRequest {
  agentId: string;
  agentName: string;
  tool: string;
  summary: string;
  /**
   * The approval entry the node wrote in its own transcript.
   *
   * The card renders from that entry, so the client must resolve the same
   * id rather than inventing one nobody is looking at.
   */
  requestId: string;
  detail?: string;
}

type Asker = (request: ApprovalRequest) => Promise<ApprovalResolution>;

/**
 * Ordered by arrival, and the MOST RECENT is asked first.
 *
 * Someone who connected a moment ago is more likely to be watching than a
 * link that has idled all day — and a stale connection that has silently
 * stopped reading would otherwise absorb every request until it timed out.
 */
const clients: { id: number; ask: Asker }[] = [];
let nextId = 1;

/** Register a connected client as somebody who can be asked. */
export function registerApprovalClient(ask: Asker): () => void {
  const id = nextId++;
  clients.push({ id, ask });

  return () => {
    const at = clients.findIndex((c) => c.id === id);
    if (at !== -1) clients.splice(at, 1);
  };
}

/** Is anyone attached who could answer? */
export function hasApprovalClient(): boolean {
  return clients.length > 0;
}

/**
 * Ask the attached clients, newest first, until one answers.
 *
 * Returns `null` when nobody is attached, so the caller can fall back to
 * whatever it does with nobody to ask — this module deliberately does not
 * decide that policy.
 *
 * A client that throws or drops is skipped rather than treated as a denial,
 * because another client may still be watching and able to answer properly.
 * If none can, the caller's own default applies.
 */
export async function askApprovalClients(
  request: ApprovalRequest,
): Promise<ApprovalResolution | null> {
  if (clients.length === 0) return null;

  for (const client of [...clients].reverse()) {
    try {
      return await client.ask(request);
    } catch {
      // Try the next one. A broken link is not an answer.
    }
  }

  return null;
}
