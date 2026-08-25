/**
 * mcp-manager.ts — lifecycle for configured MCP stdio servers.
 *
 * Servers are declared in settings (`mcpServers`). This module keeps one
 * connected `McpStdioClient` per enabled server, exposes their tools to the
 * agent registry, and reports state to the original UI's MCP surfaces
 * (`getMcpState` / `getEffectivePlugins` / `listMcpServerTools`).
 *
 * Connections are lazy and cached: the first prompt that needs tools spawns
 * the servers, and later prompts reuse them. A server that fails to start is
 * recorded with its error instead of breaking the whole run.
 */
import { McpStdioClient, mcpToolsToTools, type McpServerConfig } from '@ghostbot/mcp';
import type { Tool } from '@ghostbot/shared';
import type { AppSettings, McpServerSettings } from './types.js';
import { fileLog } from './filelog.js';

export type McpServerState = 'connected' | 'error' | 'disabled';

export interface McpServerStatus {
  name: string;
  label: string;
  state: McpServerState;
  toolNames: string[];
  error?: string;
}

interface Entry {
  client: McpStdioClient | null;
  status: McpServerStatus;
  /** Identity of the config that produced this entry; change ⇒ reconnect. */
  fingerprint: string;
}

const entries = new Map<string, Entry>();

function fingerprintOf(s: McpServerSettings): string {
  return JSON.stringify([s.command, s.args ?? [], s.cwd ?? '', s.env ?? {}, Boolean(s.disabled)]);
}

function toClientConfig(s: McpServerSettings): McpServerConfig {
  return {
    name: s.name,
    label: s.label ?? s.name,
    command: s.command,
    args: s.args ?? [],
    env: s.env,
    cwd: s.cwd,
  };
}

/**
 * Ensure every enabled server in `settings` is connected, disposing clients
 * whose config changed or that were removed. Returns the current status list.
 */
export async function syncMcpServers(settings: AppSettings): Promise<McpServerStatus[]> {
  const configured = settings.mcpServers ?? [];
  const wanted = new Set(configured.map((s) => s.name));

  // Drop servers that disappeared from settings.
  for (const [name, entry] of [...entries]) {
    if (!wanted.has(name)) {
      await entry.client?.close().catch(() => {});
      entries.delete(name);
    }
  }

  for (const s of configured) {
    if (!s.name || !s.command) continue;
    const fingerprint = fingerprintOf(s);
    const existing = entries.get(s.name);

    if (existing && existing.fingerprint === fingerprint) continue;

    // Config changed (or first sight): tear down any previous client.
    if (existing?.client) await existing.client.close().catch(() => {});

    if (s.disabled) {
      entries.set(s.name, {
        client: null,
        fingerprint,
        status: { name: s.name, label: s.label ?? s.name, state: 'disabled', toolNames: [] },
      });
      continue;
    }

    const client = new McpStdioClient(toClientConfig(s));
    try {
      await client.connect();
      const toolNames = client.toolsList().map((t) => t.name);
      entries.set(s.name, {
        client,
        fingerprint,
        status: { name: s.name, label: s.label ?? s.name, state: 'connected', toolNames },
      });
      fileLog('[mcp] connected', s.name, `${toolNames.length} tools`);
    } catch (err) {
      const message = (err as Error).message;
      await client.close().catch(() => {});
      entries.set(s.name, {
        client: null,
        fingerprint,
        status: { name: s.name, label: s.label ?? s.name, state: 'error', toolNames: [], error: message },
      });
      fileLog('[mcp] connect failed', s.name, message);
    }
  }

  return statuses();
}

/** Current status of every known server (no connection attempted). */
export function statuses(): McpServerStatus[] {
  return [...entries.values()].map((e) => ({ ...e.status }));
}

/**
 * Connect (if needed) and return the GhostBot tools contributed by all
 * enabled MCP servers, prefixed as `<server>__<tool>`.
 */
export async function buildMcpTools(settings: AppSettings): Promise<Tool[]> {
  if (!(settings.mcpServers ?? []).length) return [];
  await syncMcpServers(settings);

  const disabledTools = new Set(settings.mcpDisabledTools ?? []);
  const out: Tool[] = [];
  for (const entry of entries.values()) {
    if (!entry.client) continue;
    for (const tool of mcpToolsToTools(entry.client)) {
      if (disabledTools.has(tool.definition.name)) continue;
      out.push(tool);
    }
  }
  return out;
}

/** Shut every client down (app quit). */
export async function closeAllMcp(): Promise<void> {
  for (const entry of entries.values()) {
    await entry.client?.close().catch(() => {});
  }
  entries.clear();
}
