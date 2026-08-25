/**
 * Sidebar.tsx — the agent roster.
 *
 * Agents are durable teammates, not disposable chats, so the list is the
 * app's primary navigation: pinned agents first, then most-recently-updated.
 */
import { useMemo, useState } from 'react';
import type { AgentRecord, AgentRunState } from '@wispcrew/shared';

/** Deterministic accent colour from the agent id, so avatars stay stable. */
function avatarColor(agent: AgentRecord): string {
  if (agent.avatarColor) return agent.avatarColor;
  // FNV-1a — tiny, well-distributed, no dependency.
  let hash = 0x811c9dc5;
  for (let i = 0; i < agent.id.length; i++) {
    hash ^= agent.id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const palette = [
    '#39c2f0',
    '#7c8cf8',
    '#f0793a',
    '#4ec98a',
    '#e05c8a',
    '#c79a3a',
    '#9b6cf0',
    '#3ad0c0',
  ];
  return palette[hash % palette.length]!;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

interface SidebarProps {
  agents: AgentRecord[];
  selectedId: string | null;
  runStates: Record<string, AgentRunState>;
  onSelect(id: string): void;
  onCreate(): void;
  onOpenSettings(): void;
  onOpenPanel(panel: 'routines' | 'skills' | 'mcp' | 'nodes'): void;
}

export function Sidebar({
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
    return agents
      .filter((a) => !a.archived)
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .sort((a, b) => {
        if (Boolean(b.pinned) !== Boolean(a.pinned)) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
  }, [agents, query]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <GhostMark size={18} />
          <span>WispCrew</span>
        </div>
        <button type="button" className="icon-btn" title="New agent" onClick={onCreate}>
          +
        </button>
      </div>

      {agents.length > 4 && (
        <input
          className="sidebar-search"
          placeholder="Search agents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      <nav className="agent-list" aria-label="Agents">
        {visible.map((agent) => {
          const state = runStates[agent.id] ?? 'idle';
          return (
            <button
              key={agent.id}
              type="button"
              className={`agent-row ${agent.id === selectedId ? 'selected' : ''}`}
              onClick={() => onSelect(agent.id)}
              aria-current={agent.id === selectedId ? 'true' : undefined}
              aria-label={
                state === 'idle'
                  ? agent.name
                  : `${agent.name}, ${state === 'awaiting-approval' ? 'needs approval' : state}`
              }
            >
              <span
                className="agent-avatar"
                style={{ background: avatarColor(agent) }}
                aria-hidden="true"
              >
                {initials(agent.name)}
              </span>
              <span className="agent-meta">
                <span className="agent-name">
                  {agent.pinned && <span className="pin-dot" title="Pinned" />}
                  {agent.name}
                </span>
                {agent.description && (
                  <span className="agent-sub">{agent.description.slice(0, 48)}</span>
                )}
              </span>
              {state !== 'idle' && (
                <span
                  className={`state-dot state-${state}`}
                  title={state === 'awaiting-approval' ? 'Needs approval' : state}
                />
              )}
            </button>
          );
        })}
        {visible.length === 0 && <p className="muted sidebar-empty">No agents match.</p>}
      </nav>

      <div className="sidebar-foot">
        <button type="button" className="foot-btn" onClick={() => onOpenPanel('routines')}>
          Routines
        </button>
        <button type="button" className="foot-btn" onClick={() => onOpenPanel('skills')}>
          Skills
        </button>
        <button type="button" className="foot-btn" onClick={() => onOpenPanel('mcp')}>
          Plugins
        </button>
        <button type="button" className="foot-btn" onClick={() => onOpenPanel('nodes')}>
          Machines
        </button>
        <button type="button" className="foot-btn" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </aside>
  );
}

/** The WispCrew mascot; kept in sync with `build/icon.svg`. */
export function GhostMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" role="img" aria-label="WispCrew">
      <defs>
        <linearGradient id="gb-ghost" x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor="#7ae7ff" />
          <stop offset="55%" stopColor="#39c2f0" />
          <stop offset="100%" stopColor="#1b8fd4" />
        </linearGradient>
      </defs>
      <path
        fill="url(#gb-ghost)"
        d="M48 196 L48 122 a80 80 0 0 1 160 0 L208 196
           q-10 14 -20 0 q-10 -14 -20 0 q-10 14 -20 0
           q-10 -14 -20 0 q-10 14 -20 0 q-10 -14 -20 0
           q-10 14 -20 0 Z"
      />
      <ellipse cx="103" cy="120" rx="20" ry="24" fill="#fff" />
      <ellipse cx="157" cy="120" rx="20" ry="24" fill="#fff" />
      <ellipse cx="110" cy="125" rx="9.5" ry="11" fill="#16202c" />
      <ellipse cx="164" cy="125" rx="9.5" ry="11" fill="#16202c" />
    </svg>
  );
}
