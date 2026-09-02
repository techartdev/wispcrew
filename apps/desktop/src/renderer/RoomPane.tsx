/**
 * RoomPane.tsx — who is in this room, and what is scheduled for it.
 *
 * A conversation with several agents needs somewhere to see them at a
 * glance: who is present, who is working, who is waiting on you. In a chat
 * transcript that information is scattered through the scrollback, or absent
 * entirely when an agent is thinking and has written nothing yet.
 *
 * Deliberately assembled from what already exists. The engine emits
 * `run-state` per agent and the renderer already keeps a map of it; routines
 * are already listed. Nothing here invents a status the engine cannot
 * supply — see the note on `describeState` below.
 */
import { useMemo, useState, useEffect } from 'react';
import { ContextMeter } from './ContextMeter';
import { IconSettings } from './Icons.js';
import { isGroup } from '@wispcrew/shared';
import type {
  AgentRecord,
  AgentRunState,
  ContextReportView,
  ConversationRecord,
  RoutineRecord,
} from '@wispcrew/shared';

/**
 * A status a person can act on.
 *
 * The engine has four states and no more, so these are the four. "Typing"
 * and "raising a hand" would be better words for what a room feels like,
 * and both would be lies: nothing emits them. An interface that shows a
 * status the system cannot know is worse than one that shows less.
 */
function describeState(state: AgentRunState | undefined): { label: string; tone: string } {
  switch (state) {
    case 'thinking':
      return { label: 'working', tone: 'busy' };
    case 'awaiting-approval':
      return { label: 'waiting for you', tone: 'blocked' };
    case 'error':
      return { label: 'something failed', tone: 'failed' };
    default:
      return { label: 'listening', tone: 'idle' };
  }
}

/**
 * A cron expression, in words.
 *
 * `0 9 * * 1-5` tells a person almost nothing at a glance. The common shapes
 * are worth spelling out; anything unusual falls back to the expression
 * itself rather than a wrong guess.
 */
export function describeSchedule(cron: string | undefined, runAt?: number): string {
  if (runAt) return `once, at ${new Date(runAt).toLocaleString()}`;
  if (!cron) return 'not scheduled';

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  // Indexed rather than destructured: the length check above proves all five
  // are present, but the type system reads an index as possibly undefined.
  const minute = parts[0]!;
  const hour = parts[1]!;
  const dom = parts[2]!;
  const month = parts[3]!;
  const dow = parts[4]!;
  const everyDay = dom === '*' && month === '*' && dow === '*';
  const weekdays = dom === '*' && month === '*' && (dow === '1-5' || dow === 'MON-FRI');

  const at = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;

  if (/^\*\/(\d+)$/.test(minute) && hour === '*' && everyDay) {
    const every = minute.slice(2);
    return `every ${every} minutes`;
  }
  if (/^\d+$/.test(minute) && hour === '*' && everyDay) return 'hourly';
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    if (everyDay) return `daily at ${at(hour, minute)}`;
    if (weekdays) return `weekdays at ${at(hour, minute)}`;
  }

  // Not a shape worth guessing at — show what was actually written.
  return cron;
}

