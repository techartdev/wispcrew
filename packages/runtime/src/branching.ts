/**
 * branching.ts — rewind a conversation, or fork it into a new agent.
 *
 * Two related operations the commercial alternatives do not offer:
 *
 *  - **Rewind**: drop everything after a chosen message and continue from
 *    there. Useful when an answer went sideways and you want to re-ask
 *    without the bad turn poisoning the context.
 *  - **Branch**: copy the conversation up to a chosen message into a *new*
 *    agent, leaving the original untouched. Useful for exploring two
 *    approaches from a shared starting point.
 *
 * The hard part is not the UI, it is reconstructing what the *model* should
 * see from what the *user* sees. The transcript is a display log containing
 * things the model never receives (notices, approval cards) and it stores
 * tool calls as flat cards rather than the paired
 * assistant-tool-call / tool-result messages every chat API demands.
 *
 * Chat APIs reject a conversation where an assistant tool call has no
 * matching tool result. Truncating a transcript mid-turn is therefore very
 * easy to get wrong: cut between a call and its result and the next request
 * fails with an opaque 400. `rebuildHistory` guarantees that never happens by
 * dropping any trailing assistant turn whose tool calls are unanswered.
 */
import type { ChatMessage, TranscriptEntry } from '@wispcrew/shared';

/**
 * Rebuild the model-visible history from a transcript prefix.
 *
 * Rules, each of which exists for a reason:
 *  - `notice` and `approval` entries are display-only and are skipped.
 *  - A `tool-call` card becomes an assistant message carrying the call plus
 *    a matching `role:"tool"` result. Cards still `running`, or ones that
 *    were `denied`, get a synthetic result so the pair is never broken.
 *  - A streaming assistant message that never completed is dropped: half a
 *    sentence is worse context than none.
 */
export function rebuildHistory(entries: TranscriptEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];

  for (const entry of entries) {
    switch (entry.kind) {
      case 'message': {
        if (!entry.content.trim()) continue;
        if (entry.role === 'assistant' && entry.isStreaming) continue;
        out.push({ role: entry.role, content: entry.content });
        break;
      }
      case 'tool-call': {
        // The assistant turn that requested the tool, then its result. Both
        // must be present or the provider rejects the whole conversation.
        out.push({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: entry.id, name: entry.toolName, args: entry.args ?? {} }],
        });
        // The result must never be empty: some providers reject a tool
        // message with no content, and an empty string tells the model
        // nothing about why the call produced no output.
        const fallback =
          entry.status === 'denied'
            ? 'Tool call denied by the user.'
            : entry.status === 'running'
              ? 'Tool call did not complete.'
              : entry.status === 'failed'
                ? 'Tool call failed.'
                : 'Tool call produced no output.';
        out.push({
          role: 'tool',
          toolCallId: entry.id,
          toolName: entry.toolName,
          content: entry.content?.trim() ? entry.content : fallback,
        });
        break;
      }
      default:
        // notice / approval: shown to the user, never sent to the model.
        break;
    }
  }

  return dropUnansweredTail(out);
}

/**
 * Remove a trailing assistant message whose tool calls have no results.
 *
 * `rebuildHistory` always emits calls and results together, so this is a
 * belt-and-braces guard for histories assembled elsewhere (or by a future
 * change). Providers reject unanswered tool calls outright, and the error
 * they return does not say which message is at fault.
 */
function dropUnansweredTail(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set(
    messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string),
  );
  const out = [...messages];
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.role === 'assistant' && last.toolCalls?.length) {
      const unanswered = last.toolCalls.some((tc) => !answered.has(tc.id));
      if (unanswered) {
        out.pop();
        continue;
      }
    }
    break;
  }
  return out;
}

/**
 * Find where to cut a transcript so it *ends* with the given entry.
 *
 * Returns the entries up to and including `entryId`, or null when the id is
 * not present. Callers treat null as "nothing to do" rather than an error,
 * because an entry can legitimately disappear (cleared chat, trimmed history)
 * between the UI rendering a button and the user pressing it.
 */
export function prefixThrough(
  entries: TranscriptEntry[],
  entryId: string,
): TranscriptEntry[] | null {
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx === -1) return null;
  return entries.slice(0, idx + 1);
}

/**
 * Prefix *before* a user message, for "edit and retry".
 *
 * Everything from that message onward is discarded, so the user can rephrase
 * and continue with the earlier context intact.
 */
export function prefixBefore(
  entries: TranscriptEntry[],
  entryId: string,
): TranscriptEntry[] | null {
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx === -1) return null;
  return entries.slice(0, idx);
}
