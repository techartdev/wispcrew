/**
 * mention.ts — when does typing `@` mean "who is here?"
 *
 * Its own file because the interesting part is what must NOT open a menu.
 * A completion that fires on every `@` interrupts someone typing an email
 * address; one that fires too rarely is a feature nobody finds. Both are
 * quiet failures, so the rules are pinned by a suite rather than by feel.
 */

/**
 * The partial handle being typed at the caret, or `null` for no menu.
 *
 * Returns `''` for a bare `@`, which is a real answer: it means "show
 * everyone", and is different from `null`.
 */
export function parseMention(text: string, caret: number): string | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));

  const at = before.lastIndexOf('@');
  if (at === -1) return null;

  const partial = before.slice(at + 1);

  /*
   * A handle is one word. A space means the mention is finished — whatever
   * follows is prose, and "@linux please check" should not still be
   * completing against "please check".
   */
  if (!/^[\w-]*$/.test(partial)) return null;

  /*
   * An `@` needs whitespace or a line start before it.
   *
   * Without this, `someone@example.com` opens the menu the moment an email
   * address is typed — the single most common way this feature becomes
   * annoying rather than useful.
   */
  const preceding = at === 0 ? '' : before[at - 1]!;
  if (preceding !== '' && !/\s/.test(preceding)) return null;

  return partial;
}

/**
 * Does this message address a particular agent?
 *
 * Used to decide whether a room turn is directed. Deliberately separate
 * from `parseMention`, which is about the caret while typing; this is about
 * a finished message.
 */
export function mentionedHandles(text: string): string[] {
  const found = new Set<string>();

  // Same rule as above: preceded by whitespace or a line start, so an email
  // address is not read as addressing anyone.
  for (const m of text.matchAll(/(^|\s)@([\w-]+)/g)) {
    found.add(m[2]!.toLowerCase());
  }

  return [...found];
}
