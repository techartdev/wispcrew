/**
 * completion-keys-test.mjs — an open menu owns the keyboard.
 *
 * The rule that matters: while a completion list is showing, the keys a
 * person presses belong to it. Enter used to send unconditionally, so
 * pressing it on a highlighted handle sent "ask @lin" — the half-typed
 * mention rather than the one being chosen. That is the shape of bug this
 * pins.
 *
 * Checked against the source, because keyboard order has no visible trace: a
 * screenshot shows a menu, not which handler ran first.
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

const chat = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/Chat.tsx'), 'utf8');
const css = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/styles.css'), 'utf8');

const handler = chat.slice(
  chat.indexOf('const onKeyDown'),
  chat.indexOf('\n  };', chat.indexOf('const onKeyDown')),
);

console.log('\n[order] the menu answers before the composer does');
{
  check('the handler exists', handler.length > 100);

  /*
   * The heart of it. Every menu branch must come BEFORE the branch that
   * sends, or Enter sends a half-typed token instead of accepting.
   */
  const acceptAt = handler.indexOf("e.key === 'Tab' || (e.key === 'Enter'");
  const submitAt = handler.indexOf('submit();');

  check('accepting is handled', acceptAt !== -1);
  check('sending is handled', submitAt !== -1);
  check('accept comes before send', acceptAt !== -1 && acceptAt < submitAt,
    `accept at ${acceptAt}, send at ${submitAt}`);

  // Same for Escape: dismissing must not fall through to interrupting a run.
  const dismissAt = handler.indexOf('setDismissed(true)');
  const interruptAt = handler.indexOf('onInterrupt()');
  check('dismiss comes before interrupt', dismissAt !== -1 && dismissAt < interruptAt,
    `dismiss at ${dismissAt}, interrupt at ${interruptAt}`);
}

console.log('\n[navigation] arrows move, and wrap');
{
  check('ArrowDown is handled', handler.includes("e.key === 'ArrowDown'"));
  check('ArrowUp too', handler.includes("e.key === 'ArrowUp'"));

  /*
   * Wrapping matters more than it sounds: without it, holding one arrow
   * sticks silently at an end, which reads as a broken menu rather than a
   * boundary.
   */
  check('the highlight wraps', /%\s*menu\.items\.length/.test(handler));

  // A guard against the classic off-by-one on the way up.
  check('and does not go negative', /\+\s*menu\.items\.length\)\s*%/.test(handler));
}

console.log('\n[one menu] both kinds share the same machinery');
{
  /*
   * Two near-identical blocks is how two menus drift into behaving
   * differently. The keyboard handler should not know which kind is open.
   */
  check('a single menu object exists', chat.includes('const menu = useMemo'));
  check('with a kind', /kind:\s*'mention'/.test(chat) && /kind:\s*'skill'/.test(chat));
  check('and one accept path', (chat.match(/menu\.accept\(/g) ?? []).length >= 2);

  // Rendered from the same object, so click and keyboard cannot disagree.
  check('rendered from menu.items', chat.includes('menu.items.map('));
  check('only one hints block', (chat.match(/className="skill-hints"/g) ?? []).length === 1,
    `${(chat.match(/className="skill-hints"/g) ?? []).length} blocks`);
}

console.log('\n[state] the highlight cannot point past the end');
{
  /*
   * Narrowing a search shortens the list. A highlight left pointing past the
   * end makes Enter accept nothing — or accept whatever slid into that
   * position while the person was still typing.
   */
  check('it resets when the list changes',
    /setHighlight\(0\)/.test(chat) && /menu\.items\.length\]/.test(chat));

  /*
   * Dismissal is a flag, not a caret nudge. The earlier trick worked until a
   * click or arrow key put the caret back and the menu someone had just
   * dismissed reappeared.
   */
  check('dismissal is a flag', chat.includes('const [dismissed, setDismissed]'));
  check('and typing brings the menu back', /setDismissed\(false\)/.test(chat));
  check('not a caret nudge', !chat.includes('setCaret(-1)'));
}

console.log('\n[accessibility] a list a screen reader can follow');
{
  check('it is a listbox', chat.includes('role="listbox"'));
  check('rows are options', chat.includes('role="option"'));
  check('the current row is announced', chat.includes('aria-selected={i === highlight}'));

  // And visible, not only announced.
  check('the highlight has a style', css.includes('.skill-hint.highlighted'));
  check('mouse and keyboard share it', chat.includes('onMouseEnter={() => setHighlight(i)}'));
}

console.log('\n[routing] a display filter must live where the call is answered');
{
  /*
   * The desktop bridge FORWARDS to a daemon whenever one is connected, so a
   * handler added only to `bridge-host.ts` may never run.
   *
   * Measured: filtering dead participants out of `listConversations` there
   * changed nothing at all — the daemon answered, unfiltered, and the ghost
   * was still in the menu. The filter has to be in both, or in neither.
   */
  const daemon = fs.readFileSync(path.join(repo, 'apps/daemon/src/methods.ts'), 'utf8');
  const bridge = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/bridge-host.ts'), 'utf8');

  check('the daemon filters participants', daemon.includes('visibleParticipants(room)'));
  check('and so does the desktop', bridge.includes('visibleParticipants(room)'));

  // The shared helper, so the two cannot drift.
  const runtime = fs.readFileSync(
    path.join(repo, 'packages/runtime/src/conversations.ts'), 'utf8',
  );
  check('both call one runtime helper', runtime.includes('export function visibleParticipants'));
}

console.log('');
if (failures) {
  console.error(`COMPLETION-KEYS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('COMPLETION-KEYS TEST PASSED\n');
