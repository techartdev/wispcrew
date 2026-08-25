/**
 * fix-encoding.mjs — repair double-encoded UTF-8 in source files.
 *
 * Kept in the repo because this keeps happening: a tool that reads a UTF-8
 * file as Windows-1252 and writes it back turns "—" into a run of mojibake,
 * and the damage is invisible until someone reads the comment.
 *
 * Deliberately conservative. An earlier, cleverer version tried to undo an
 * arbitrary number of encoding layers and made things *worse* — it mangled
 * a file far beyond its original damage, which had to be recovered from git.
 * This version only replaces exact, known sequences. If it does not
 * recognise something, it reports it and changes nothing.
 *
 *   node scripts/fix-encoding.mjs          repair in place
 *   node scripts/fix-encoding.mjs --check  exit 1 if anything is mangled
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.git', 'coverage']);
const EXTENSIONS = /\.(ts|tsx|mjs|cjs|js|css|md|json|yml)$/;

/**
 * Exact sequences and their intended characters.
 *
 * Each is the UTF-8 encoding of a punctuation mark, re-read as
 * Windows-1252. Written as escapes so this file cannot itself be corrupted
 * by the problem it fixes.
 */
const KNOWN = [
  ['\u00E2\u20AC\u201D', '\u2014'], // em dash
  ['\u00E2\u20AC\u2122', '\u2019'], // right single quote
  ['\u00E2\u20AC\u009C', '\u201C'], // left double quote
  ['\u00E2\u20AC\u00A6', '\u2026'], // ellipsis
  ['\u00E2\u2020\u2019', '\u2192'], // right arrow
  ['\u00C3\u00A9', '\u00E9'], // e-acute
];

/** Anything still matching this after replacement is unrecognised damage. */
const SUSPECT = /[\u00C2\u00C3]|\u00E2\u20AC/;

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    } else if (EXTENSIONS.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
})(process.cwd());

const checkOnly = process.argv.includes('--check');
let repaired = 0;
const unresolved = [];

for (const file of files) {
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [bad, good] of KNOWN) after = after.split(bad).join(good);

  const stillBad = SUSPECT.test(after);
  const rel = path.relative(process.cwd(), file);

  if (stillBad) {
    // Report the lines so a human can judge, rather than guessing at them.
    after.split('\n').forEach((line, i) => {
      if (SUSPECT.test(line)) unresolved.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }

  if (after !== before && !checkOnly) {
    fs.writeFileSync(file, after, 'utf8');
    console.log(`repaired ${rel}`);
    repaired++;
  }
}

if (unresolved.length) {
  console.error('\nUnrecognised encoding damage — fix these by hand:');
  for (const line of unresolved) console.error(`  ${line}`);
  process.exit(1);
}

console.log(checkOnly ? 'encoding clean' : `${repaired} file(s) repaired, encoding clean`);
