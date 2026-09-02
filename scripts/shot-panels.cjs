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
import { NewChoicePanel, NewGroupPanel, RoomPanel, NewAgentPanel, AgentPanel } from '${path
    .join(repo, 'apps/desktop/src/renderer/Panels.tsx')
    .replace(/\\/g, '/')}';

const agents = [
  { id: 'a1', name: 'Assistant', updatedAt: 1, createdAt: 1 },
  { id: 'a2', name: 'Reviewer', updatedAt: 1, createdAt: 1 },
  { id: 'a3', name: 'Linux box', nodeId: 'node_1', updatedAt: 1, createdAt: 1 },
];

const room = {
  id: 'a1',
  title: 'Assistant',
  kind: 'direct',
  mode: 'open',
  createdAt: 1,
  updatedAt: 1,
  participants: [
    { kind: 'human', id: 'human:local', name: 'You', channels: ['app'] },
    { kind: 'agent', id: 'a1', handle: 'assistant' },
  ],
};

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
      room, agents, onAdd: noop, onSplit: noop, onRemove: noop, onSetMode: noop, onClose: noop,
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
