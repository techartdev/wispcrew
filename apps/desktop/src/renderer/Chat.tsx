/**
 * Chat.tsx — the conversation view: transcript, tool cards, approval
 * prompts, and the composer.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { AgentRunState, SkillRecord, TranscriptEntry } from '@wispcrew/shared';
import { IconSend, IconStop, IconAttach, IconCheck, IconDeny } from './Icons.js';
import { Markdown } from './Markdown';
import { parseMention } from './mention';

interface ChatProps {
  /**
   * What this conversation IS — an agent, or a room.
   *
   * It used to be an `AgentRecord`, which was true only because a room was
   * its first agent. Every consequence of that shortcut showed up here: the
   * welcome heading, the composer placeholder and — worst — the name on
   * every assistant message came from one agent, so in a room holding Nudge
   * and Local Test, a reply from Local Test was labelled "Nudge".
   *
   * A narrow shape rather than a record, because that is all this component
   * needs. Nothing here reads a model, a policy or a workspace, and taking
   * a whole agent invited exactly the coupling being removed.
   */
  subject: { id: string; name: string; description?: string } | null;
  transcript: TranscriptEntry[];
  runState: AgentRunState;
  skills: SkillRecord[];

  /**
   * Who can be addressed in this room, for @-completion.
   *
   * Passed in rather than derived here: the room is the App's business, and
   * a component that reached for it would have to know about conversations
   * as well as messages.
   */
  members: { id: string; handle: string; name: string }[];

  /**
   * Panels `/` can open.
   *
   * Only panels that genuinely exist are offered — an action listing
   * something the app cannot do would be the same lie as a status nothing
   * emits.
   */
  onOpenRoutines(): void;
  onOpenHistory(): void;
  onOpenRoom(): void;
  onSend(prompt: string, attachmentPaths?: string[]): void;
  /**
   * Text to append to the draft, e.g. a handle the user clicked.
   *
   * Appended rather than replacing, and cleared once consumed, so a
   * half-written sentence survives.
   */
  insertText?: string | null;
  onInsertConsumed?: () => void;
  onInterrupt(): void;
  onResolveApproval(requestId: string, resolution: 'allow-once' | 'allow-always' | 'deny'): void;
  onOpenSettings(): void;
  onPickFiles(): Promise<string[]>;
  onRewind(entryId: string, mode: 'through' | 'before'): void;
  onBranch(entryId: string): void;
  /** Text from a retried message, to prefill the composer. */
  retryDraft?: string | null;
  onRetryDraftConsumed?(): void;
  /** Recovery action when the roster is empty. */
  onCreateAgent(): void;
  hasProvider: boolean;
}

/**
 * Per-message actions, revealed on hover.
 *
 * `Retry` on a user message rewinds to just before it and resends, which is
 * the common "that came out wrong, ask again" case. `Branch` copies the
 * conversation up to that point into a new agent so two lines of enquiry can
 * continue from a shared prefix without either overwriting the other.
 */
function MessageActions({
  entryId,
  role,
  disabled,
  onRewind,
  onBranch,
}: {
  entryId: string;
  role: 'user' | 'assistant';
  disabled: boolean;
  onRewind(entryId: string, mode: 'through' | 'before'): void;
  onBranch(entryId: string): void;
}) {
  return (
    <div className="msg-actions">
      {role === 'user' ? (
        <button
          type="button"
          className="msg-action"
          title="Remove this message and everything after it, then ask again"
          disabled={disabled}
          onClick={() => onRewind(entryId, 'before')}
        >
          Retry from here
        </button>
      ) : (
        <button
          type="button"
          className="msg-action"
          title="Discard everything after this reply"
          disabled={disabled}
          onClick={() => onRewind(entryId, 'through')}
        >
          Rewind to here
        </button>
      )}
      <button
        type="button"
        className="msg-action"
        title="Copy the conversation up to here into a new agent"
        disabled={disabled}
        onClick={() => onBranch(entryId)}
      >
        Branch
      </button>
    </div>
  );
}

/** Basename of a path, handling both separators. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* Tool call card                                                      */
/* ------------------------------------------------------------------ */

