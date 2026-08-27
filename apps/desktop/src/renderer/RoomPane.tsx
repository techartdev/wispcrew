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
import { useMemo } from 'react';
import type { AgentRecord, AgentRunState, ConversationRecord, RoutineRecord } from '@wispcrew/shared';

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
  onMention,
  onOpenRoutines,
  onClose,
}: {
  room: ConversationRecord;
  agents: AgentRecord[];
  routines: RoutineRecord[];
  runStates: Record<string, AgentRunState>;
  onMention(handle: string): void;
  onOpenRoutines(): void;
  onClose(): void;
}) {
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

      <ul className="room-pane-members">
        {members.map((member) => {
          const handle = (member as { handle: string }).handle;
          const status = describeState(runStates[member.id]);

          return (
            <li key={member.id}>
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
