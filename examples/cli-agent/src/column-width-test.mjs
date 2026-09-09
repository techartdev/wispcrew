/*
 * column-width-test.mjs — the conversation column is ONE number.
 *
 * Everything that lines up with a message shares a width: the message, the
 * tool strip, an approval card, a notice, the composer and its hint, the
 * context meter, the skill hints, the attachment row, the steer queue.
 *
 * That number was written out eleven times. It drifted exactly as duplicated
 * constants always do -- the transcript was narrowed from 860px to 760px and
 * seven rules were missed, so tool strips and approval cards hung a hundred
 * pixels wider than the messages they belong to, and the composer was wider
 * than the conversation above it. The user reported it as "the UI looks
 * bad", which is the only symptom a duplicated constant ever produces: not a
 * crash, not a failing assertion, just something subtly wrong that no amount
 * of reading a single rule reveals.
 *
 * CSS has no type checker, so nothing else can catch this. The guard is
 * cheap and mechanical: if a rule that belongs to the column hard-codes a
 * pixel width, say so and name it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const css = fs.readFileSync(path.join(root, 'apps/desktop/src/renderer/styles.css'), 'utf8');
const lines = css.split('\n');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
};

/**
 * Every element that must line up with a message.
 *
 * `.modal-wide` is deliberately NOT here. It happens to use the same number
 * today, but a dialog is not the conversation column: binding them because
 * two values matched once is the same fault pointing the other way.
 */
const COLUMN_SELECTORS = [
  '.msg',
  '.tool-run',
  '.approval-card',
  '.notice',
  '.composer-row',
  '.composer-hint',
  '.context-meter-wrap',
  '.notice-summary',
  '.skill-hints',
  '.attach-pending',
  '.steer-queue',
];

/** The nearest selector at or above a line index. */
function selectorFor(idx) {
  for (let i = idx; i >= 0; i--) {
    const line = lines[i];
    if (i !== idx && line.includes('}')) return null;
    const m = line.match(/^([.#][^{]*?)\s*\{\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

console.log('\n[1] the token exists and is a real length');
{
  const m = css.match(/^\s*--column:\s*([^;]+);/m);
  check('--column is declared', !!m, 'no --column custom property in :root');
  if (m) check('and is a pixel width', /^\d+px$/.test(m[1].trim()), m[1].trim());
}

console.log('\n[2] every column element reads the token');
{
  const missing = [];
  for (const sel of COLUMN_SELECTORS) {
    const at = lines.findIndex((l) => l.trim() === `${sel} {`);
    if (at === -1) {
      missing.push(`${sel} — selector not found at all`);
      continue;
    }
    /* Read to the end of the block. */
    let body = '';
    for (let i = at + 1; i < lines.length && !lines[i].includes('}'); i++) body += lines[i] + '\n';
    if (!/max-width:\s*var\(--column\)/.test(body)) {
      const hard = body.match(/max-width:\s*[^;]+;/);
      missing.push(`${sel} — ${hard ? hard[0].trim() : 'no max-width'}`);
    }
  }
  check('all use var(--column)', missing.length === 0, missing.join('\n       '));
}

console.log('\n[3] no column rule hard-codes a width');
{
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*max-width:\s*\d+px;\s*$/.test(lines[i])) continue;
    const sel = selectorFor(i);
    if (sel && COLUMN_SELECTORS.includes(sel)) {
      offenders.push(`line ${i + 1}: ${sel} has ${lines[i].trim()}`);
    }
  }
  check('none found', offenders.length === 0, offenders.join('\n       '));
}

console.log('');
if (failures) {
  console.error(`COLUMN-WIDTH TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('COLUMN-WIDTH TEST PASSED\n');