function ToolCard({ entry }: { entry: Extract<TranscriptEntry, { kind: 'tool-call' }> }) {
  // Long tool output is collapsed by default: a 4000-character file dump
  // would otherwise bury the assistant's actual answer.
  const [open, setOpen] = useState(false);

  const args = entry.args ? JSON.stringify(entry.args) : '';
  const preview = args.length > 90 ? `${args.slice(0, 90)}…` : args;

  const statusLabel: Record<typeof entry.status, string> = {
    running: 'Running',
    completed: 'Done',
    failed: 'Failed',
    denied: 'Denied',
  };

  return (
    <div className={`tool-card tool-${entry.status}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${entry.toolName}, ${statusLabel[entry.status]}. ${open ? 'Hide' : 'Show'} details`}
      >
        <span className="tool-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="tool-name">{entry.toolName}</span>
        {preview && <span className="tool-args">{preview}</span>}
        <span className={`tool-status tool-status-${entry.status}`}>
          {entry.status === 'running' && <span className="spinner" aria-hidden="true" />}
          {statusLabel[entry.status]}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          {entry.args && Object.keys(entry.args).length > 0 && (
            <pre className="tool-pre">{JSON.stringify(entry.args, null, 2)}</pre>
          )}
          {entry.content && <pre className="tool-pre">{entry.content}</pre>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Approval card                                                       */
/* ------------------------------------------------------------------ */

function ApprovalCard({
  entry,
  onResolve,
}: {
  entry: Extract<TranscriptEntry, { kind: 'approval' }>;
  onResolve: ChatProps['onResolveApproval'];
}) {
  if (entry.status !== 'pending') {
    return (
      <div className={`approval-card approval-${entry.status}`}>
        <span className="approval-icon">{entry.status === 'approved' ? '✓' : '✕'}</span>
        <span>
          {entry.status === 'approved' ? 'Approved' : 'Denied'}: <code>{entry.toolName}</code>
        </span>
      </div>
    );
  }

  return (
    <div className="approval-card approval-pending">
      <div className="approval-head">
        <span className="approval-icon">!</span>
        <strong>Permission required</strong>
      </div>
      <p className="approval-summary">{entry.summary}</p>
      {entry.detail && <p className="approval-detail">{entry.detail}</p>}
      <div className="approval-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onResolve(entry.requestId, 'allow-once')}
        >
          {/*
            A tick and a cross on the two one-word answers, because this is
            the control where a misread costs the most — it decides whether
            a command runs. "Always allow" gets NO tick: it looks alike
            enough to "Allow once" already, and an icon shared with the
            single-use option would make the safer choice harder to pick out.
          */}
          <IconCheck />
          Allow once
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onResolve(entry.requestId, 'allow-always')}
        >
          Always allow {entry.toolName}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => onResolve(entry.requestId, 'deny')}
        >
          <IconDeny />
          Deny
        </button>
      </div>
      <p className="approval-hint">
        “Always allow” applies to this agent until WispCrew restarts.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

export function Chat({
  subject,
  transcript,
  runState,
  skills,
  members,
  onOpenRoutines,
  onOpenHistory,
  onOpenRoom,
  onSend,
  insertText,
  onInsertConsumed,
  onInterrupt,
  onResolveApproval,
  onOpenSettings,
  onPickFiles,
  onRewind,
  onBranch,
  retryDraft,
  onRetryDraftConsumed,
  onCreateAgent,
  hasProvider,
}: ChatProps) {
  const [draft, setDraft] = useState('');

  /*
   * Where the caret is, so a mention can complete mid-sentence.
   *
   * The slash menu only ever needed the start of the draft; "@" does not —
   * "ask @linux to check the disk" is the ordinary shape, and completing
   * against the whole string would match the wrong word.
   */
  const [caret, setCaret] = useState(0);

  /** Which completion row the keyboard is on. */
  const [highlight, setHighlight] = useState(0);

  /*
   * Escape closed the menu, so it stays closed until the draft changes.
   *
   * A flag rather than nudging the caret out of the mention: that trick
   * worked until any click or arrow key put the caret back, at which point
   * the menu someone had just dismissed reappeared.
   */
  const [dismissed, setDismissed] = useState(false);

  /*
   * A handle clicked in the room strip.
   *
   * Appended rather than replacing, with a trailing space so the user can
   * keep typing — they are usually part-way through a sentence, and
   * clobbering it would be worse than making them type the handle. The
   * parent is told immediately, so clicking the same handle twice works.
   */
  useEffect(() => {
    if (!insertText) return;
    setDraft((current) => (current ? `${current.trimEnd()} ${insertText} ` : `${insertText} `));
    onInsertConsumed?.();
  }, [insertText, onInsertConsumed]);

  /** Absolute paths staged for the next message. */
  const [pending, setPending] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /*
   * Follow the conversation, but never fight the user.
   *
   * Auto-scrolling only happens while `pinnedRef` is true, which means "the
   * user is at the bottom". The subtlety is telling *our* scrolling apart
   * from *theirs*: writing `scrollTop` fires the same `scroll` event a wheel
   * gesture does, so naively recomputing the pin on every event let a
   * programmatic scroll re-pin a user who had deliberately scrolled up — and
   * the next token yanked them back down.
   *
   * `selfScrollingRef` marks the scrolls we cause so they are ignored. Intent
   * is also taken directly from the input devices: a wheel, touch drag or
   * navigation key unpins immediately, without waiting to see where the
   * scroll lands.
   */
  const pinnedRef = useRef(true);
  const selfScrollingRef = useRef(false);

  const busy = runState === 'thinking' || runState === 'awaiting-approval';

  /**
   * Is the viewport close enough to the end to count as "following"?
   *
   * A pane with nothing to scroll counts as at the bottom — there is no
   * "later" to jump to. Without that, a conversation that SHRANK (a reload,
   * a rewind, a cleared chat) could leave the jump button on screen over
   * content that fits entirely, offering to scroll somewhere that does not
   * exist. Reported exactly that way.
   */
  const atBottom = (el: HTMLElement) =>
    el.scrollHeight <= el.clientHeight || el.scrollHeight - el.scrollTop - el.clientHeight < 80;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Our own scroll: consume the flag and leave the pin as it was.
    if (selfScrollingRef.current) {
      selfScrollingRef.current = false;
      return;
    }
    pinnedRef.current = atBottom(el);
  }, []);

  /**
   * A deliberate gesture away from the bottom unpins at once.
   *
   * Waiting for the resulting scroll position is too slow during streaming:
   * new content can arrive between the gesture and the event, so the user
   * appears to still be at the bottom and gets pulled back.
   */
  const handleUserScrollIntent = useCallback((deltaY: number) => {
    if (deltaY < 0) {
      pinnedRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (el && atBottom(el)) pinnedRef.current = true;
  }, []);

  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    // Mark this as ours so `handleScroll` does not treat it as the user
    // choosing to be at the bottom (which would be circular, but more
    // importantly would mask a genuine scroll that arrives in the same tick).
    selfScrollingRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [transcript]);

  /*
   * Whether to offer "jump to latest".
   *
   * Held in state (not a ref) because it is rendered. Once a user scrolls
   * away during a live turn there is otherwise no signal that the reply is
   * still growing, and no quick way back — they have to drag to the end of
   * content that keeps moving.
   */
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setShowJump(!atBottom(el));
    update();
    el.addEventListener('scroll', update, { passive: true });

    /*
     * Content can change without anybody scrolling.
     *
     * The old version listened for `scroll` alone, so the answer went stale
     * the moment the transcript grew or shrank on its own: after a reload
     * the button stayed on screen over a conversation that fitted entirely,
     * with no scroll event coming to correct it.
     *
     * A ResizeObserver on the content is what actually changed — watching
     * the transcript length would miss a message growing as it streams.
     */
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);

    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [subject?.id, transcript.length]);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    selfScrollingRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  // Reset the pin when switching agents so a new conversation starts at the end.
  useEffect(() => {
    pinnedRef.current = true;
  }, [subject?.id]);

  // "Retry from here" removes a message and hands its text back; drop it into
  // the composer so the user can edit rather than retype.
  useEffect(() => {
    if (!retryDraft) return;
    setDraft(retryDraft);
    onRetryDraftConsumed?.();
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [retryDraft, onRetryDraftConsumed]);

  /* See `parseMention` below the component for the @-completion rules. */

  /* Slash-command completion for skills. */
  const slashQuery = useMemo(() => {
    const m = /^\/([\w-]*)$/.exec(draft);
    return m ? (m[1] ?? '') : null;
  }, [draft]);

  /*
   * Everything `/` can reach: skills, then actions.
   *
   * Skills first because they are the agent's own vocabulary and what a
   * person is usually reaching for; actions are a shortcut to a panel that
   * already has a button. Both are real — no action is listed that does not
   * open something that exists.
   */
  const slashMatches = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();

    const skillItems = skills
      .filter((s) => s.enabled && s.name.toLowerCase().startsWith(q))
      .map((s) => ({
        key: s.id,
        token: `/${s.name}`,
        detail: s.description ?? 'Skill',
      }));

    const actionItems = [
      { name: 'settings', detail: 'Open Settings', run: onOpenSettings },
      { name: 'routines', detail: 'Scheduled work for this agent', run: onOpenRoutines },
      { name: 'history', detail: 'Earlier versions of this conversation', run: onOpenHistory },
      { name: 'members', detail: 'Who is in this room', run: onOpenRoom },
    ]
      .filter((a) => a.name.startsWith(q))
      .map((a) => ({ key: `action_${a.name}`, token: `/${a.name}`, detail: a.detail, run: a.run }));

    return [...skillItems, ...actionItems].slice(0, 7);
  }, [skills, slashQuery, onOpenSettings, onOpenRoutines, onOpenHistory, onOpenRoom]);

  /*
   * Mention completion, anywhere in the message.
   *
   * Unlike `/`, which only opens a message, an @mention belongs mid-sentence
   * — "ask @linux to check the disk" is the ordinary shape. So this matches
   * at the caret rather than at the start.
   *
   * `parseMention` is exported and tested separately: the rules about what
   * does NOT open the menu (an email address, a price, a closed mention) are
   * where this kind of feature goes wrong.
   */
  /**
   * Who said this, by name.
   *
   * The transcript has recorded `authorId` since rooms existed, and nothing
   * ever read it: every assistant message wore the name of whichever agent
   * the conversation was rooted at. In a room holding Nudge and Local Test,
   * a reply from Local Test was labelled "Nudge" — the room-is-its-first-agent
   * shortcut showing through at the one place it is least excusable, on the
   * words themselves.
   *
   * An unknown or absent author falls back to the room's own name, which is
   * exactly what an entry written before authors existed meant: "the single
   * agent in this room".
   */
  const authorOf = useCallback(
    (entry: Extract<TranscriptEntry, { kind: 'message' }>): string => {
      if (entry.role === 'user') {
        // The door is worth naming: a message typed on a train reads
        // differently from one typed at the desk, and both are "You".
        return entry.via && entry.via !== 'app' ? `You · via ${entry.via}` : 'You';
      }
      const author = entry.authorId
        ? members.find((m) => m.id === entry.authorId)
        : undefined;
      if (author) return author.name;

      /*
       * Nobody recorded. With one agent in the room that is not ambiguous —
       * it said it — and that is exactly what an entry written before
       * authors existed meant.
       *
       * With several it IS ambiguous, and the room's own name must not be
       * used: labelling a reply "Deploy review" claims the room spoke.
       * Better to admit the transcript does not say.
       */
      if (members.length === 1) return members[0]!.name;
      return members.length > 1 ? 'Agent' : (subject?.name ?? 'Agent');
    },
    [members, subject?.name],
  );

  const mentionQuery = useMemo(() => parseMention(draft, caret), [draft, caret]);

  const mentionMatches = useMemo(() => {
    /*
     * Nobody to disambiguate between in a one-to-one, so `@` stays quiet.
     *
     * The gate moved here from the caller. `members` is now passed for every
     * conversation, because it is also how a message finds its author's name
     * — and a list that was empty for a direct chat would have left those
     * messages nameless.
     */
    if (mentionQuery === null || members.length < 2) return [];
    const q = mentionQuery.toLowerCase();
    return members
      .filter((m) => m.handle.toLowerCase().startsWith(q))
      .slice(0, 6);
  }, [members, mentionQuery]);

  /** Replace the half-typed mention at the caret with a complete one. */
  const insertMention = useCallback(
    (handle: string) => {
      const before = draft.slice(0, caret).replace(/@[\w-]*$/, '');
      const after = draft.slice(caret);
      const next = `${before}@${handle} ${after.startsWith(' ') ? after.slice(1) : after}`;

      setDraft(next);
      // Put the caret after the inserted handle, not at the end of the line —
      // otherwise completing a mention mid-sentence jumps the cursor away
      // from where the person was writing.
      const at = before.length + handle.length + 2;
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(at, at);
        setCaret(at);
      });
    },
    [draft, caret],
  );

  /*
   * Whichever completion menu is open, as one thing.
   *
   * The keyboard handler should not care which kind it is: arrowing,
   * accepting and dismissing are identical for both, and writing them twice
   * is how two menus drift into behaving differently.
   *
   * Only one is ever open — `@` and `/` are triggered by different
   * characters in different positions.
   */
  const menu = useMemo(() => {
    const empty = { kind: 'none' as const, items: [], accept: () => {} };
    if (dismissed) return empty;

    if (mentionMatches.length > 0) {
      return {
        kind: 'mention' as const,
        items: mentionMatches.map((m) => ({
          key: m.id,
          token: `@${m.handle}`,
          detail: m.name,
        })),
        accept: (item: { token: string }) => insertMention(item.token.slice(1)),
      };
    }

    if (slashMatches.length > 0) {
      return {
        kind: 'slash' as const,
        items: slashMatches,
        accept: (item: { token: string; run?: () => void }) => {
          /*
           * An action happens; a skill is inserted.
           *
           * `/settings` should open Settings, not type the word into a
           * message — an action that only wrote its own name would be a
           * worse way to reach a panel than the button already there.
           */
          if (item.run) {
            item.run();
            setDraft('');
            return;
          }
          setDraft(`${item.token} `);
          textareaRef.current?.focus();
        },
      };
    }

    return empty;
  }, [dismissed, mentionMatches, slashMatches, insertMention]);

  /*
   * The highlight resets whenever the list changes.
   *
   * Without this, narrowing a search leaves the highlight pointing past the
   * end — so Enter accepts nothing, or worse, accepts whatever slid into
   * that position while the person was still typing.
   */
  useEffect(() => {
    setHighlight(0);
  }, [menu.kind, menu.items.length]);

  /** Typing again brings a dismissed menu back. */
  useEffect(() => {
    setDismissed(false);
  }, [draft]);

  const submit = useCallback(() => {
    // No provider yet: send the user to Settings instead of letting the
    // message fail. A first-run dead end ("your API key was rejected" when
    // you never entered one) is the worst possible first impression.
    if (!hasProvider) {
      onOpenSettings();
      return;
    }
    const text = draft.trim();
    // An attachment with no words is a legitimate message ("look at this").
    if ((!text && pending.length === 0) || busy) return;
    onSend(text, pending.length ? pending : undefined);
    setDraft('');
    setPending([]);
    // Collapse the textarea back to one row after sending.
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [draft, pending, busy, onSend, hasProvider, onOpenSettings]);

  const addFiles = useCallback((paths: string[]) => {
    // De-duplicate: dropping the same file twice should not send it twice.
    setPending((prev) => [...new Set([...prev, ...paths])].slice(0, 10));
  }, []);

  const attach = useCallback(() => {
    void onPickFiles().then((paths) => {
      if (paths.length) addFiles(paths);
    });
  }, [onPickFiles, addFiles]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    /*
     * An open menu owns the keyboard first.
     *
     * Every branch here runs BEFORE Enter sends, because a menu that a
     * person is looking at should answer the keys they press at it. Enter
     * used to send unconditionally, so pressing it on a highlighted handle
     * sent "ask @lin" — the half-typed mention, not the one being chosen.
     */
    const open = menu.items.length > 0;

    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // Wraps, so holding one arrow always reaches every entry rather than
      // sticking silently at an end.
      setHighlight((h) => (h + step + menu.items.length) % menu.items.length);
      return;
    }

    // Enter and Tab both accept: Tab because completion menus use it, Enter
    // because that is what people press at a highlighted row.
    if (open && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault();
      menu.accept(menu.items[highlight] ?? menu.items[0]!);
      return;
    }

    /*
     * Escape closes the menu before it interrupts a run.
     *
     * Otherwise dismissing a completion nobody wanted would stop the agent —
     * a destructive surprise from the key people press to mean "never mind".
     */
    if (open && e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
      return;
    }

    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }

    if (e.key === 'Escape' && busy) onInterrupt();
  };

  /** Grow the composer with its content, up to a ceiling. */
  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  if (!subject) {
    // Reachable by deleting the last agent while the app is running. A bare
    // "No agent selected." would strand the user with no way forward, so
    // offer the one action that fixes it.
    return (
      <div className="chat empty-state">
        <div className="chat-welcome">
          <h2>No agents yet</h2>
          <p className="muted">
            Agents are durable teammates — each has its own instructions, model and
            workspace. Create one to start a conversation.
          </p>
          <button type="button" className="btn btn-primary" onClick={onCreateAgent}>
            Create an agent
          </button>
        </div>
      </div>
    );
  }

  /*
   * Drag-and-drop. Electron exposes the real filesystem path on the dropped
   * File object via `webUtils.getPathForFile` in newer versions; the legacy
   * `file.path` property still works in this Electron line and needs no
   * additional preload surface. We read only the path — never the contents —
   * so the sandboxed renderer never touches file data.
   */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const paths: string[] = [];
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = (file as File & { path?: string }).path;
      if (p) paths.push(p);
    }
    if (paths.length) addFiles(paths);
  };

  return (
    <div
      className={`chat ${dragging ? 'chat-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the chat area, not when
        // it crosses between child elements.
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {dragging && <div className="drop-overlay">Drop files to attach</div>}

      {/*
        Screen-reader announcements. The transcript itself is not a live
        region — announcing every streamed token would be unusable — so
        instead we announce discrete state changes: the agent started
        thinking, needs a decision, or finished. `polite` waits for a pause
        rather than interrupting whatever is being read.
      */}
      <div className="sr-only" role="status" aria-live="polite">
        {runState === 'thinking'
          ? `${subject?.name ?? 'Agent'} is working`
          : runState === 'awaiting-approval'
            ? 'Permission required'
            : ''}
      </div>

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        // Intent comes straight from the input device, so scrolling up
        // during a fast stream unpins immediately rather than racing the
        // tokens arriving underneath.
        onWheel={(e) => handleUserScrollIntent(-e.deltaY)}
        onTouchMove={() => {
          const el = scrollRef.current;
          if (el && !atBottom(el)) pinnedRef.current = false;
        }}
        onKeyDown={(e) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) pinnedRef.current = false;
          if (e.key === 'End') pinnedRef.current = true;
        }}
        role="log"
        aria-label="Conversation"
      >
        {transcript.length === 0 && (
          <div className="chat-welcome">
            <h2>{subject.name}</h2>
            <p className="muted">
              {subject.description?.trim() ||
                'Ask a question, or give it a task. It can read and write files, run commands, and search the web — with your approval.'}
            </p>
            {!hasProvider && (
              <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
                Configure a model provider to begin
              </button>
            )}
          </div>
        )}

        {transcript.map((entry) => {
          switch (entry.kind) {
            case 'message':
              return (
                <div key={entry.id} className={`msg msg-${entry.role}`}>
                  <div className="msg-head">
                    <span className="msg-role">{authorOf(entry)}</span>
                    {!entry.isStreaming && (
                      <MessageActions
                        entryId={entry.id}
                        role={entry.role}
                        disabled={busy}
                        onRewind={onRewind}
                        onBranch={onBranch}
                      />
                    )}
                  </div>
                  <div className="msg-body">
                    {entry.role === 'assistant' ? (
                      <>
                        <Markdown text={entry.content} />
                        {entry.isStreaming && !entry.content && (
                          <span className="thinking">
                            <span className="spinner" /> Thinking…
                          </span>
                        )}
                        {entry.isStreaming && entry.content && <span className="caret" />}
                      </>
                    ) : (
                      <>
                        {entry.content && <div className="user-text">{entry.content}</div>}
                        {entry.attachments && entry.attachments.length > 0 && (
                          <div className="attach-row">
                            {entry.attachments.map((a, i) => (
                              <span key={i} className={`attach-chip attach-${a.kind}`}>
                                <span className="attach-icon">
                                  {a.kind === 'image' ? '▣' : a.kind === 'text' ? '≡' : '◼'}
                                </span>
                                {a.name}
                                <span className="muted"> · {formatBytes(a.size)}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            case 'tool-call':
              return <ToolCard key={entry.id} entry={entry} />;
            case 'approval':
              return <ApprovalCard key={entry.id} entry={entry} onResolve={onResolveApproval} />;
            case 'notice':
              return (
                <div
                  key={entry.id}
                  className={`notice notice-${entry.level}`}
                  // Errors are announced assertively: they usually mean the
                  // turn failed and the user must act, so waiting for a pause
                  // would bury the one message that matters.
                  role={entry.level === 'error' ? 'alert' : undefined}
                >
                  {entry.text}
                </div>
              );
            default:
              return null;
          }
        })}
      </div>

      {/* Unpinning must not be a trap: while the reply is still growing there
          is otherwise no signal it is happening, and no quick way back. */}
      {showJump && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          {busy ? 'Jump to latest — still replying' : 'Jump to latest'}
          <span aria-hidden="true"> ↓</span>
        </button>
      )}

      <div className="composer">
        {/*
          One menu, whichever kind is open.

          Rendered from `menu` rather than from each source list, so the
          highlight, the keyboard and the click all agree on what "the
          current item" is. Two near-identical blocks is how they stop
          agreeing.
        */}
        {menu.items.length > 0 && (
          <div className="skill-hints" role="listbox" aria-label="Completions">
            {menu.items.map((item, i) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={`skill-hint ${i === highlight ? 'highlighted' : ''}`}
                // The pointer moves the highlight too, so clicking and
                // arrowing never disagree about which row is current.
                onMouseEnter={() => setHighlight(i)}
                onClick={() => menu.accept(item)}
              >
                <strong>{item.token}</strong>
                {item.detail && <span className="muted"> — {item.detail}</span>}
              </button>
            ))}
          </div>
        )}
        {pending.length > 0 && (
          <div className="attach-row attach-pending">
            {pending.map((p) => (
              <span key={p} className="attach-chip" title={p}>
                {baseName(p)}
                <button
                  type="button"
                  className="attach-remove"
                  onClick={() => setPending((prev) => prev.filter((x) => x !== p))}
                  aria-label={`Remove ${baseName(p)}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button
            type="button"
            className="btn btn-attach"
            onClick={attach}
            title="Attach files"
            aria-label="Attach files"
            disabled={busy}
          >
            {/*
              A paperclip instead of "+", which said nothing about what it
              would add. This is the one control here with no visible label,
              so it carries an aria-label and a tooltip.
            */}
            <IconAttach />
          </button>
          <textarea
            ref={textareaRef}
            className="composer-input"
            rows={1}
            value={draft}
            placeholder={
              !hasProvider
                ? 'Configure a provider in Settings to start chatting…'
                : busy
                  ? 'Agent is working — Esc to stop'
                  : `Message ${subject.name}…`
            }
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              autosize(e.target);
            }}
            /*
             * Also track the caret when it moves without the text changing —
             * clicking elsewhere or arrowing back into an earlier word.
             * Without this the menu keeps completing against wherever the
             * caret used to be.
             */
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            spellCheck
          />
          {busy ? (
            <button type="button" className="btn btn-stop" onClick={onInterrupt} title="Stop (Esc)">
              <IconStop />
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-send"
              onClick={submit}
              // With no provider the button stays live and routes to
              // Settings — a greyed-out control with no explanation is a
              // worse dead end than one that tells you what to do.
              disabled={hasProvider && !draft.trim() && pending.length === 0}
            >
              {/*
                No paper-plane on "Set up": it would promise a message is
                about to be sent, and that button opens Settings instead.
              */}
              {hasProvider && <IconSend />}
              {hasProvider ? 'Send' : 'Set up'}
            </button>
          )}
        </div>
        <div className="composer-hint muted">
          Enter to send · Shift+Enter for a new line · drop files to attach
          {skills.length > 0 ? ' · / for skills' : ''}
        </div>
      </div>
    </div>
  );
}
