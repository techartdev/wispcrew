/**
 * history-ui-test.mjs — the recovery panel renders, and says useful things.
 *
 * A checkpoint nobody can reach is not a safety net. This covers the panel
 * that exposes them, including the class check that caught a modal which
 * typechecked while looking broken.
 *
 * Offline: renders components, no app.
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
const outfile = path.join(repo, 'examples', 'cli-agent', '.history-test.mjs');

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

const { HistoryPanel } = await import(`file://${outfile.replace(/\\/g, '/')}`);

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

const noop = () => {};

console.log('\n[empty] a conversation that has lost nothing');
{
  const html = renderToStaticMarkup(
    React.createElement(HistoryPanel, { points: [], onRestore: async () => true, onClose: noop }),
  );
  check('renders', html.length > 100);
  check('says nothing was lost', /has not lost any messages/i.test(html));
  // The reassurance matters: an empty list should not read like a failure.
  check('and does not imply an error', !/error|failed|problem/i.test(html));
  check('no undefined classes', undefinedClassesIn(html).length === 0,
    undefinedClassesIn(html).join(', '));
}

console.log('\n[populated] saved versions are described, not enumerated');
{
  const points = [
    { file: 'a', createdAt: Date.now(), entries: 58, reason: 'cleared' },
    { file: 'b', createdAt: Date.now() - 60_000, entries: 12, reason: 'rewind' },
    { file: 'c', createdAt: Date.now() - 120_000, entries: 30, reason: 'before restore' },
  ];
  const html = renderToStaticMarkup(
    React.createElement(HistoryPanel, { points, onRestore: async () => true, onClose: noop }),
  );

  check('counts the messages', html.includes('58 messages'));
  check('singular is handled', renderToStaticMarkup(
    React.createElement(HistoryPanel, {
      points: [{ file: 'x', createdAt: Date.now(), entries: 1, reason: 'cleared' }],
      onRestore: async () => true,
      onClose: noop,
    }),
  ).includes('1 message<'), 'plural leaked into the singular case');

  // Reasons must read as English, not as internal labels.
  check('explains a clear', /before the chat was cleared/i.test(html));
  check('explains a rewind', /before a rewind/i.test(html));
  check('explains a restore', /before an earlier version was restored/i.test(html));

  check('offers to restore each', (html.match(/Restore/g) ?? []).length >= 3);
  check('no undefined classes', undefinedClassesIn(html).length === 0,
    undefinedClassesIn(html).join(', '));
}

console.log('\n[unknown reason] an unfamiliar label still renders');
{
  const html = renderToStaticMarkup(
    React.createElement(HistoryPanel, {
      points: [{ file: 'z', createdAt: Date.now(), entries: 4, reason: 'something new' }],
      onRestore: async () => true,
      onClose: noop,
    }),
  );
  check('falls back rather than showing nothing', /something new/.test(html));
}

fs.rmSync(outfile, { force: true });

console.log('');
if (failures) {
  console.error(`HISTORY-UI TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('HISTORY-UI TEST PASSED\n');
