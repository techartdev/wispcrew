/**
 * context-report.ts — the shape of a context measurement.
 *
 * The measurement ITSELF is taken in `engine.ts`, beside the code that
 * assembles a request, and deliberately so: it needs the same system
 * prompt, the same tool definitions and the same rebuilt history that
 * `runPrompt` sends. Reproducing that here would be a second assembly of
 * the same thing, and the two would drift — leaving a meter that measures a
 * request nobody makes, which is worse than no meter because it is
 * believed.
 *
 * What lives here is the part with no dependencies: the record a client
 * receives, and the per-agent limit override.
 */
import type { ContextReport } from '@wispcrew/core';

export type { ContextReport };

/** A context report, with the agent and model it was measured for. */
export interface ConversationContext extends ContextReport {
  conversationId: string;
  /**
   * Whose prompt was measured.
   *
   * A group has one history but a different system prompt per member. The
   * difference is small — a prompt is hundreds of tokens against a history
   * of tens of thousands — so one member's figure describes the room, and
   * naming which one keeps that honest rather than implicit.
   */
  agentId?: string;
  agentName?: string;
  model?: string;
}
