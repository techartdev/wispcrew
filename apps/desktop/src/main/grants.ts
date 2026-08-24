/**
 * grants.ts — standing "always allow" tool permissions.
 *
 * When a user picks "Always allow" on an approval card, that decision should
 * survive a restart — otherwise the prompt reappears every session and people
 * learn to click it reflexively, which is exactly how approval fatigue
 * defeats the whole mechanism.
 *
 * Persisting a security decision is only defensible if the user can **see and
 * revoke it**, so grants are:
 *
 *  - **Scoped to one agent and one tool.** Allowing `read_file` for a
 *    documentation agent says nothing about `shell` for a coding agent.
 *  - **Listed in Settings**, with the date granted, and revocable
 *    individually or all at once.
 *  - **Dropped when their agent is deleted**, so a recreated id cannot
 *    inherit a permission granted to something else.
 *  - **Never granted for a denied call** — only an explicit "always allow".
 *
 * Deliberately *not* implemented: wildcard or argument-scoped grants. "Allow
 * `shell` whenever the command starts with `git`" sounds useful and is very
 * hard to make safe — argument matching is exactly where sandbox escapes
 * live. A grant is per tool, all-or-nothing, and the user can revoke it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileLog } from './filelog.js';

export interface ToolGrant {
  agentId: string;
  toolName: string;
  /** When the user granted it (epoch ms), shown in the UI. */
  grantedAt: number;
}

const FILE = 'tool-grants.json';

let baseDir = '';
/** `agentId\u0000toolName` → grant. Mirrors the file for O(1) checks. */
let cache: Map<string, ToolGrant> | null = null;

export function initGrants(userDataDir: string): void {
  baseDir = userDataDir;
  cache = null;
}

function grantsPath(): string {
  return path.join(baseDir, FILE);
}

function key(agentId: string, toolName: string): string {
  return `${agentId}\u0000${toolName}`;
}

function load(): Map<string, ToolGrant> {
  if (cache) return cache;
  const map = new Map<string, ToolGrant>();
  try {
    let raw = fs.readFileSync(grantsPath(), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM-tolerant
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const g = item as Partial<ToolGrant>;
        // Ignore malformed rows rather than failing the whole file: this is a
        // user-editable file, and a typo must not silently re-enable prompts
        // for every other grant.
        if (typeof g.agentId === 'string' && typeof g.toolName === 'string') {
          map.set(key(g.agentId, g.toolName), {
            agentId: g.agentId,
            toolName: g.toolName,
            grantedAt: typeof g.grantedAt === 'number' ? g.grantedAt : Date.now(),
          });
        }
      }
    }
  } catch {
    /* absent or unreadable: no grants, which is the safe default */
  }
  cache = map;
  return map;
}

function persist(map: Map<string, ToolGrant>): void {
  const tmp = `${grantsPath()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify([...map.values()], null, 2), 'utf8');
    fs.renameSync(tmp, grantsPath());
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    fileLog('[grants] save failed', (err as Error).message);
  }
}

/** Has the user granted this agent standing permission for this tool? */
export function isGranted(agentId: string, toolName: string): boolean {
  return load().has(key(agentId, toolName));
}

export function grant(agentId: string, toolName: string): void {
  const map = load();
  if (map.has(key(agentId, toolName))) return;
  map.set(key(agentId, toolName), { agentId, toolName, grantedAt: Date.now() });
  persist(map);
  fileLog('[grants] granted', agentId, toolName);
}

export function revoke(agentId: string, toolName: string): void {
  const map = load();
  if (map.delete(key(agentId, toolName))) {
    persist(map);
    fileLog('[grants] revoked', agentId, toolName);
  }
}

/** Drop every grant belonging to an agent (called when it is deleted). */
export function revokeForAgent(agentId: string): void {
  const map = load();
  let changed = false;
  for (const [k, g] of [...map]) {
    if (g.agentId === agentId) {
      map.delete(k);
      changed = true;
    }
  }
  if (changed) persist(map);
}

export function revokeAll(): void {
  const map = load();
  if (map.size === 0) return;
  map.clear();
  persist(map);
  fileLog('[grants] revoked all');
}

/** Every standing grant, newest first — the Settings list. */
export function listGrants(): ToolGrant[] {
  return [...load().values()].sort((a, b) => b.grantedAt - a.grantedAt);
}