export function RoomPane({
  room,
  agents,
  routines,
  runStates,
  contextReports,
  onCompact,
  onMention,
  onOpenRoutines,
  onRename,
  onSetGreeting,
  onConfigure,
  onClose,
}: {
  room: ConversationRecord;
  agents: AgentRecord[];
  routines: RoutineRecord[];
  runStates: Record<string, AgentRunState>;

  /**
   * How full each member's context is — one report per agent.
   *
   * Rendered here rather than beside the composer because in a room the
   * answer differs per member: same history, different models, different
   * windows.
   */
  contextReports: ContextReportView[];

  /** Compact one member's view of this conversation. */
  onCompact: (agentId: string) => void;
  onMention(handle: string): void;
  onOpenRoutines(): void;
  onRename(title: string): void;
  /** Save the room's standing instructions. Empty clears them. */
  onSetGreeting(text: string): void;
  /** Open a particular member's own settings. */
  onConfigure(agentId: string): void;
  onClose(): void;
}) {
  /*
   * The name being edited, kept locally so typing is not fighting a round
   * trip. Reset whenever a different room is shown, or the field would
   * carry the previous room's half-typed name into this one.
   */
  const [draftTitle, setDraftTitle] = useState(room.title ?? '');
  useEffect(() => setDraftTitle(room.title ?? ''), [room.id, room.title]);

  const commitTitle = () => {
    const next = draftTitle.trim();
    // Nothing to do, and an empty name is not a name: fall back rather than
    // save a room called "".
    if (!next) return setDraftTitle(room.title ?? '');
    if (next !== room.title) onRename(next);
  };

  /*
   * The greeting, edited locally and saved on blur.
   *
   * Same reasoning as the title: typing must not fight a round trip, and a
   * half-written instruction must not follow the user into the next room.
   */
  const [draftGreeting, setDraftGreeting] = useState(room.greeting ?? '');
  useEffect(() => setDraftGreeting(room.greeting ?? ''), [room.id, room.greeting]);

  const commitGreeting = () => {
    const next = draftGreeting.trim();
    // An empty box means "no instructions", which is a real answer here —
    // unlike an empty name, there is nothing to fall back to.
    if (next !== (room.greeting ?? '')) onSetGreeting(next);
  };

  const members = useMemo(
    () => (room.participants ?? []).filter((p) => p.kind === 'agent'),
    [room],
  );

  /*
   * A single agent is not a reason to hide this.
   *
   * The first plan showed the pane only for rooms with several agents, on
   * the reasoning that one agent has nothing to list but itself. That was
   * wrong for the same reason hiding the members strip was: a routine
   * belongs to ONE agent, and the user's own profile has exactly that — a
   * scheduled prompt on a room with a single member. Hiding the pane there
   * hides the only thing worth showing.
   */

  /*
   * Routines belonging to anyone in this room.
   *
   * Scoped to the room rather than the whole profile: a pane about this
   * conversation should not list work scheduled for an agent the user is not
   * looking at.
   */
  const roomRoutines = useMemo(() => {
    const ids = new Set(members.map((m) => m.id));
    return routines.filter((r) => ids.has(r.agentId));
  }, [routines, members]);

  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  return (
    <aside className="room-pane" aria-label="About this conversation">
      <div className="room-pane-head">
        <h2>In this room</h2>
        <button
          type="button"
          className="room-pane-close"
          onClick={onClose}
          aria-label="Hide this panel"
          title="Hide"
        >
          ›
        </button>
      </div>

      {/*
        A room with company can be named.
        
        A conversation with several agents is a place, and a place described
        only by whichever agent is listed first reads as that agent: "Nudge"
        for a room that is really the deploy review, identical in the
        sidebar to the row for Nudge alone.
        
        Offered only for a shared room. Renaming a one-to-one chat would be
        renaming the agent by another route, and two ways to change one name
        is how they end up disagreeing.
      */}
      {members.length > 1 && (
        <input
          className="room-title-input"
          value={draftTitle}
          placeholder="Name this room…"
          aria-label="Room name"
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // Abandon the edit rather than commit half a name.
              setDraftTitle(room.title ?? '');
              e.currentTarget.blur();
            }
          }}
        />
      )}

      {/*
        The room's standing instructions.
        
        The one piece of content a room owns: its tone, its purpose, and why
        these particular agents are here. It travels with the conversation,
        so an agent added halfway through knows what kind of place it walked
        into without reading the whole scrollback.
        
        Shown in plain sight, editable in place, with a line saying who can
        read it — because everyone can. A hidden system instruction would
        mean the user reads a reply shaped by a rule they cannot find, and
        an agent asked "what were you told?" would have to deflect. A rule
        nobody can see is a rule nobody can correct.
        
        Offered for a group only. A one-to-one chat already has a place for
        standing instructions — the agent's own description — and a second
        one would just be two ways to say the same thing.
      */}
      {isGroup(room) && (
        <div className="room-greeting">
          <label className="room-greeting-label" htmlFor="room-greeting-input">
            Room instructions
          </label>
          <textarea
            id="room-greeting-input"
            className="room-greeting-input"
            value={draftGreeting}
            rows={3}
            placeholder="What is this room for, and in what tone? Everyone here will read it."
            onChange={(e) => setDraftGreeting(e.target.value)}
            onBlur={commitGreeting}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraftGreeting(room.greeting ?? '');
                e.currentTarget.blur();
              }
            }}
          />
          <p className="room-greeting-note">
            Visible to everyone here, including the agents. They are told to follow it
            and to say what it is if you ask.
          </p>
        </div>
      )}

      <ul className="room-pane-members">
        {members.map((member) => {
          const handle = (member as { handle: string }).handle;
          const status = describeState(runStates[member.id]);
          const context = contextReports.find((r) => r.agentId === member.id);

          return (
            <li key={member.id} className="room-pane-member-item">
              <div className="room-pane-member-row">
              {/*
                Clicking a member writes their handle into the composer.
                Addressing is how a room works, and hunting for the exact
                spelling of a handle is the small friction that stops people
                using it.
              */}
              <button
                type="button"
                className="room-pane-member"
                onClick={() => onMention(handle)}
                title={`Mention @${handle}`}
              >
                <span className={`room-pane-dot ${status.tone}`} aria-hidden="true" />
                <span className="room-pane-name">{nameOf(member.id)}</span>
                <span className="room-pane-status">{status.label}</span>
              </button>

              {/*
                Configure THIS member, from here.
                
                A room is rooted at one agent, so the Configure button in
                the header always opened that agent's settings — and the
                only way to reach a room-mate's was to leave the room, find
                its own conversation in the sidebar, configure it there, and
                come back. For the commonest reason anyone opens this panel
                — "why is that one not answering" — that is a long walk to
                a checkbox.
              */}
              <button
                type="button"
                className="icon-btn room-pane-configure"
                onClick={() => onConfigure(member.id)}
                title={`Configure ${nameOf(member.id)}`}
                aria-label={`Configure ${nameOf(member.id)}`}
              >
                <IconSettings />
              </button>
              </div>

              {/*
                This member's own context, under this member's own name.
                
                A room has one history and a different answer for each agent
                in it, and the difference is not cosmetic: two agents on the
                same project can run different models with different
                windows, so the same forty thousand tokens is a tenth of one
                and a third of the other. A single figure for the room would
                be right for at most one of them.

                On its own line rather than beside the name: this panel is
                two hundred pixels wide, and a third item in that row leaves
                nothing legible.
              */}
              {context && (
                <ContextMeter
                  report={context}
                  onCompact={() => onCompact(member.id)}
                  inline
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className="room-pane-head">
        <h2>Scheduled</h2>
        <button
          type="button"
          className="room-pane-close"
          onClick={onOpenRoutines}
          aria-label="Manage routines"
          title="Manage routines"
        >
          +
        </button>
      </div>

      {roomRoutines.length === 0 ? (
        <p className="room-pane-empty">
          Nothing scheduled. A routine runs a prompt on its own, whether or not
          this window is open.
        </p>
      ) : (
        <ul className="room-pane-routines">
          {roomRoutines.map((routine) => (
            <li key={routine.id}>
              <span className="room-pane-routine-name">{routine.name}</span>
              <span className="room-pane-routine-when">
                {describeSchedule(routine.cron, routine.runAt)}
                {routine.enabled === false ? ' — paused' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
