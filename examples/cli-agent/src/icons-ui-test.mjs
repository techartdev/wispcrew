/**
 * icons-ui-test.mjs — the icons exist, are honest, and cost nothing.
 *
 * Typechecking says nothing about appearance: an earlier modal compiled
 * perfectly while rendering against CSS classes that did not exist. The
 * `*-ui` suites exist for that gap, and this one covers the icon set.
 *
 * The rule it protects: an icon is a SECOND read, never the only one. A
 * glyph is fast once you know an app and a guess the first time, so every
 * icon here sits beside a label or carries an accessible name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const renderer = path.join(repo, 'apps/desktop/src/renderer');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const read = (file) => fs.readFileSync(path.join(renderer, file), 'utf8');

const icons = read('Icons.tsx');
const css = read('styles.css');

console.log('\n[no dependency] the set is ours');
{
  /*
   * Hard rule 9: dependencies are a security decision, and this app runs
   * shell commands. An icon package is a lot of third-party code to ship
   * for decoration.
   */
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'apps/desktop/package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const iconPkgs = deps.filter((d) => /icon|lucide|heroicon|feather|phosphor|fontawesome/i.test(d));

  check('no icon package was added', iconPkgs.length === 0, iconPkgs.join(', '));
  check('the icons are hand-written', icons.includes('viewBox="0 0 24 24"'));
}

console.log('\n[accessibility] an icon is never the only signal');
{
  // Decorative by default, so a screen reader is not made to announce a
  // shape that sits next to the word it duplicates.
  check('glyphs are hidden from assistive tech', icons.includes('aria-hidden="true"'));
  check('and not focusable', icons.includes('focusable="false"'));

  /*
   * The one icon-only control in the app. Without a name it is an
   * unlabelled button — the exact failure this rule exists to prevent.
   */
  const chat = read('Chat.tsx');
  const attach = chat.slice(chat.indexOf('btn-attach'), chat.indexOf('btn-attach') + 400);
  check('the attach button has an accessible name', attach.includes('aria-label="Attach files"'));
  check('and a tooltip', attach.includes('title="Attach files"'));

  /*
   * EVERY icon-only control, not just the ones I remembered.
   *
   * `.icon-btn` renders a glyph and nothing else, so without a name it is a
   * button that announces itself as "button". This is the check the CSS
   * comment claims exists — so it has to actually exist.
   */
  for (const file of ['App.tsx', 'Sidebar.tsx', 'Chat.tsx']) {
    const source = read(file);

    /*
     * Taken as a WINDOW from the class to the closing tag, not by matching
     * up to the first `>`.
     *
     * The obvious `<button[^>]*>` stops at the arrow in
     * `onClick={() => …}` — an arrow function contains a `>`, so the match
     * ended mid-element and reported correctly-labelled buttons as missing
     * their labels.
     */
    const buttons = [...source.matchAll(/icon-btn/g)].map((m) => {
      const end = source.indexOf('</button>', m.index);
      return source.slice(m.index, end === -1 ? m.index + 400 : end);
    });

    for (const [i, button] of buttons.entries()) {
      check(`${file}: icon button ${i + 1} has an accessible name`,
        /aria-label[=[]/.test(button), button.replace(/\s+/g, ' ').slice(0, 90));
      check(`${file}: icon button ${i + 1} has a tooltip`,
        /title[=[]/.test(button), button.replace(/\s+/g, ' ').slice(0, 90));
    }
  }
}

console.log('\n[labels] every other icon has words beside it');
{
  const sidebar = read('Sidebar.tsx');
  for (const [icon, label] of [
    ['IconClock', 'Routines'],
    ['IconSkill', 'Skills'],
    ['IconPlug', 'Plugins'],
    ['IconMachine', 'Machines'],
    ['IconSettings', 'Settings'],
  ]) {
    const at = sidebar.indexOf(`<${icon} />`);
    check(`${label} keeps its label`, at !== -1 && sidebar.slice(at, at + 120).includes(label));
  }
}

console.log('\n[wiring] every icon used is imported and defined');
{
  for (const file of ['Sidebar.tsx', 'App.tsx', 'Chat.tsx']) {
    const source = read(file);
    const used = [...new Set([...source.matchAll(/<(Icon[A-Za-z]+)\s*\/>/g)].map((m) => m[1]))];

    check(`${file} uses icons`, used.length > 0, `${used.length} found`);

    for (const name of used) {
      check(`${file}: ${name} is defined`, icons.includes(`export const ${name}`));
      check(`${file}: ${name} is imported`, new RegExp(`import \\{[^}]*\\b${name}\\b`).test(source));
    }
  }
}

console.log('\n[styles] the classes an icon row needs actually exist');
{
  // The gap between a glyph and its label, and the states that were missing
  // entirely — hover, active and focus all looked identical to rest, which
  // is most of why the app read as raw.
  check('.btn lays out icon and label', /\.btn \{[^}]*display: inline-flex/s.test(css));
  check('buttons answer the pointer', /\.btn:hover:not\(:disabled\)/.test(css));
  check('and the keyboard', /\.btn:focus-visible/.test(css));
  check('a press is visible', /\.btn:active:not\(:disabled\)/.test(css));
  check('disabled reads as disabled', /\.btn:disabled/.test(css));

  // A variable used but never defined silently renders as nothing.
  const used = [...css.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((v) => !css.includes(`${v}:`));
  check('every CSS variable used is defined', missing.length === 0, missing.join(', '));

  // `--bg-hover` was introduced by this change and used before it existed.
  check('--bg-hover is defined', css.includes('--bg-hover:'));

  /*
   * The OPEN list of a <select> is drawn by the platform, not the page.
   *
   * Making the select transparent to fit the room bar left its options
   * inheriting a light colour onto the popup's own white background:
   * "Directed" and "Free" were near-invisible, and only the highlighted row
   * could be read. Options need BOTH halves stated — inheriting one and
   * hoping for the other is exactly what broke it.
   */
  const option = css.slice(css.indexOf('.room-mode option'));
  check('select options set their own colour', /\.room-mode option \{[^}]*color:/s.test(option));
  check('and their own background', /\.room-mode option \{[^}]*background:/s.test(option));
}

console.log('\n[no duplicates] one rule per selector');
{
  /*
   * A second `.btn-danger` block was added here from a guess about how the
   * button looked, rather than from reading the sheet. It restyled nothing
   * and carried a comment contradicting the screen.
   */
  const count = (css.match(/^\.btn-danger \{/gm) || []).length;
  check('.btn-danger is declared once', count === 1, `${count} declarations`);
}

console.log('');
if (failures) {
  console.error(`ICONS-UI TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ICONS-UI TEST PASSED\n');
