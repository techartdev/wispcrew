/**
 * Sidebar.tsx — the conversation list.
 *
 * The app's primary navigation. It listed AGENTS until the room restructure,
 * with a shared room shown as decoration on whichever agent it happened to be
 * rooted at — which worked only because a room's id was an agent's id, and
 * left a room belonging to nobody with no row at all.
 *
 * Now every row is a conversation: a private chat with one agent, or a group.
 * Pinned first, then most recently updated.
 *
 * The colour-and-initials helpers that used to live here went with that
 * change. Avatars are drawn creatures seeded by agent id — see `Avatar.tsx` —
 * because "Local Test" and "Local Infrastructure Eye" produced the same grey
 * pill with the same two letters, indistinguishable in a list that is scanned
 * far more often than it is read.
 */
import { useMemo, useState } from 'react';
import { IconPlus, IconClock, IconSkill, IconPlug, IconMachine, IconSettings } from './Icons.js';
import { Avatar, AvatarStack } from './Avatar.js';
import { isGroup } from '@wispcrew/shared';
import type { AgentRecord, AgentRunState, ConversationRecord } from '@wispcrew/shared';

/**
 * One row: a conversation, resolved to the things a row needs.
 *
 * Built once per render rather than reached for in the markup, so the
 * difference between a private chat and a group is decided in one place
 * instead of five times in JSX.
 */
interface Row {
  /** The CONVERSATION id — what selecting one means. */
  id: string;
  title: string;
  subtitle: string | null;
  /** Member agent ids, for the avatar. */
  seeds: string[];
  group: boolean;
  pinned: boolean;
  updatedAt: number;
  /** The worst state among the members: any of them working occupies the row. */
  state: AgentRunState;
}

interface SidebarProps {
  /**
   * Every conversation — this list IS the navigation.
   *
   * It used to be the agent roster, with a room shown as decoration on
   * whichever agent it was rooted at. That worked only because a room's id
   * was an agent's id, and it meant a room belonging to nobody in
   * particular had no row at all: a group created from the plus button
   * would simply not have appeared.
   */
  conversations: ConversationRecord[];
  /** The roster, for names, descriptions and pinning. */
  agents: AgentRecord[];
  /** The selected CONVERSATION. */
  selectedId: string | null;
  runStates: Record<string, AgentRunState>;
  onSelect(id: string): void;
  onCreate(): void;
  onOpenSettings(): void;
  onOpenPanel(panel: 'routines' | 'skills' | 'mcp' | 'nodes'): void;
}

