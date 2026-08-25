/**
 * room-ui-test.mjs — the room is visible and explains itself.
 *
 * A conversation with several agents is only usable if you can see who is
 * in it. This covers the Members panel, including the class check that once
 * caught a modal which typechecked while looking broken.
 *
 * Offline: renders the component, no app.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const outfile = path.join(repo, 'examples', 'cli-agent', '.room-test.mjs');

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

const { RoomPanel } = await import(`file://${outfile.replace(/\\/g, '/')}`);

const stylesheet = fs.readFileSync(
  path.join(repo, 'apps', 'desktop', 'src', 'renderer', 'styles.css'),
  'utf8',
);
const undefinedClassesIn = (html) => {
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  return [...used].filter((c) => !stylesheet.includes(`.${c}`));
};

const agents = [
  { id: 'a_win', name: 'Windows builder', createdAt: 1, updatedAt: 1 },
  { id: 'a_lin', name: 'Linux builder', createdAt: 1, updatedAt: 1 },
  { id: 'a_mac', name: 'macOS runner', createdAt: 1, updatedAt: 1 },
];

const room = (patch = {}) => ({
  id: 'r1',
  title: 'Cross-platform test run',
  mode: 'open',
  createdAt: 1,
  updatedAt: 1,
  participants: [
    { kind: 'human', id: 'human:local', name: 'You', channels: ['desktop'] },
    { kind: 'agent', id: 'a_win', handle: 'windows' },
    { kind: 'agent', id: 'a_lin', handle: 'linux' },
  ],
  ...patch,
});

const noop = () => {};
const render = (r) =>
  renderToStaticMarkup(
    React.createElement(RoomPanel, {
      room: r,
      agents,
      onAdd: noop,
      onRemove: noop,
      onSetMode: noop,
      onClose: noop,
    }),
  );

console.log('\n[members] who is here, and how to address them');
{
  const html = render(room());
  check('the room is named', html.includes('Cross-platform test run'));
  check('handles are shown', html.includes('@windows') && html.includes('@linux'));
  // A handle alone is not enough: the user knows their agents by name.
  check('alongside the agent name', html.includes('Windows builder'));

  // The rule is easy to get wrong, so the panel says it rather than
  // assuming the user read a design document.
  check('it explains who answers', /tag an agent|last addressed/i.test(html));
  check('and mentions @all', html.includes('@all'));

  check('no undefined classes', undefinedClassesIn(html).length === 0,
    undefinedClassesIn(html).join(', '));
}

console.log('\n[adding] agents not in the room are offered');
{
  const html = render(room());
  check('the third agent can be added', html.includes('macOS runner'));
  check('but not one already here', (html.match(/Windows builder/g) ?? []).length === 1);
  // An agent in two rooms is a feature, not a mistake, and worth saying.
  check('and says its other conversations are safe', /unaffected/i.test(html));
}

console.log('\n[last agent] a room cannot be emptied');
{
  const solo = room({
    participants: [
      { kind: 'human', id: 'human:local', name: 'You', channels: ['desktop'] },
      { kind: 'agent', id: 'a_win', handle: 'windows' },
    ],
  });
  const html = render(solo);
  // Removing the only agent leaves a conversation nobody can answer, which
  // looks like a bug rather than a choice.
  check('the remove button is disabled', /disabled/.test(html));
  check('and says why', /at least one agent/i.test(html));
}

console.log('\n[guest] an invited agent reads differently');
{
  const withGuest = room({
    participants: [
      ...room().participants,
      { kind: 'agent', id: 'a_mac', handle: 'macos', invitedBy: 'a_win' },
    ],
  });
  const html = render(withGuest);
  check('an invited agent is marked', /Invited for this conversation/.test(html));
  check('and a permanent one is not', /Added by you/.test(html));
}

console.log('\n[mode] the three settings are offered and explained');
{
  const html = render(room({ mode: 'free' }));
  check('directed', /Directed/.test(html));
  check('open', /Open/.test(html));
  check('free', /Free/.test(html));
  check('the current mode is selected', /value="free"|selected/.test(html));
  // The loop rule and the budget are the two things that stop this being
  // expensive, so they are stated where the mode is chosen.
  check('the loop rule is stated', /never reply to each other/i.test(html));
  check('and the budget', /stops to check/i.test(html));
}

fs.rmSync(outfile, { force: true });

console.log('');
if (failures) {
  console.error(`ROOM-UI TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM-UI TEST PASSED\n');
