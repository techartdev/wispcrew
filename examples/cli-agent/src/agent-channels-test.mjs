/**
 * agent-channels-test.mjs — a per-agent notification override.
 *
 * The objective asks for channels configurable per agent AND globally. The
 * type and the resolution logic supported per-agent from the start, but
 * nothing exposed it, so in practice only the global setting existed.
 *
 * The subtlety is that this is a THREE-state field: follow the global
 * setting, or override it — and an override may be empty, which is how an
 * agent is told to stay silent. A plain checkbox list cannot express that,
 * and an empty override must not be mistaken for "unset".
 *
 * Offline: store and resolution only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import {
  channelsFor,
  createAgent,
  createNodeCrypto,
  initStore,
  listAgents,
  setHost,
  updateAgent,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-agentch-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

const global = { channels: { enabled: ['desktop'] } };

console.log('\n[unset] an agent follows the global setting');
{
  const agent = createAgent({ name: 'Default' });
  check('no override is stored', agent.channels === undefined);

  const resolved = channelsFor(agent, global);
  check('it gets the global channel', resolved.includes('desktop'));
  check('and the conversation', resolved.includes('app'));
}

console.log('\n[override] an agent can be noisier than the default');
{
  const agent = createAgent({ name: 'Noisy' });
  updateAgent(agent.id, { channels: ['telegram'] });

  const stored = listAgents().find((a) => a.id === agent.id);
  check('the override persists', JSON.stringify(stored.channels) === '["telegram"]',
    JSON.stringify(stored.channels));

  const resolved = channelsFor(stored, global);
  check('it uses its own channel', resolved.includes('telegram'));
  check('and not the global one', !resolved.includes('desktop'), JSON.stringify(resolved));
}

console.log('\n[silence] an empty override is a real choice, not "unset"');
{
  const agent = createAgent({ name: 'Quiet' });
  updateAgent(agent.id, { channels: [] });

  const stored = listAgents().find((a) => a.id === agent.id);
  // The bug this guards: an empty array surviving a round trip as undefined
  // would silently make a deliberately quiet agent notify the user.
  check('an empty array survives storage', Array.isArray(stored.channels),
    JSON.stringify(stored.channels));
  check('and is still empty', stored.channels?.length === 0);

  const resolved = channelsFor(stored, global);
  check('it stays silent', !resolved.includes('desktop'), JSON.stringify(resolved));
  check('but still writes to the conversation', resolved.includes('app'));
}

console.log('\n[panel] the control offers all three states');
{
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const outfile = path.join(repo, 'examples', 'cli-agent', '.agentch-test.mjs');
  await build({
    entryPoints: [path.join(repo, 'apps', 'desktop', 'src', 'renderer', 'Panels.tsx')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const { AgentPanel } = await import(`file://${outfile.replace(/\\/g, '/')}`);

  const render = (agent) =>
    renderToStaticMarkup(
      React.createElement(AgentPanel, {
        agent,
        presets: [],
        personas: [],
        nodes: [],
        onSave: () => {},
        onDelete: () => {},
        onPickDirectory: async () => null,
        onClose: () => {},
      }),
    );

  const unset = render({ id: 'a', name: 'A', createdAt: 1, updatedAt: 1 });
  check('the default is offered', /Use the global setting/.test(unset));
  check('and no checkboxes are shown', !/Desktop notification/.test(unset));

  const custom = render({ id: 'b', name: 'B', channels: [], createdAt: 1, updatedAt: 1 });
  check('an override reveals the choices', /Desktop notification/.test(custom));
  check('including telegram', /Telegram/.test(custom));
  // A user who unticks everything should be told what that means.
  check('and an empty list explains itself',
    /only write to the conversation/.test(custom), custom.slice(0, 200));

  fs.rmSync(outfile, { force: true });
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`AGENT-CHANNELS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('AGENT-CHANNELS TEST PASSED\n');
