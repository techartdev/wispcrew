/**
 * Sidebar.tsx — the agent roster.
 *
 * Agents are durable teammates, not disposable chats, so the list is the
 * app's primary navigation: pinned agents first, then most-recently-updated.
 */
import { useMemo, useState } from 'react';
import { IconClock, IconSkill, IconPlug, IconMachine, IconSettings } from './Icons.js';
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
          <WispMark size={18} />
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
        <button type="button" className="foot-btn" onClick={onOpenSettings}>
          <IconSettings />
          Settings
        </button>
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
