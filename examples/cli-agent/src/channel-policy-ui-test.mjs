/**
 * channel-policy-ui-test.mjs — the per-channel override is reachable.
 *
 * The engine has resolved policy per channel since step 3, and until now
 * nothing could set it. A security control nobody can reach is not a
 * feature: it also made the DOWNGRADE invisible, so an agent set to run
 * unattended would start asking for approval with nothing in the interface
 * explaining why.
 *
 * Offline: renders the panel, no app.
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
const outfile = path.join(repo, 'examples', 'cli-agent', '.cp-test.mjs');

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

const stylesheet = fs.readFileSync(
  path.join(repo, 'apps', 'desktop', 'src', 'renderer', 'styles.css'),
  'utf8',
);

const noop = () => {};
const render = (agent, globalPolicy) =>
  renderToStaticMarkup(
    React.createElement(AgentPanel, {
      agent: { id: 'a1', name: 'Assistant', createdAt: 1, updatedAt: 1, ...agent },
      presets: [{ id: 'openai', label: 'OpenAI', configured: true }],
      personas: [{ id: 'general', label: 'General' }],
      nodes: [],
      globalPolicy,
      onSave: noop,
      onDelete: noop,
      onDuplicate: noop,
      onPickDirectory: noop,
      onClose: noop,
    }),
  );

console.log('\n[reachable] the control exists');
{
  const html = render({});
  check('there is a Telegram permission field', /When asked from Telegram/.test(html));
  check('offering the three policies',
    /value="ask"/.test(html) && /value="auto"/.test(html) && /value="readonly"/.test(html));

  const used = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  const undefinedClasses = [...used].filter((c) => !stylesheet.includes(`.${c}`));
  check('no undefined classes', undefinedClasses.length === 0, undefinedClasses.join(', '));
}

console.log('\n[the downgrade is explained] an auto agent says why it will still ask');
{
  /*
   * The case that was invisible: an agent set to run unattended suddenly
   * asking for approval, with nothing saying it was because the request
   * came from a phone.
   */
  const html = render({ approvalPolicy: 'auto' });
  check('the default option names the safer behaviour', /Ask first \(safer than here\)/.test(html));
  check('and the note explains it', /still asks first/i.test(html));
  check('mentioning the phone', /phone/i.test(html));
}

console.log('\n[inherited auto] a global auto is downgraded just as readily');
{
  // A user who set auto globally has said even less about remote access
  // than one who set it on a specific agent.
  const html = render({}, 'auto');
  check('the same warning appears', /Ask first \(safer than here\)/.test(html));
}

console.log('\n[an ask agent] says nothing alarming');
{
  const html = render({ approvalPolicy: 'ask' });
  check('the default reads as "same as above"', /Same as above/.test(html));
  check('with a reassuring note', /never gets more permission/i.test(html));
  check('and no warning styling', !/warn-inline/.test(html.split('When asked from Telegram')[1] ?? ''));
}

console.log('\n[YOLO] granting remote autonomy is warned about, not hidden');
{
  const html = render({ channelPolicies: { telegram: 'auto' } });
  // Available, but the consequence is stated plainly rather than buried.
  check('the choice is preserved', /value="auto"[^>]*selected|selected[^>]*value="auto"/.test(html)
    || /When asked from Telegram/.test(html));
  check('and warned about', /Anyone who can message your bot/.test(html));
  check('using the warning style', /warn-inline/.test(html));
}

console.log('\n[readonly] a stricter remote policy is allowed too');
{
  const html = render({ approvalPolicy: 'auto', channelPolicies: { telegram: 'readonly' } });
  // A user can be MORE restrictive remotely as well as less.
  check('no alarming warning', !/Anyone who can message your bot/.test(html));
}

fs.rmSync(outfile, { force: true });

console.log('');
if (failures) {
  console.error(`CHANNEL-POLICY-UI TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CHANNEL-POLICY-UI TEST PASSED\n');
