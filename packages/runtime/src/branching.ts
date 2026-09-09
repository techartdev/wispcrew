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

/**
 * How an agent's own words are marked when several agents share a history.
 *
 * Every chat API has exactly one `assistant` role, so a room's transcript --
 * which knows perfectly well who wrote what -- collapses into a single
 * undifferentiated voice the moment it becomes a request. The consequences
 * were not subtle:
 *
 *   - An agent read its own previous message as a colleague's, described its
 *     own plan in the third person, and waited for itself to reply.
 *   - It could not tell a task assigned TO it from its own acknowledgement
 *     of that task, so concrete work sat unowned.
 *
 * Both were reported as the model being confused about its identity. It was
 * not: the information had been removed before it ever arrived. `authorId`
 * is recorded on every room message and was dropped here -- the same
 * declared-but-never-read fault as `via` and the age of a tool result, and
 * the comment below has named `authorId` as an example of it for months
 * while the field itself stayed dropped.
 *
 * Marked in the text rather than in a field, because a field would need
 * every provider adapter to agree on how to render it, and one that forgot
 * would silently reintroduce exactly this bug. A prefix costs a few tokens
 * and cannot be dropped by an adapter that has not heard of it.
 */
function speakerPrefix(
  entry: Extract<TranscriptEntry, { kind: 'message' }>,
  selfId: string | undefined,
  nameFor: ((id: string) => string | undefined) | undefined,
): string {
  if (entry.role !== 'assistant' || !entry.authorId) return '';
  // A solo conversation has one voice and needs no label.
  if (!nameFor) return '';
  if (selfId && entry.authorId === selfId) return '';

  const handle = nameFor(entry.authorId);
  return handle ? `[@${handle}] ` : '';
}

export function rebuildHistory(
  entries: TranscriptEntry[],
  /**
   * Who is reading this history, and what the other agents are called.
   *
   * Omitted for a one-to-one conversation, where there is a single assistant
   * and nothing to disambiguate.
   */
  speakers?: {
    selfId?: string;
    nameFor?: (id: string) => string | undefined;
    /**
     * Put the speaker in the TEXT, for providers with no `name` field.
     *
     * True for Anthropic, false everywhere else. Both channels at once
     * teaches a model that the prefix is part of the format it should
     * produce, and a stored echo of it makes an agent read its own messages
     * as somebody else's.
     */
    inline?: boolean;
  },
): ChatMessage[] {
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

        /*
         * Whose words these are, when the room holds more than one agent.
         *
         * Only OTHER agents are labelled. Prefixing an agent's own messages
         * would teach it to write its own handle into its replies, which is
         * both noise and a second way for it to lose track of itself.
         */
        const speaker = speakerPrefix(entry, speakers?.selfId, speakers?.nameFor);

        /*
         * Both channels, because no single one works everywhere.
         *
         * `name` is what OpenAI-compatible APIs provide for exactly this,
         * and it is what AutoGen uses (`message["name"] = speaker.name`).
         * It is structured, unambiguous, and impossible for a model to
         * confuse with its own words.
         *
         * Anthropic's Messages API has no such field, so for Claude the
         * only channel is the text itself -- which is why the inline prefix
         * stays. Adapters that support `name` prefer it; the prefix is the
         * fallback, and the sanitiser on the way IN stops the model's echo
         * of it ever being stored.
         */
        const authored =
          entry.role === 'assistant' && entry.authorId && speakers?.nameFor
            ? speakers.nameFor(entry.authorId)
            : undefined;

        /*
         * One attribution channel, chosen by the caller -- never both.
         *
         * Sending `name` AND an inline "[@handle] " prefix gives a model two
         * competing signals about who is speaking, one of them inside text
         * it also produces itself. Belt and braces reads as safety and is
         * the opposite: the model learns the prefix is part of the format,
         * writes one, and then cannot recognise its own words.
         *
         * `inline` is for providers with nowhere structured to put a
         * speaker -- Anthropic's Messages API has no `name` field, so the
         * text is the only channel there is. Everything else uses the field,
         * which a model cannot confuse with its own prose.
         */
        out.push({
          role: entry.role,
          content: speakers?.inline ? `${speaker}${via}${entry.content}` : `${via}${entry.content}`,
          ...(authored ? { name: authored } : {}),
        });
        break;
      }
      case 'tool-call': {
        /*
         * A colleague's tool call is not this agent's memory.
         *
         * Tool entries had no author at all until now, so in a room every
         * agent received every other agent's calls as unattributed
         * assistant turns -- which is precisely the shape of its own work.
         * One agent was handed several hundred commands it had never run.
         * It could no longer tell a task assigned to it from its own reply,
         * because the turns around that assignment all looked like its own.
         *
         * Dropped rather than labelled, unlike prose. A tool call is a
         * REQUEST with a matching result, and a request the model never
         * made -- carrying output it never received -- is a false memory
         * whichever way it is worded. What a colleague did belongs in the
         * room as the sentence that colleague wrote about it.
         *
         * It also costs nothing to lose: tool output is the bulk of a
         * working transcript, so every agent's window stops filling with
         * every other agent's shell output.
         */
        if (
          speakers?.selfId &&
          entry.authorId &&
          entry.authorId !== speakers.selfId
        ) {
          break;
        }

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
