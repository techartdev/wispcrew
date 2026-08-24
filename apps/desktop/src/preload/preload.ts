/**
 * preload.ts — the only bridge between the renderer and the main process.
 *
 * The renderer runs with `contextIsolation: true`, `nodeIntegration: false`
 * and `sandbox: true`. It therefore has no Node, no `require`, and no direct
 * `ipcRenderer` — only the object exposed here.
 *
 * Every method is a thin, explicitly-named `invoke`. There is deliberately no
 * generic passthrough (`invoke(channel, ...args)`): that would let any script
 * running in the renderer — including anything injected through a rendered
 * model response — reach every IPC channel in the app. Enumerating the surface
 * is the security boundary.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { BridgeEvent, GhostBridge } from '@ghostbot/shared';

const bridge: GhostBridge = {
  onEvent(listener: (event: BridgeEvent) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, event: BridgeEvent) => listener(event);
    ipcRenderer.on('gb:event', handler);
    return () => {
      ipcRenderer.removeListener('gb:event', handler);
    };
  },

  /* agents */
  listAgents: () => ipcRenderer.invoke('gb:listAgents'),
  createAgent: (patch) => ipcRenderer.invoke('gb:createAgent', patch),
  updateAgent: (id, patch) => ipcRenderer.invoke('gb:updateAgent', id, patch),
  deleteAgent: (id) => ipcRenderer.invoke('gb:deleteAgent', id),
  duplicateAgent: (id) => ipcRenderer.invoke('gb:duplicateAgent', id),

  /* conversation */
  getTranscript: (agentId, limit) => ipcRenderer.invoke('gb:getTranscript', agentId, limit),
  sendPrompt: (agentId, prompt, attachmentPaths) =>
    ipcRenderer.invoke('gb:sendPrompt', agentId, prompt, attachmentPaths),
  pickFiles: () => ipcRenderer.invoke('gb:pickFiles'),
  interrupt: (agentId) => ipcRenderer.invoke('gb:interrupt', agentId),
  clearConversation: (agentId) => ipcRenderer.invoke('gb:clearConversation', agentId),
  rewindConversation: (agentId, entryId, mode) =>
    ipcRenderer.invoke('gb:rewindConversation', agentId, entryId, mode),
  branchConversation: (agentId, entryId) =>
    ipcRenderer.invoke('gb:branchConversation', agentId, entryId),
  resolveApproval: (requestId, resolution) =>
    ipcRenderer.invoke('gb:resolveApproval', requestId, resolution),

  /* standing tool permissions */
  listToolGrants: () => ipcRenderer.invoke('gb:listToolGrants'),
  revokeToolGrant: (agentId, toolName) =>
    ipcRenderer.invoke('gb:revokeToolGrant', agentId, toolName),
  revokeAllToolGrants: () => ipcRenderer.invoke('gb:revokeAllToolGrants'),

  /* settings & providers */
  getSettings: () => ipcRenderer.invoke('gb:getSettings'),
  saveSettings: (patch) => ipcRenderer.invoke('gb:saveSettings', patch),
  getPresets: () => ipcRenderer.invoke('gb:getPresets'),
  getPersonas: () => ipcRenderer.invoke('gb:getPersonas'),
  testConnection: (cfg) => ipcRenderer.invoke('gb:testConnection', cfg),

  /* MCP */
  listMcpServers: () => ipcRenderer.invoke('gb:listMcpServers'),
  addMcpServer: (server) => ipcRenderer.invoke('gb:addMcpServer', server),
  updateMcpServer: (name, patch) => ipcRenderer.invoke('gb:updateMcpServer', name, patch),
  removeMcpServer: (name) => ipcRenderer.invoke('gb:removeMcpServer', name),
  setMcpToolEnabled: (tool, enabled) => ipcRenderer.invoke('gb:setMcpToolEnabled', tool, enabled),

  /* routines */
  listRoutines: (agentId) => ipcRenderer.invoke('gb:listRoutines', agentId),
  createRoutine: (patch) => ipcRenderer.invoke('gb:createRoutine', patch),
  updateRoutine: (id, patch) => ipcRenderer.invoke('gb:updateRoutine', id, patch),
  deleteRoutine: (id) => ipcRenderer.invoke('gb:deleteRoutine', id),
  runRoutineNow: (id) => ipcRenderer.invoke('gb:runRoutineNow', id),

  /* skills */
  listSkills: () => ipcRenderer.invoke('gb:listSkills'),
  createSkill: (patch) => ipcRenderer.invoke('gb:createSkill', patch),
  updateSkill: (id, patch) => ipcRenderer.invoke('gb:updateSkill', id, patch),
  deleteSkill: (id) => ipcRenderer.invoke('gb:deleteSkill', id),

  /* misc */
  pickDirectory: () => ipcRenderer.invoke('gb:pickDirectory'),
  openPath: (target) => ipcRenderer.invoke('gb:openPath', target),
  getAppInfo: () => ipcRenderer.invoke('gb:getAppInfo'),
};

contextBridge.exposeInMainWorld('ghostbot', bridge);
