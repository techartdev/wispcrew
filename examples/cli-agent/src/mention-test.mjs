/**
 * mention-test.mjs — when typing `@` means "who is here?"
 *
 * The interesting half of a completion menu is what must NOT open it. Firing
 * on every `@` interrupts anyone typing an email address; firing too rarely
 * makes a feature nobody finds. Both are quiet failures that a screenshot
 * cannot show, so the rules live here.
 *
 * Offline: pure string handling.
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

/*
 * The implementation, reimplemented from its own source.
 *
 * `mention.ts` is TypeScript inside the renderer bundle and cannot be
 * imported by a plain Node script, so the logic is mirrored here and the
 * source is checked for drift below.
 */
const parseMention = (text, caret) => {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf('@');
  if (at === -1) return null;

  const partial = before.slice(at + 1);
  if (!/^[\w-]*$/.test(partial)) return null;

  const preceding = at === 0 ? '' : before[at - 1];
  if (preceding !== '' && !/\s/.test(preceding)) return null;

  return partial;
};

const at = (text) => parseMention(text, text.length);

console.log('\n[opens] where a mention is genuinely being typed');
{
  check('a bare @ shows everyone', at('@') === '');
  check('a partial handle', at('@lin') === 'lin');
  check('mid-sentence', at('ask @lin') === 'lin');
  check('after a newline', at('first line\n@lin') === 'lin');
  check('handles with a dash', at('@my-agent') === 'my-agent');
  check('handles with digits', at('@agent2') === 'agent2');
}

console.log('\n[stays closed] where an @ means something else');
{
  /*
   * The one that matters most. Typing an email address is the commonest way
   * a mention menu becomes an irritation rather than a help.
   */
  check('an email address', at('mail me at someone@example.com') === null,
    JSON.stringify(at('mail me at someone@example.com')));
  check('an email, partially typed', at('someone@exa') === null);

  // A finished mention: the words after it are prose, not a query.
  check('after a completed mention', at('@linux please check') === null);

  // No @ at all.
  check('plain text', at('hello there') === null);
  check('empty', at('') === null);

  /*
   * A handle attached to a word: `foo@bar` is not addressing anyone, and
   * neither is a price or a decorator.
   */
  check('attached to a word', at('npm i pkg@1.2.3') === null);
}

console.log('\n[the caret] completes where you are, not where you finished');
{
  /*
   * `@` is not like `/`: it belongs mid-sentence, so the menu must follow
   * the caret. Completing against the whole string would match the last
   * mention in the line rather than the one being typed.
   */
  const text = 'ask @lin to tell @win';

  check('at the first mention', parseMention(text, 8) === 'lin', parseMention(text, 8));
  check('at the second', parseMention(text, 21) === 'win', parseMention(text, 21));
  check('between them, nothing', parseMention(text, 14) === null, parseMention(text, 14));

  // A caret before any @ sees nothing, even though the text has two.
  check('before either', parseMention(text, 3) === null);
}

console.log('\n[bounds] a caret outside the text does not throw');
{
  check('past the end', at('@lin') === 'lin');
  check('negative', parseMention('@lin', -1) === null);
  check('far past the end', parseMention('@lin', 999) === 'lin');
}

console.log('\n[finished messages] who did this address?');
{
  const mentioned = (text) =>
    [...new Set([...text.matchAll(/(^|\s)@([\w-]+)/g)].map((m) => m[2].toLowerCase()))];

  check('one', JSON.stringify(mentioned('@linux check this')) === '["linux"]');
  check('several', mentioned('@linux and @windows').length === 2);
  check('deduplicated', mentioned('@linux @linux').length === 1);

  // Same rule as the menu: an email address addresses nobody.
  check('not an email', mentioned('write to a@b.com').length === 0,
    JSON.stringify(mentioned('write to a@b.com')));
}

console.log('\n[drift] the source still says what this tests');
{
  const source = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/mention.ts'), 'utf8');

  check('parseMention is exported', source.includes('export function parseMention'));
  check('it checks the preceding character', source.includes('preceding'));
  check('it rejects a partial with a space', source.includes("/^[\\w-]*$/"));
  check('mentionedHandles guards the same way', source.includes('(^|\\s)@'));
}

console.log('');
if (failures) {
  console.error(`MENTION TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('MENTION TEST PASSED\n');
