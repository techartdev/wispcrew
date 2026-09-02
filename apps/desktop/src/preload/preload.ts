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
import type { BridgeEvent, WispBridge } from '@wispcrew/shared';

const bridge: WispBridge = {
  onEvent(listener: (event: BridgeEvent) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, event: BridgeEvent) => listener(event);
    ipcRenderer.on('wc:event', handler);
    return () => {
      ipcRenderer.removeListener('wc:event', handler);
    };
  },

  /* agents */
  listAgents: () => ipcRenderer.invoke('wc:listAgents'),
  createAgent: (patch) => ipcRenderer.invoke('wc:createAgent', patch),
  updateAgent: (id, patch) => ipcRenderer.invoke('wc:updateAgent', id, patch),
  deleteAgent: (id) => ipcRenderer.invoke('wc:deleteAgent', id),
  duplicateAgent: (id) => ipcRenderer.invoke('wc:duplicateAgent', id),

  /* conversation */
  getTranscript: (agentId, limit) => ipcRenderer.invoke('wc:getTranscript', agentId, limit),
  sendPrompt: (agentId, prompt, attachmentPaths) =>
    ipcRenderer.invoke('wc:sendPrompt', agentId, prompt, attachmentPaths),
  pickFiles: () => ipcRenderer.invoke('wc:pickFiles'),
  interrupt: (agentId) => ipcRenderer.invoke('wc:interrupt', agentId),
  clearConversation: (agentId) => ipcRenderer.invoke('wc:clearConversation', agentId),
  rewindConversation: (agentId, entryId, mode) =>
    ipcRenderer.invoke('wc:rewindConversation', agentId, entryId, mode),
  branchConversation: (agentId, entryId) =>
    ipcRenderer.invoke('wc:branchConversation', agentId, entryId),
  resolveApproval: (requestId, resolution) =>
    ipcRenderer.invoke('wc:resolveApproval', requestId, resolution),

  /* subscription sign-in */
  listOAuthStatus: () => ipcRenderer.invoke('wc:listOAuthStatus'),
  oauthSignIn: (vendor) => ipcRenderer.invoke('wc:oauthSignIn', vendor),
  oauthSignOut: (vendor) => ipcRenderer.invoke('wc:oauthSignOut', vendor),
  oauthImportFromCli: (vendor) => ipcRenderer.invoke('wc:oauthImportFromCli', vendor),
  listDetectedCliSignIns: () => ipcRenderer.invoke('wc:listDetectedCliSignIns'),

  /* standing tool permissions */
  listToolGrants: () => ipcRenderer.invoke('wc:listToolGrants'),
  revokeToolGrant: (agentId, toolName) =>
    ipcRenderer.invoke('wc:revokeToolGrant', agentId, toolName),
  revokeAllToolGrants: () => ipcRenderer.invoke('wc:revokeAllToolGrants'),

  /* settings & providers */
  getSettings: () => ipcRenderer.invoke('wc:getSettings'),
  saveSettings: (patch) => ipcRenderer.invoke('wc:saveSettings', patch),
  getPresets: () => ipcRenderer.invoke('wc:getPresets'),
  getPersonas: () => ipcRenderer.invoke('wc:getPersonas'),
  testConnection: (cfg) => ipcRenderer.invoke('wc:testConnection', cfg),

  /* MCP */
  listMcpServers: () => ipcRenderer.invoke('wc:listMcpServers'),
  addMcpServer: (server) => ipcRenderer.invoke('wc:addMcpServer', server),
  updateMcpServer: (name, patch) => ipcRenderer.invoke('wc:updateMcpServer', name, patch),
  removeMcpServer: (name) => ipcRenderer.invoke('wc:removeMcpServer', name),
  setMcpToolEnabled: (tool, enabled) => ipcRenderer.invoke('wc:setMcpToolEnabled', tool, enabled),

  /* routines */
  listRoutines: (agentId) => ipcRenderer.invoke('wc:listRoutines', agentId),
  createRoutine: (patch) => ipcRenderer.invoke('wc:createRoutine', patch),
  updateRoutine: (id, patch) => ipcRenderer.invoke('wc:updateRoutine', id, patch),
  deleteRoutine: (id) => ipcRenderer.invoke('wc:deleteRoutine', id),
  runRoutineNow: (id) => ipcRenderer.invoke('wc:runRoutineNow', id),

  /* skills */
  listSkills: () => ipcRenderer.invoke('wc:listSkills'),
  createSkill: (patch) => ipcRenderer.invoke('wc:createSkill', patch),
  updateSkill: (id, patch) => ipcRenderer.invoke('wc:updateSkill', id, patch),
  deleteSkill: (id) => ipcRenderer.invoke('wc:deleteSkill', id),

  /* misc */
  pickDirectory: () => ipcRenderer.invoke('wc:pickDirectory'),
  openPath: (target) => ipcRenderer.invoke('wc:openPath', target),
  getAppInfo: () => ipcRenderer.invoke('wc:getAppInfo'),

  // Paired machines. Each is named explicitly, like every other method here —
  // a generic passthrough would hand the whole IPC surface to the page.
  listNodes: () => ipcRenderer.invoke('wc:listNodes'),
  pairNode: (address: string, code: string, expectFingerprint?: string) =>
    ipcRenderer.invoke('wc:pairNode', address, code, expectFingerprint),
  forgetNode: (nodeId: string) => ipcRenderer.invoke('wc:forgetNode', nodeId),

  // Recovering an earlier version of a conversation.
  listProviderModels: (presetId: string, options?: unknown) =>
    ipcRenderer.invoke('wc:listProviderModels', presetId, options),

  presetsForNode: (nodeId: string) => ipcRenderer.invoke('wc:presetsForNode', nodeId),

  configureNode: (nodeId: string, settings: unknown) =>
    ipcRenderer.invoke('wc:configureNode', nodeId, settings),

  // Rooms: conversations with participants.
  listConversations: () => ipcRenderer.invoke('wc:listConversations'),
  addRoomAgent: (conversationId: string, agentId: string) =>
    ipcRenderer.invoke('wc:addRoomAgent', conversationId, agentId),
  removeRoomParticipant: (conversationId: string, participantId: string) =>
    ipcRenderer.invoke('wc:removeRoomParticipant', conversationId, participantId),
  renameConversation: (conversationId: string, title: string) =>
    ipcRenderer.invoke('wc:renameConversation', conversationId, title),
  setRoomMode: (conversationId: string, mode: string) =>
    ipcRenderer.invoke('wc:setRoomMode', conversationId, mode),
  setRoomGreeting: (conversationId: string, greeting: string) =>
    ipcRenderer.invoke('wc:setRoomGreeting', conversationId, greeting),
  createRoom: (patch: {
    title: string;
    agentIds: string[];
    greeting?: string;
    fromConversationId?: string;
  }) => ipcRenderer.invoke('wc:createRoom', patch),
  deleteRoom: (conversationId: string) => ipcRenderer.invoke('wc:deleteRoom', conversationId),
  sendToRoom: (conversationId: string, text: string, attachmentPaths?: string[]) =>
    ipcRenderer.invoke('wc:sendToRoom', conversationId, text, attachmentPaths),

  // Notification channel setup.
  testTelegram: () => ipcRenderer.invoke('wc:testTelegram'),
  discoverChatId: () => ipcRenderer.invoke('wc:discoverChatId'),

  listHistory: (agentId: string) => ipcRenderer.invoke('wc:listHistory', agentId),
  restoreHistory: (agentId: string, file: string) =>
    ipcRenderer.invoke('wc:restoreHistory', agentId, file),
};

contextBridge.exposeInMainWorld('wispcrew', bridge);
