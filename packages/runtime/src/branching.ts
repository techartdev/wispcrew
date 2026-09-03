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
 *  - An `info` notice IS sent: it records something that happened to the
 *    conversation. An `error` notice and an `approval` are display-only.
 *  - A `tool-call` card becomes an assistant message carrying the call plus
 *    a matching `role:"tool"` result. Cards still `running`, or ones that
 *    were `denied`, get a synthetic result so the pair is never broken.
 *  - A streaming assistant message that never completed is dropped: half a
 *    sentence is worse context than none.
 */
/**
 * How old a tool result must be before its age is worth saying.
 *
 * A turn that makes six calls in ten seconds does not need each one
 * labelled; a result from before lunch does. Ten minutes is comfortably
 * longer than any single turn and far shorter than "things may have
 * changed".
 */
const STALE_TOOL_RESULT_MS = 10 * 60 * 1000;

/** Plain English, because a timestamp invites arithmetic and gets it wrong. */
function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function rebuildHistory(entries: TranscriptEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];

  for (const entry of entries) {
    switch (entry.kind) {
      case 'message': {
        if (!entry.content.trim()) continue;
        if (entry.role === 'assistant' && entry.isStreaming) continue;

        /*
         * Where the person is, when they are not at the app.
         *
         * `via` has been recorded on every message since channels existed
         * and was dropped here, so the model never saw it — the same
         * declared-but-unused shape as `authorId` before it. An agent
         * learned that a request came from Telegram only when a policy
         * notice happened to mention it, which is luck rather than design.
         *
         * It matters for the answer, not just for the record: somebody on a
         * phone wants a short reply, not four hundred words of markdown
         * with file paths they cannot click. Marked rather than described,
         * in the same shape as `[room]`, so it costs a few tokens and never
         * gets mistaken for the user's own words.
         */
        const via = entry.role === 'user' && entry.via && entry.via !== 'app'
          ? `[via ${entry.via}] `
          : '';

        out.push({ role: entry.role, content: `${via}${entry.content}` });
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
        /*
         * How old this answer is, when it is old enough to matter.
         *
         * A tool result is a fact about the world at a MOMENT — what the
         * open pull requests were, what the file said, whether the build
         * passed. The transcript records when, and this dropped it, so the
         * model saw a seven-hour-old `gh pr list` exactly as it saw one
         * from four seconds ago.
         *
         * Observed: an agent listed the open PRs at 15:28, was asked "so is
         * there new PRs or issues?" at 22:18, and answered from the earlier
         * output in four seconds without checking again. Nothing it could
         * see said the data was stale — the same class as `via` and
         * `authorId`, where the record holds a fact the model never gets.
         *
         * Only past the threshold, so an ordinary multi-step turn is not
         * peppered with "[0 minutes ago]" on every call it just made.
         */
        const age = Date.now() - entry.createdAt;
        const stale = age >= STALE_TOOL_RESULT_MS ? `[from ${describeAge(age)}] ` : '';

        out.push({
          role: 'tool',
          toolCallId: entry.id,
          toolName: entry.toolName,
          content: entry.content?.trim() ? `${stale}${entry.content}` : fallback,
        });
        break;
      }
      case 'notice': {
        // Addressed to the person, about the mechanism. Showing it to the
        // model made the model route around the mechanism.
        if (entry.userOnly) break;
        /*
         * What happened TO the conversation, told to the model.
         *
         * Every notice used to be display-only, which quietly defeated the
         * whole point of writing them. An agent renamed mid-conversation
         * kept using its old handle and explained why with complete
         * accuracy: "I can see the conversation messages delivered to me,
         * but not necessarily every system-level room event." It was right.
         * The room said "X is now addressed as @y", the user could read it,
         * and the agent never received a word of it.
         *
         * The same silence applied to every other fact worth knowing: a
         * member joining or leaving, the workspace moving to a different
         * folder, and the seam notice that names who is who after a room
         * carries history from an older chat.
         *
         * ERRORS stay out. A provider failure or a turn that could not
         * finish is a report for the person, and the model already met that
         * failure as a tool result or an exception. Replaying "fetch
         * failed" as context invites it to apologise for something that did
         * not happen in its turn.
         */
        if (entry.level === 'error') continue;
        if (!entry.text?.trim()) continue;

        /*
         * Carried as a user-role message with a marker.
         *
         * Not `system`: several providers accept only one system message,
         * at the start, and this can arrive at any point. Not `assistant`:
         * that would put the room's words in the agent's own mouth, and it
         * would then defend them as its own. A marked user message is
         * unambiguous about who is speaking without lying about the role.
         */
        out.push({ role: 'user', content: `[room] ${entry.text.trim()}` });
        break;
      }
      default:
        // approval: shown to the user, never sent to the model.
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
