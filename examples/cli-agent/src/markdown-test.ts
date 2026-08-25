/**
 * markdown-test.ts — guards the hand-written Markdown renderer.
 *
 * The renderer takes **untrusted model output** and must never produce raw
 * HTML or an executable URL, so these assertions cover both correctness
 * (identifiers, code, lists, tables) and safety (script injection, dangerous
 * link schemes).
 *
 * It runs the real component through React's static renderer, so what is
 * asserted is the actual DOM the app produces.
 *
 * Run: npm run test:markdown --workspace @wispcrew/examples-cli
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Markdown } from '../../../apps/desktop/src/renderer/Markdown.js';

let failures = 0;

function render(src: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text: src }));
}

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function contains(label: string, src: string, needle: string): void {
  const html = render(src);
  check(label, html.includes(needle), `expected to find ${JSON.stringify(needle)} in ${html}`);
}

function omits(label: string, src: string, needle: string): void {
  const html = render(src);
  check(label, !html.includes(needle), `expected NOT to find ${JSON.stringify(needle)} in ${html}`);
}

console.log('\n[safety] untrusted model output cannot inject HTML');
{
  // Raw HTML must be escaped into text, never emitted as markup.
  omits('script tag is not emitted', '<script>alert(1)</script>', '<script>');
  contains('script tag is escaped', '<script>alert(1)</script>', '&lt;script&gt;');
  omits('img onerror is not emitted', '<img src=x onerror=alert(1)>', '<img');
  omits('iframe is not emitted', '<iframe src="evil"></iframe>', '<iframe');
  // Even inside code fences, content stays inert text.
  omits('html inside a fence is inert', '```\n<script>x</script>\n```', '<script>');
}

console.log('\n[safety] dangerous link schemes are not clickable');
{
  omits('javascript: link is not an anchor', '[click](javascript:alert(1))', '<a ');
  omits('data: link is not an anchor', '[click](data:text/html,<script>)', '<a ');
  omits('file: link is not an anchor', '[open](file:///etc/passwd)', '<a ');
  contains('https link is an anchor', '[site](https://example.com)', '<a href="https://example.com"');
  contains('external links get noreferrer', '[s](https://e.com)', 'rel="noreferrer noopener"');
}

console.log('\n[identifiers] underscores inside words are literal');
{
  // The bug this test was written for: NEWUI_CHAT_OK rendered as
  // NEWUI<em>CHAT</em>OK, silently corrupting identifiers.
  omits('SNAKE_CASE is not italicised', 'NEWUI_CHAT_OK', '<em>');
  contains('SNAKE_CASE text survives intact', 'NEWUI_CHAT_OK', 'NEWUI_CHAT_OK');
  omits('multiple underscores stay literal', 'a_b_c_d', '<em>');
  contains('snake_case identifier intact', 'my_var_name here', 'my_var_name');
  // Genuine emphasis still works when underscores stand alone.
  contains('standalone _emphasis_ works', 'an _emphasised_ word', '<em>emphasised</em>');
  contains('standalone __strong__ works', 'a __bold__ word', '<strong>bold</strong>');
}

console.log('\n[inline] basic formatting');
{
  contains('bold', 'a **bold** word', '<strong>bold</strong>');
  contains('italic', 'a *slanted* word', '<em>slanted</em>');
  contains('bold italic', '***both***', '<strong><em>both</em></strong>');
  contains('strikethrough', '~~gone~~', '<del>gone</del>');
  contains('inline code', 'use `npm run build` now', '<code class="md-code">npm run build</code>');
  // Emphasis markers inside code spans must stay literal.
  omits('no emphasis inside code span', '`a*b*c`', '<em>');
  contains('code span keeps asterisks', '`a*b*c`', 'a*b*c');
}

console.log('\n[blocks] structure');
{
  contains('fenced code block', '```js\nconst x = 1;\n```', 'const x = 1;');
  contains('code block language label', '```python\npass\n```', 'python');
  contains('unordered list', '- one\n- two', '<li>one</li>');
  contains('ordered list', '1. first\n2. second', '<ol>');
  contains('heading', '# Title', 'Title');
  contains('blockquote', '> quoted', '<blockquote>');
  contains('horizontal rule', 'a\n\n---\n\nb', '<hr/>');
  contains('table header', '| A | B |\n| - | - |\n| 1 | 2 |', '<th>');
  contains('table cell', '| A | B |\n| - | - |\n| 1 | 2 |', '<td>');
}

console.log('\n[robustness] malformed input does not throw');
{
  const nasty = [
    '',
    '```\nunclosed fence',
    '**unclosed bold',
    '| broken | table',
    '- \n- \n',
    '#'.repeat(50),
    '*'.repeat(200),
    '_'.repeat(200),
    '[](',
    '`'.repeat(99),
  ];
  for (const src of nasty) {
    let threw = false;
    try {
      render(src);
    } catch {
      threw = true;
    }
    check(`survives ${JSON.stringify(src.slice(0, 18))}`, !threw);
  }
}

console.log('');
if (failures > 0) {
  console.error(`MARKDOWN TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('MARKDOWN TEST PASSED\n');
