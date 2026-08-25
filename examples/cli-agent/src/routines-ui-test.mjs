/**
 * routines-ui-test.mjs — every kind of trigger says what wakes it.
 *
 * There are three now: a cron schedule, a one-shot follow-up an agent set
 * for itself, and a filesystem watch. The panel only ever rendered
 * `routine.cron`, so a watch and a follow-up showed an empty code block and
 * "next —" — telling the user nothing about work their own agent had
 * scheduled.
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
const outfile = path.join(repo, 'examples', 'cli-agent', '.routines-test.mjs');

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

const { RoutinesPanel } = await import(`file://${outfile.replace(/\\/g, '/')}`);

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

const agents = [{ id: 'a1', name: 'Watcher', createdAt: 1, updatedAt: 1 }];
const noop = () => {};
const base = { agentId: 'a1', prompt: 'Do the thing.', enabled: true, createdAt: 1, updatedAt: 1 };

const render = (routines) =>
  renderToStaticMarkup(
    React.createElement(RoutinesPanel, {
      routines,
      agents,
      onCreate: noop,
      onUpdate: noop,
      onDelete: noop,
      onRunNow: noop,
      onClose: noop,
    }),
  );

console.log('\n[schedule] a cron routine shows its expression and next run');
{
  const html = render([
    { ...base, id: 'r1', name: 'Morning digest', cron: '0 8 * * *', nextRunAt: Date.now() + 3600_000 },
  ]);
  check('the expression is shown', html.includes('0 8 * * *'));
  check('and the next run', /next \d/.test(html) || /next .*\d{4}/.test(html));
  check('no undefined classes', undefinedClassesIn(html).length === 0,
    undefinedClassesIn(html).join(', '));
}

console.log('\n[watch] a file watch says what it is watching');
{
  const html = render([
    { ...base, id: 'r2', name: 'Log watch', cron: '', watchPath: '/home/me/logs', watchPattern: '*.log' },
  ]);
  check('it says it is watching', /Watching/i.test(html));
  check('with the pattern', html.includes('*.log'));
  check('and the folder', html.includes('logs'));
  // The bug: a watch has no cron, so this used to be an empty code block.
  check('no empty code block', !/<code><\/code>/.test(html), html.slice(0, 300));
  check('and no meaningless next run', !/next not scheduled/.test(html));
}

console.log('\n[watch without a pattern] still reads sensibly');
{
  const html = render([
    { ...base, id: 'r3', name: 'Any change', cron: '', watchPath: '/home/me/src' },
  ]);
  check('it says everything', /everything/i.test(html), html.slice(0, 200));
}

console.log('\n[follow-up] a one-shot says when, once');
{
  const at = Date.now() + 1200_000;
  const html = render([{ ...base, id: 'r4', name: 'Build check', cron: '', runAt: at, selfScheduled: true }]);
  check('it says once', /Once, at/.test(html), html.slice(0, 300));
  check('no empty code block', !/<code><\/code>/.test(html));
}

console.log('\n[spent follow-up] a fired one-shot reads as done');
{
  const at = Date.now() - 600_000;
  const html = render([
    { ...base, id: 'r5', name: 'Build check', cron: '', runAt: at, selfScheduled: true, enabled: false },
  ]);
  // Disabled rather than deleted, so the user can still see what their agent
  // scheduled for itself and judge whether that was reasonable.
  check('it reads as already run', /Ran once/.test(html), html.slice(0, 300));
}

console.log('\n[mixed] all three render together without interfering');
{
  const html = render([
    { ...base, id: 'r1', name: 'Digest', cron: '0 8 * * *', nextRunAt: Date.now() + 1000 },
    { ...base, id: 'r2', name: 'Logs', cron: '', watchPath: '/var/log', watchPattern: '*.log' },
    { ...base, id: 'r3', name: 'Recheck', cron: '', runAt: Date.now() + 5000 },
  ]);
  check('the schedule appears', html.includes('0 8 * * *'));
  check('the watch appears', /Watching/i.test(html));
  check('the follow-up appears', /Once, at/.test(html));
  check('no undefined classes', undefinedClassesIn(html).length === 0,
    undefinedClassesIn(html).join(', '));
}

fs.rmSync(outfile, { force: true });

console.log('');
if (failures) {
  console.error(`ROUTINES-UI TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROUTINES-UI TEST PASSED\n');
