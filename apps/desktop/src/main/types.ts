/** Shared settings type for the desktop main process. */

/** A configured MCP stdio server. */
export interface McpServerSettings {
  /** Stable id, also used as the tool-name prefix (`<name>__<tool>`). */
  name: string;
  /** Optional display label for the UI. */
  label?: string;
  /** Executable to spawn. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** When true the server is kept in settings but not connected. */
  disabled?: boolean;
}

export interface AppSettings {
  presetId?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  workspaceRoot?: string;
  /** Agent persona id (see packages/core PERSONAS). */
  persona?: string;
  /** MCP stdio servers whose tools are offered to the agent. */
  mcpServers?: McpServerSettings[];
  /** Prefixed tool names (`<server>__<tool>`) the user switched off. */
  mcpDisabledTools?: string[];
}
