/**
 * shot-panels.cjs — render the modal panels to HTML, offline.
 *
 * The `*-ui` suites check that every class a panel renders is styled. They
 * cannot tell whether the result LOOKS like anything, and four defects this
 * session passed every static check while being visibly wrong.
 *
 * This renders the panels with react-dom/server against the real stylesheet
 * and writes one HTML file per panel, so they can be opened and looked at
 * without clicking through the app to reach a modal that only appears after
 * three steps.
 *
 * Not part of `verify`: it produces something to look at, not a pass or fail.
 */
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
const out = path.join(repo, '.shots');
fs.mkdirSync(out, { recursive: true });

const entry = path.join(out, 'entry.jsx');

fs.writeFileSync(
  entry,
  `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomPane } from '${path.join(repo, "apps/desktop/src/renderer/RoomPane.tsx").replace(/\\/g, "/")}';
import { NewChoicePanel, NewGroupPanel, RoomPanel, NewAgentPanel, AgentPanel, SettingsPanel } from '${path
    .join(repo, 'apps/desktop/src/renderer/Panels.tsx')
    .replace(/\\/g, '/')}';

const agents = [
  { id: 'a1', name: 'Assistant', updatedAt: 1, createdAt: 1 },
  { id: 'a2', name: 'Reviewer', updatedAt: 1, createdAt: 1 },
  { id: 'a3', name: 'Linux box', nodeId: 'node_1', updatedAt: 1, createdAt: 1 },
];

const room = {
  id: 'r1',
  title: 'OpenClaw AddOn Dev & OpenClaw Dev Version',
  kind: 'group',
  greeting: 'Repository workflow - @openclaw-addon-dev manages the main techartdev/OpenClawHomeAssistant repository: watches issues, pull requests, releases and CI.',
  mode: 'open',
  createdAt: 1,
  updatedAt: 1,
  participants: [
    { kind: 'human', id: 'human:local', name: 'You', channels: ['app'] },
    { kind: 'agent', id: 'a1', handle: 'openclaw-addon-prod-version' },
    { kind: 'agent', id: 'a2', handle: 'openclaw-addon-dev-version' },
  ],
};

const roomReports = [
  { conversationId: 'r1', agentId: 'a1', agentName: 'OpenClaw AddOn Prod Version',
    used: 45468, measured: false, limit: 400000, fraction: 0.1136,
    systemTokens: 1016, toolTokens: 2010, messageTokens: 42442, model: 'gpt-5.6-terra' },
  { conversationId: 'r1', agentId: 'a2', agentName: 'OpenClaw AddOn Dev Version',
    used: 45431, measured: false, limit: 400000, fraction: 0.1135,
    systemTokens: 979, toolTokens: 2010, messageTokens: 42442, model: 'gpt-5.6-terra' },
];

const noop = () => {};

const presets = [
  { id: 'openai', label: 'OpenAI', configured: true, defaultModel: 'gpt-5.6-luna',
    models: ['gpt-5.6-luna', 'gpt-5.6-terra'], keyHint: '', kind: 'openai-compatible', baseUrl: '' },
  { id: 'nvidia', label: 'NVIDIA NIM', configured: true,
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
    models: ['nvidia/nemotron-3-super-120b-a12b'], keyHint: '', kind: 'openai-compatible', baseUrl: '' },
  { id: 'anthropic', label: 'Anthropic (Claude)', configured: false, defaultModel: 'claude-opus-5',
    models: ['claude-opus-5'], keyHint: '', kind: 'anthropic', baseUrl: '' },
];

// A pairing that cannot work, so the refusal is visible rather than assumed.
const crossed = {
  id: 'a1', name: 'Crossed wires', presetId: 'nvidia', model: 'gpt-5.6-terra',
  createdAt: 1, updatedAt: 1,
};

/*
 * And a coherent one on a model that DOES have a reasoning knob, because
 * the interesting thing about that control is where it appears and where it
 * does not. The mismatched agent above is on NVIDIA, which has none, so
 * without this the only rendered Configure panel would be one that proves
 * nothing about it.
 *
 * (No backticks in this comment: it lives inside a template literal, and a
 * stray one ends the string with a syntax error two files away.)
 */
const thinker = {
  id: 'a2', name: 'Careful', presetId: 'openai', model: 'gpt-5.6-terra',
  reasoningEffort: 'high', createdAt: 1, updatedAt: 1,
};

globalThis.__PANELS__ = {
  'new-agent': renderToStaticMarkup(
    React.createElement(NewAgentPanel, {
      presets, defaultPresetId: 'nvidia', onCreate: noop, onOpenSettings: noop, onClose: noop,
    }),
  ),
  'agent-mismatch': renderToStaticMarkup(
    React.createElement(AgentPanel, {
      agent: crossed, presets, personas: [{ id: 'general', label: 'General', description: '' }],
      nodes: [], globalPolicy: 'ask',
      onSave: noop, onDelete: noop, onDuplicate: noop,
      onPickDirectory: async () => null, onClose: noop,
    }),
  ),
  'agent-reasoning': renderToStaticMarkup(
    React.createElement(AgentPanel, {
      agent: thinker, presets, personas: [{ id: 'general', label: 'General', description: '' }],
      nodes: [], globalPolicy: 'ask',
      onSave: noop, onDelete: noop, onDuplicate: noop,
      onPickDirectory: async () => null, onClose: noop,
    }),
  ),
  'room-pane': renderToStaticMarkup(
    React.createElement('div', { style: { display: 'flex', height: '760px' } },
      React.createElement(RoomPane, {
        room, agents, routines: [], runStates: { a1: 'idle', a2: 'idle' },
        contextReports: roomReports,
        onCompact: noop, onMention: noop, onOpenRoutines: noop,
        onRename: noop, onSetGreeting: noop, onConfigure: noop, onClose: noop,
        onEndpoints: async () => [{ channel: 'telegram', label: 'OpenClaw AddOn Dev' }],
      }),
    ),
  ),
  /*
   * The Telegram setup, in both states.
   *
   * The whole complaint was about ORDER: every control was offered at once
   * and the sequence explained in prose, so pressing the wrong one first
   * produced an error that looked like a bug. Both states are rendered
   * because the interesting thing is the difference between them.
   */
  'telegram-empty': renderToStaticMarkup(
    React.createElement(SettingsPanel, {
      settings: { presetId: 'openai', channels: { enabled: ['app'], telegram: { configured: false, chatId: '' } } },
      presets, personas: [{ id: 'general', label: 'General', description: '' }],
      grants: [], oauthStatuses: [], detectedSignIns: [],
      onRevokeGrant: noop, onRevokeAllGrants: noop,
      onOAuthSignIn: noop, onOAuthImport: noop, onOAuthSignOut: noop,
      onSave: noop, onTest: noop, onPickDirectory: async () => null,
      onTestTelegram: async () => ({ ok: true }), onDiscoverChatId: async () => ({}),
      onClose: noop, initialTab: 'channels',
    }),
  ),
  'telegram-ready': renderToStaticMarkup(
    React.createElement(SettingsPanel, {
      settings: { presetId: 'openai', channels: { enabled: ['app'], telegram: { configured: true, chatId: '' } } },
      presets, personas: [{ id: 'general', label: 'General', description: '' }],
      grants: [], oauthStatuses: [], detectedSignIns: [],
      onRevokeGrant: noop, onRevokeAllGrants: noop,
      onOAuthSignIn: noop, onOAuthImport: noop, onOAuthSignOut: noop,
      onSave: noop, onTest: noop, onPickDirectory: async () => null,
      onTestTelegram: async () => ({ ok: true }), onDiscoverChatId: async () => ({}),
      onClose: noop, initialTab: 'channels',
    }),
  ),
  'new-choice': renderToStaticMarkup(
    React.createElement(NewChoicePanel, {
      canGroup: true, onAgent: noop, onGroup: noop, onClose: noop,
    }),
  ),
  'new-group': renderToStaticMarkup(
    React.createElement(NewGroupPanel, {
      agents, nodes: [{ id: 'node_1', name: 'evtinsait-host1', connected: true }],
      onCreate: noop, onClose: noop,
    }),
  ),
  'room-direct': renderToStaticMarkup(
    React.createElement(RoomPanel, {
      room, agents, routines: [], runStates: {}, contextReports: roomReports,
      onCompact: noop, onMention: noop, onConfigure: noop, onOpenRoutines: noop,
      onRename: noop, onSetGreeting: noop,
      onAdd: noop, onSplit: noop, onRemove: noop, onSetMode: noop, onClose: noop,
    }),
  ),
};
`,
);

