/**
 * nodes-ui-test.mjs — the Machines panel renders the states that matter.
 *
 * Rendered through react-dom/server, which has caught real bugs here before:
 * a panel can typecheck perfectly and still throw at render, and the symptom
 * in the app is a blank window rather than an error anyone can read.
 *
 * The states worth pinning are the empty one (most users, forever), a
 * connected node, an unreachable node, and the warning shown before
 * forgetting a node that agents live on.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/*
 * Compile the panels for Node rather than importing a build artefact.
 *
 * The app bundles the renderer for a browser, so there is nothing on disk
 * that Node can import. Building here keeps the test honest — it renders the
 * real component from source, not a copy that could drift.
 */
const repo = fileURLToPath(new URL('../../../', import.meta.url));
// Built inside the repo so bare React imports resolve through the
// workspace's node_modules; a temp directory has no module graph.
const outfile = path.join(repo, 'examples', 'cli-agent', '.panels-test.mjs');

await build({
  entryPoints: [path.join(repo, 'apps', 'desktop', 'src', 'renderer', 'Panels.tsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  // React resolves from this workspace; leaving it external avoids bundling
  // two copies and the "invalid hook call" that follows.
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const { NodesPanel, AgentPanel } = await import(`file://${outfile.replace(/\\/g, '/')}`);

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const noop = () => {};
const noopAsync = async () => null;

/*
 * Every class a panel uses must exist in the stylesheet.
 *
 * The Machines modal typechecked, rendered, and passed its content
 * assertions while looking broken on screen: it used `.stack`, `.row` and
 * `.error-text`, none of which are defined, so labels and inputs collapsed
 * onto one line. Content assertions cannot see that; comparing against the
 * stylesheet can.
 */
const stylesheet = fs.readFileSync(
  path.join(repo, 'apps', 'desktop', 'src', 'renderer', 'styles.css'),
  'utf8',
);

function undefinedClassesIn(html) {
  const used = new Set();
  for (const match of html.matchAll(/class="([^"]+)"/g)) {
    for (const cls of match[1].split(/\s+/)) if (cls) used.add(cls);
  }
  return [...used].filter((cls) => !stylesheet.includes(`.${cls}`));
}

console.log('\n[styling] every class the panel uses is defined');
{
  const populated = renderToStaticMarkup(
    React.createElement(NodesPanel, {
      nodes: [
        {
          id: 'n1',
          name: 'homelab',
          address: '10.0.0.5:8787',
          fingerprint: 'AA:BB',
          pairedAt: 1,
          connected: true,
        },
      ],
      agents: [{ id: 'a1', name: 'X', nodeId: 'n1', createdAt: 1, updatedAt: 1 }],
      onPair: noopAsync,
      onForget: async () => true,
      onRefresh: noop,
      onClose: noop,
    }),
  );
  const missing = undefinedClassesIn(populated);
  check('no undefined classes in the node list', missing.length === 0, missing.join(', '));
}

console.log('\n[empty] the state every user starts in');
{
  const html = renderToStaticMarkup(
    React.createElement(NodesPanel, {
      nodes: [],
      agents: [],
      onPair: noopAsync,
      onForget: async () => true,
      onRefresh: noop,
      onClose: noop,
    }),
  );
  check('renders without a paired machine', html.length > 100);
  check('says everything runs here', /runs here|No machines paired/i.test(html));
  check('offers to pair one', /Pair a machine/i.test(html));
  // A user who never pairs anything must not be told about fingerprints.
  check('does not lead with jargon', !/fingerprint/i.test(html));
}

console.log('\n[paired] a connected machine with agents on it');
{
  const nodes = [
    {
      id: 'node_1',
      name: 'homelab',
      address: '192.168.1.50:8787',
      fingerprint: 'AA:BB:CC:DD:EE:FF',
      pairedAt: Date.now(),
      connected: true,
    },
  ];
  const agents = [
    { id: 'a1', name: 'Remote', nodeId: 'node_1', createdAt: 1, updatedAt: 1 },
    { id: 'a2', name: 'Local', createdAt: 1, updatedAt: 1 },
  ];
  const html = renderToStaticMarkup(
    React.createElement(NodesPanel, {
      nodes,
      agents,
      onPair: noopAsync,
      onForget: async () => true,
      onRefresh: noop,
      onClose: noop,
    }),
  );
  check('names the machine', html.includes('homelab'));
  check('shows its address', html.includes('192.168.1.50:8787'));
  check('reports it as connected', /connected/i.test(html));
  // Counting only the agents that live there is the whole point.
  check('counts the agents on it', /1 agent live/i.test(html), html.match(/\d+ agents? live[^<]*/)?.[0]);
  check('shows the fingerprint for verification', html.includes('AA:BB:CC:DD:EE:FF'));
}

console.log('\n[offline] an unreachable machine reads as offline, not broken');
{
  const html = renderToStaticMarkup(
    React.createElement(NodesPanel, {
      nodes: [
        {
          id: 'node_2',
          name: 'pi',
          address: 'pi.local:8787',
          fingerprint: 'FF',
          pairedAt: Date.now(),
          connected: false,
        },
      ],
      agents: [],
      onPair: noopAsync,
      onForget: async () => true,
      onRefresh: noop,
      onClose: noop,
    }),
  );
  check('says it is not reachable', /not reachable/i.test(html));
  check('and does not claim an error', !/error|failed/i.test(html));
}

console.log('\n[agent panel] the machine picker appears only when useful');
{
  const agent = { id: 'a1', name: 'Test', createdAt: 1, updatedAt: 1 };
  const presets = [{ id: 'nvidia', label: 'NVIDIA', models: [], configured: true }];

  const withoutNodes = renderToStaticMarkup(
    React.createElement(AgentPanel, {
      agent,
      presets,
      personas: [],
      nodes: [],
      onSave: noop,
      onDelete: noop,
      onDuplicate: noop,
      onPickDirectory: async () => null,
      onClose: noop,
    }),
  );
  check('hidden with no machines paired', !/Runs on/i.test(withoutNodes));

  const withNodes = renderToStaticMarkup(
    React.createElement(AgentPanel, {
      agent,
      presets,
      personas: [],
      nodes: [
        {
          id: 'node_1',
          name: 'homelab',
          address: 'x',
          fingerprint: 'y',
          pairedAt: 1,
          connected: true,
        },
      ],
      onSave: noop,
      onDelete: noop,
      onDuplicate: noop,
      onPickDirectory: async () => null,
      onClose: noop,
    }),
  );
  check('offered once a machine exists', /Runs on/i.test(withNodes));
  check('defaults to this computer', /This computer/i.test(withNodes));
  check('lists the paired machine', withNodes.includes('homelab'));
  check('explains that data stays put', /live on the machine/i.test(withNodes));
}

try {
  fs.rmSync(outfile, { force: true });
} catch {
  /* best effort */
}

console.log('');
if (failures) {
  console.error(`NODES-UI TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('NODES-UI TEST PASSED\n');
