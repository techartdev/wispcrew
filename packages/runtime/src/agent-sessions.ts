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
import { Agent } from '@wispcrew/core';
import type { ChatMessage, ChatProvider } from '@wispcrew/shared';
import { ToolRegistry } from '@wispcrew/tools';
import type { ApprovalRequest } from '@wispcrew/shared';

export interface SessionSeed {
  provider: ChatProvider;
  tools: ToolRegistry;
  systemPrompt?: string;
  workspaceRoot: string;
  /** Identity of the config that produced this session; change ⇒ rebuild. */
  fingerprint: string;
  onApprovalRequired: (request: ApprovalRequest) => Promise<boolean>;
  /**
   * History to install when this is a genuinely cold start (no prior live
   * session). Lets a restarted app — or a freshly branched agent — pick the
   * conversation back up instead of answering with no memory of what is
   * plainly visible on screen.
   */
  initialHistory?: ChatMessage[];
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
  } else if (seed.initialHistory?.length) {
    // No live session: this is a cold start (app restart, or a freshly
    // branched agent). Seed from the stored transcript so the model
    // remembers the conversation the user can see on screen.
    agent.setHistory(seed.initialHistory);
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

/**
 * Replace a live session's history (rewind / branch).
 *
 * If no session exists yet the call is a no-op by design: the next
 * `getSession` builds a fresh Agent, and `runPrompt` seeds it from the
 * (already truncated) transcript, so the outcome is identical either way.
 */
export function seedSessionHistory(agentId: string, messages: ChatMessage[]): void {
  const s = sessions.get(agentId);
  if (!s) return;
  s.agent.abort();
  s.agent.setHistory(messages);
  s.running = false;
}

/** Number of live sessions (diagnostics). */
export function sessionCount(): number {
  return sessions.size;
}
