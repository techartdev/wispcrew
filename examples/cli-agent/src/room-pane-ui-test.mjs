/**
 * room-pane-ui-test.mjs — the pane renders classes that exist, and says
 * only what the engine can know.
 *
 * The sibling `*-ui` suites exist because a panel can typecheck perfectly
 * and look broken: a class that no stylesheet defines produces unstyled
 * markup, which React is happy with and a person is not. One caught a modal
 * in exactly that state.
 *
 * This one adds a second concern. A status shown for an agent must come from
 * an event the engine actually emits — a pane that says "typing" when
 * nothing reports typing is a confident lie, and worse than showing less.
 *
 * Offline: reads source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const pane = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/RoomPane.tsx'), 'utf8');
const css = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/styles.css'), 'utf8');
const domain = fs.readFileSync(path.join(repo, 'packages/shared/src/domain.ts'), 'utf8');
const app = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/App.tsx'), 'utf8');

console.log('\n[classes] every one the pane renders exists in the stylesheet');
{
  const rendered = new Set();
  for (const m of pane.matchAll(/className="([^"{]+)"/g)) {
    for (const c of m[1].split(/\s+/).filter(Boolean)) rendered.add(c);
  }
  // Template-literal classNames: `room-pane-dot ${tone}` — the static half.
  for (const m of pane.matchAll(/className=\{`([a-z-]+)\s/g)) rendered.add(m[1]);

  check('the pane renders classes at all', rendered.size >= 6, `${rendered.size} found`);

  for (const cls of [...rendered].sort()) {
    if (!css.includes(`.${cls}`)) {
      failures++;
      console.error(`  FAIL .${cls} is rendered but not styled`);
    }
  }
  if (failures === 0) console.log(`  ok   all ${rendered.size} classes styled`);

  // The tones are applied dynamically, so they are checked by name.
  for (const tone of ['idle', 'busy', 'blocked', 'failed']) {
    check(`the ${tone} dot has a colour`, css.includes(`.room-pane-dot.${tone}`));
  }
}

console.log('\n[layout] the pane sits beside the conversation');
{
  /*
   * Measured, not assumed: `.main` was a column, so the pane rendered below
   * the composer where nothing could scroll to it. The toggle worked and the
   * panel was simply off-screen.
   */
  const mainRule = css.slice(css.indexOf('.main {'), css.indexOf('}', css.indexOf('.main {')));
  check('.main is a row', /flex-direction:\s*row/.test(mainRule), mainRule.slice(0, 60));
  /*
   * Matched from the rule, not from anywhere the name appears: the first
   * version found `.chat-column` inside the comment on `.main` that explains
   * why it exists, and reported the real rule as missing.
   */
  const columnRule = css.slice(
    css.indexOf('.chat-column {'),
    css.indexOf('}', css.indexOf('.chat-column {')),
  );
  check('.chat-column exists', css.includes('.chat-column {'));
  check('and is a column', /flex-direction:\s*column/.test(columnRule), columnRule.slice(0, 60));

  // The header belongs INSIDE that column; leaving it out put the title in
  // the middle of the window.
  const columnAt = app.indexOf('<div className="chat-column">');
  const headerAt = app.indexOf('<header className="topbar">');
  check('the header is inside the column', columnAt !== -1 && columnAt < headerAt);
}

console.log('\n[honesty] no status the engine cannot supply');
{
  /*
   * The states the engine defines. A pane label must map from one of these,
   * not from a word that reads well.
   */
  const stateLine = /export type AgentRunState = ([^;]+);/.exec(domain)?.[1] ?? '';
  const known = [...stateLine.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

  check('the engine defines its states', known.length === 4, known.join(', '));

  // Every case the pane switches on must be one of them.
  const cases = [...pane.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);
  for (const c of cases) {
    check(`"${c}" is a real state`, known.includes(c), `not in ${known.join(', ')}`);
  }

  /*
   * And the words it SHOWS must not promise more than that. "Typing" and
   * "raising a hand" describe a room well, and nothing emits them.
   *
   * Checked against the rendered labels only. The first version searched the
   * whole file and failed on the comment explaining why those words are
   * absent — a test that punishes the explanation for the behaviour it is
   * verifying.
   */
  const labels = [...pane.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1].toLowerCase());
  check('the pane has labels', labels.length === 4, labels.join(', '));

  for (const invented of ['typing', 'raising', 'hand', 'speaking']) {
    check(`no label claims "${invented}"`, !labels.some((l) => l.includes(invented)),
      labels.join(', '));
  }
}

console.log('\n[schedules] a cron expression is turned into words');
{
  /*
   * `0 9 * * 1-5` tells a person almost nothing at a glance. The point of
   * the pane is the opposite of that.
   */
  check('common shapes are described', pane.includes('weekdays at'));
  check('and one-shots too', pane.includes('once, at'));

  /*
   * The important half: an expression it does not recognise falls back to
   * the expression itself rather than a wrong guess. Describing
   * `0 9 * * 1,3,5` as "daily" would be worse than showing the cron.
   */
  check('an unfamiliar shape is shown verbatim',
    /Not a shape worth guessing at|return cron;/.test(pane));
}

console.log('');
if (failures) {
  console.error(`ROOM-PANE-UI TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM-PANE-UI TEST PASSED\n');