const bundle = esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx' },
  external: ['react', 'react-dom', 'react-dom/server'],
  absWorkingDir: repo,
});

// eslint-disable-next-line no-eval
const run = new Function('require', 'globalThis', bundle.outputFiles[0].text);
run(require, globalThis);

const css = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/styles.css'), 'utf8');

for (const [name, html] of Object.entries(globalThis.__PANELS__)) {
  const file = path.join(out, `${name}.html`);
  fs.writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><style>${css}</style>` +
      `<body style="margin:0">${html}</body>`,
  );
  console.log(`wrote ${path.relative(repo, file)}`);
}

/*
 * And one page that actually RUNS.
 *
 * The files above are `renderToStaticMarkup` — markup with no React behind
 * it, which is all a form at rest needs. It is useless for anything that
 * exists only after a click, and the context breakdown is exactly that: it
 * opens on click, measures its trigger, and clamps itself to the window.
 * Every earlier check of it was therefore by construction rather than by
 * looking, and it was wrong twice — most recently by being trapped inside a
 * scrolling panel that clips its children.
 *
 * So this bundles a real client entry and mounts it, and `shot-open.cjs`
 * clicks it.
 */
const liveEntry = path.join(out, 'live.jsx');
fs.writeFileSync(
  liveEntry,
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RoomPane } from '${path
    .join(repo, 'apps/desktop/src/renderer/RoomPane.tsx')
    .replace(/\\/g, '/')}';

const noop = () => {};

const room = ${JSON.stringify({
    id: 'r1',
    title: 'OpenClaw AddOn Dev & OpenClaw Dev Version',
    kind: 'group',
    mode: 'open',
    greeting:
      'Repository workflow - @openclaw-addon-dev manages the main techartdev/OpenClawHomeAssistant repository: watches issues, pull requests, releases and CI.',
    createdAt: 1,
    updatedAt: 1,
    participants: [
      { kind: 'human', id: 'human:local', name: 'You', channels: ['app'] },
      { kind: 'agent', id: 'a1', handle: 'openclaw-addon-prod-version' },
      { kind: 'agent', id: 'a2', handle: 'openclaw-addon-dev-version' },
    ],
  })};

const agents = ${JSON.stringify([
    { id: 'a1', name: 'OpenClaw AddOn Prod Version', createdAt: 1, updatedAt: 1 },
    { id: 'a2', name: 'OpenClaw AddOn Dev Version', createdAt: 1, updatedAt: 1 },
  ])};

const reports = ${JSON.stringify([
    {
      conversationId: 'r1', agentId: 'a1', agentName: 'OpenClaw AddOn Prod Version',
      used: 45468, measured: false, limit: 400000, fraction: 0.1136,
      systemTokens: 1016, toolTokens: 2010, messageTokens: 42442, model: 'gpt-5.6-terra',
    },
    {
      conversationId: 'r1', agentId: 'a2', agentName: 'OpenClaw AddOn Dev Version',
      used: 45431, measured: false, limit: 400000, fraction: 0.1135,
      systemTokens: 979, toolTokens: 2010, messageTokens: 42442, model: 'gpt-5.6-terra',
    },
  ])};

createRoot(document.getElementById('root')).render(
  React.createElement('div', { style: { display: 'flex', height: '100vh' } },
    React.createElement('div', { style: { flex: 1, background: '#0f1115' } }),
    React.createElement(RoomPane, {
      room, agents, routines: [], runStates: { a1: 'idle', a2: 'idle' },
      contextReports: reports,
      onCompact: noop, onMention: noop, onOpenRoutines: noop,
      onRename: noop, onSetGreeting: noop, onConfigure: noop, onClose: noop,
      onEndpoints: async () => [{ channel: 'telegram', label: 'OpenClaw AddOn Dev' }],
    }),
  ),
);
`,
);

const live = esbuild.buildSync({
  entryPoints: [liveEntry],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx' },
  absWorkingDir: repo,
});

const liveFile = path.join(out, 'room-pane-live.html');
fs.writeFileSync(
  liveFile,
  `<!doctype html><meta charset="utf-8"><style>${css}</style>` +
    `<body style="margin:0"><div id="root"></div>` +
    `<script>${live.outputFiles[0].text}</script></body>`,
);
console.log(`wrote ${path.relative(repo, liveFile)}`);
