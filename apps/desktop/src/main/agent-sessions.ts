/**
 * agent-sessions.ts — per-agent conversation sessions.
 *
 * The original UI sends one `sendPrompt` per user message and expects the
 * agent to remember the conversation. Creating a fresh `Agent` per prompt
 * would reset `history` every turn (the model would forget everything), so
 * we keep one live `Agent` per agentId here.
 *
 * A session is rebuilt only when the provider-relevant settings change
 * (provider/model/baseUrl/key/persona/workspace) — that way switching model
 * in the picker takes effect immediately, while ordinary chatting keeps the
 * accumulated history.
 *
 * Sessions also own the in-flight run so the UI's Stop button
 * (`interruptAgentRun`) can abort a turn via `Agent.abort()`.
 */
import { Agent } from '@ghostbot/core';
import type { ChatProvider } from '@ghostbot/shared';
import { ToolRegistry } from '@ghostbot/tools';
import type { ApprovalRequest } from '@ghostbot/shared';

export interface SessionSeed {
  provider: ChatProvider;
  tools: ToolRegistry;
  systemPrompt?: string;
  workspaceRoot: string;
  /** Identity of the config that produced this session; change ⇒ rebuild. */
  fingerprint: string;
  onApprovalRequired: (request: ApprovalRequest) => Promise<boolean>;
}

interface Session {
  agent: Agent;
  fingerprint: string;
  /** True while a turn is streaming; used to reject overlapping runs. */
  running: boolean;
}

const sessions = new Map<string, Session>();

/**
 * Get the live Agent for `agentId`, creating (or recreating) it when the
 * configuration fingerprint changed. Existing history is preserved across
 * calls with an unchanged fingerprint.
 */
export function getSession(agentId: string, seed: SessionSeed): Agent {
  const existing = sessions.get(agentId);
  if (existing && existing.fingerprint === seed.fingerprint) {
    return existing.agent;
  }

  const agent = new Agent({
    provider: seed.provider,
    tools: seed.tools,
    systemPrompt: seed.systemPrompt,
    workspaceRoot: seed.workspaceRoot,
    onApprovalRequired: seed.onApprovalRequired,
  });

  // Carry the prior conversation across a config change (e.g. model switch)
  // so switching models mid-chat does not wipe the user's context.
  if (existing) {
    agent.history.push(...existing.agent.history);
  }

  sessions.set(agentId, { agent, fingerprint: seed.fingerprint, running: false });
  return agent;
}

/** Mark a session's run state (used to guard against overlapping turns). */
export function setRunning(agentId: string, running: boolean): void {
  const s = sessions.get(agentId);
  if (s) s.running = running;
}

export function isRunning(agentId: string): boolean {
  return sessions.get(agentId)?.running ?? false;
}

/**
 * Abort the in-flight turn for `agentId`. Returns true when a session
 * existed to abort (the UI's Stop button path).
 */
export function abortSession(agentId: string): boolean {
  const s = sessions.get(agentId);
  if (!s) return false;
  s.agent.abort();
  s.running = false;
  return true;
}

/** Drop a session entirely (agent deleted / conversation cleared). */
export function clearSession(agentId: string): void {
  const s = sessions.get(agentId);
  if (s) {
    s.agent.abort();
    sessions.delete(agentId);
  }
}

/** Number of live sessions (diagnostics). */
export function sessionCount(): number {
  return sessions.size;
}