export function Sidebar({
  conversations,
  agents,
  selectedId,
  runStates,
  onSelect,
  onCreate,
  onOpenSettings,
  onOpenPanel,
}: SidebarProps) {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byId = new Map(agents.map((a) => [a.id, a]));

    const rows: Row[] = [];

    for (const conversation of conversations) {
      const members = (conversation.participants ?? [])
        .filter((p) => p.kind === 'agent')
        .map((p) => ({ handle: (p as { handle: string }).handle, agent: byId.get(p.id), id: p.id }));

      const live = members.filter((m) => m.agent && !m.agent.archived);
      const group = isGroup(conversation);

      /*
       * A room whose members have all been deleted.
       *
       * Possible now that a group survives its founder, and the first
       * version simply dropped it — which hid the transcript and left the
       * user no way to delete a room the CLI still listed. Two doors onto
       * one fact, disagreeing.
       *
       * Shown instead, and labelled: a row that says "no agents left" is
       * honest about why nothing answers, and is the way back to its
       * history and its Delete button.
       */
      if (live.length === 0) {
        rows.push({
          id: conversation.id,
          title: conversation.title,
          subtitle: 'no agents left',
          seeds: [conversation.id],
          group,
          pinned: false,
          updatedAt: conversation.updatedAt,
          state: 'idle',
        });
        continue;
      }

      const solo = live[0]!.agent!;

      /*
       * The busiest member wins.
       *
       * Waiting for a decision outranks working, because it is the one that
       * needs the person — a row that says "working" when an approval card
       * is sitting unanswered hides the only actionable state.
       */
      let state: AgentRunState = 'idle';
      for (const m of live) {
        const s = runStates[m.id] ?? 'idle';
        if (s === 'awaiting-approval') state = s;
        else if (s !== 'idle' && state === 'idle') state = s;
      }

      rows.push({
        id: conversation.id,
        title: group ? conversation.title : solo.name,
        /*
         * A group lists everyone; a chat shows the agent's description.
         *
         * Not "with @…" for a group — there is no "self" for the others to
         * be with. The row IS the room, and the handles are what somebody
         * scanning for the right one is actually reading.
         */
        subtitle: group
          ? live.map((m) => `@${m.handle}`).join(', ')
          : (solo.description?.slice(0, 48) ?? null),
        seeds: live.map((m) => m.id),
        group,
        // A group is nobody's, so nobody's pin applies to it.
        pinned: !group && Boolean(solo.pinned),
        /*
         * The CONVERSATION's timestamp for both, so one rule orders the
         * list. Mixing in the agent's would have sorted private chats by
         * when their settings were last edited and groups by when the room
         * was — two different meanings in one column.
         */
        updatedAt: conversation.updatedAt,
        state,
      });
    }

    return rows
      .filter(
        (r) =>
          !q ||
          r.title.toLowerCase().includes(q) ||
          (r.subtitle?.toLowerCase().includes(q) ?? false),
      )
      .sort((a, b) => {
        if (b.pinned !== a.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
  }, [conversations, agents, runStates, query]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <WispMark size={18} />
          <span>WispCrew</span>
        </div>
        {/*
          A typed "+" became a drawn one, and gained the name it never had:
          it had a tooltip, which a pointer reveals and a screen reader does
          not, so this button announced itself as "button, plus".
        */}
        {/*
          Settings lives up here, beside New agent.

          It spent one build alone at the foot of the sidebar as a bare cog,
          which made it the least findable control in the app — dim, small,
          with no label and nothing near it to group with. These two are the
          app-level actions, as opposed to the four panels below that belong
          to whichever agent you are looking at.

          Wrapped, because the header spaces its children apart: a third
          child left the cog stranded in the middle of the row instead of
          beside the button it belongs with.
        */}
        <div className="sidebar-head-actions">
        <button
          type="button"
          className="icon-btn"
          title="Settings"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <IconSettings />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="New agent"
          aria-label="New agent"
          onClick={onCreate}
        >
          <IconPlus />
        </button>
        </div>
      </div>

      {conversations.length > 4 && (
        <input
          className="sidebar-search"
          placeholder="Search conversations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      <nav className="agent-list" aria-label="Conversations">
        {visible.map((row) => {
          /*
           * Any state but idle counts as occupied for the avatar's motion.
           * The exact state is already named by the dot beside it, and a
           * creature that breathes differently for "thinking" and "working"
           * would be inventing a distinction nobody asked to see.
           */
          const active = row.state !== 'idle';
          return (
            <button
              key={row.id}
              type="button"
              className={`agent-row ${row.id === selectedId ? 'selected' : ''}`}
              onClick={() => onSelect(row.id)}
              aria-current={row.id === selectedId ? 'true' : undefined}
              aria-label={
                row.state === 'idle'
                  ? row.title
                  : `${row.title}, ${row.state === 'awaiting-approval' ? 'needs approval' : row.state}`
              }
            >
              {/*
                A creature rather than initials.
                
                "Local Test" and "Local Infrastructure Eye" both rendered a
                grey pill with two letters in the same place — nearly
                indistinguishable in a list that is scanned far more often
                than it is read. A shape and a colour are told apart in
                peripheral vision; two letters are not.
                
                Seeded by the AGENT ID, not the name, so renaming an agent
                does not hand it a new face. A group stacks its members'
                faces, which is what makes it recognisable as a group
                without reading anything.
              */}
              {row.seeds.length > 1 ? (
                <AvatarStack seeds={row.seeds} busy={active} />
              ) : (
                <Avatar seed={row.seeds[0]!} busy={active} />
              )}
              <span className="agent-meta">
                <span className="agent-name">
                  {row.pinned && <span className="pin-dot" title="Pinned" />}
                  {row.title}
                </span>
                {/*
                  Who is in there, rather than a count.
                  
                  "+1" says a group exists but not whether it is the one you
                  want; the handles are what somebody is actually scanning
                  for, and they fit in the space a description would use.
                */}
                {row.subtitle && (
                  <span className={`agent-sub${row.group ? ' agent-room' : ''}`}>
                    {row.subtitle}
                  </span>
                )}
              </span>
              {row.state !== 'idle' && (
                <span
                  className={`state-dot state-${row.state}`}
                  title={row.state === 'awaiting-approval' ? 'Needs approval' : row.state}
                />
              )}
            </button>
          );
        })}
        {visible.length === 0 && (
          <p className="muted sidebar-empty">
            {query ? 'Nothing matches.' : 'No conversations yet.'}
          </p>
        )}
      </nav>

      <div className="sidebar-foot">
        {/*
          Icons sit BESIDE the labels, never instead of them. A glyph is a
          faster second read once you know the app; it is a guess the first
          time, and this row is how someone finds Machines at all.
        */}
        <button type="button" className="foot-btn" onClick={() => onOpenPanel('routines')}>
          <IconClock />
          Routines
        </button>
        <button type="button" className="foot-btn" onClick={() => onOpenPanel('skills')}>
          <IconSkill />
          Skills
        </button>
        <button type="button" className="foot-btn" onClick={() => onOpenPanel('mcp')}>
          <IconPlug />
          Plugins
        </button>
        <button type="button" className="foot-btn" onClick={() => onOpenPanel('nodes')}>
          <IconMachine />
          Machines
        </button>
        {/* Settings moved to the header, beside New agent — see there. This
            leaves four labelled panels in a clean two-by-two. */}
      </div>
    </aside>
  );
}

/** The WispCrew mascot; kept in sync with `build/icon.svg`. */
/**
 * The WispCrew mark: three wisps rising together.
 *
 * A simplified build/icon.svg — no tile, no halo, no bright cores, because
 * at 18px those are invisible and only cost render time. The silhouette is
 * what carries the idea at this size, which is the same reason the app icon
 * uses filled shapes rather than outlines.
 */
export function WispMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" role="img" aria-label="WispCrew">
      <defs>
        <linearGradient id="wc-wisp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7fd8ff" />
          <stop offset="55%" stopColor="#4aa8f0" stopOpacity="0.92" />
          <stop offset="100%" stopColor="#2b6fd0" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="wc-wisp-lead" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#eaf9ff" />
          <stop offset="45%" stopColor="#7fd8ff" stopOpacity="0.96" />
          <stop offset="100%" stopColor="#3d8ae0" stopOpacity="0" />
        </linearGradient>
      </defs>

      <path
        fill="url(#wc-wisp)"
        d="M74 178 C62 158, 58 140, 62 130 A13 13 0 0 1 86 130 C90 140, 86 158, 74 178 Z"
      />
      <path
        fill="url(#wc-wisp-lead)"
        d="M124 200 C102 168, 96 136, 103 122 A22 22 0 0 1 145 122 C152 136, 146 168, 124 200 Z"
      />
      <path
        fill="url(#wc-wisp)"
        d="M180 186 C166 162, 162 142, 167 131 A15 15 0 0 1 193 131 C198 142, 194 162, 180 186 Z"
      />
    </svg>
  );
}
