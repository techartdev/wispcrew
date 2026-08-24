/**
 * Markdown.tsx — a small, safe Markdown renderer for assistant messages.
 *
 * Written by hand rather than pulled from npm for two reasons:
 *
 *  1. **Security.** Model output is untrusted input. Most Markdown libraries
 *     render raw HTML by default, and a sanitizer is a second dependency with
 *     its own CVE history. Here every node is produced as a React element, so
 *     there is no `dangerouslySetInnerHTML` anywhere and raw HTML in the
 *     source is displayed as literal text — XSS is structurally impossible,
 *     not merely filtered.
 *
 *  2. **Supply chain.** This app runs shell commands on the user's machine.
 *     A markdown parser plus a sanitizer plus a highlighter is a large amount
 *     of third-party code to trust for what amounts to bold text and code
 *     blocks.
 *
 * Supported: fenced code blocks (with language label + copy), headings,
 * unordered/ordered lists, blockquotes, horizontal rules, tables, and inline
 * code / bold / italic / strikethrough / links. Unsupported constructs
 * degrade to plain text, which is the correct failure mode for a chat UI.
 */
// The explicit React import keeps this component renderable by toolchains
// that compile JSX with the classic runtime (the offline markdown test runs
// it through react-dom/server outside the Vite build). It is a no-op under
// the automatic runtime Vite uses.
import React, { useState, type ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/* Inline formatting                                                   */
/* ------------------------------------------------------------------ */

/**
 * Parse inline markup into React nodes.
 *
 * Order matters: code spans are extracted first so their contents are never
 * re-parsed as emphasis (`` `a*b*c` `` must stay literal).
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let remaining = text;
  let key = 0;

  // One pass, longest-token-first, so `**` wins over `*`.
  //
  // Underscore emphasis requires a word boundary on both sides (`(?<![\w])`
  // / `(?![\w])`). Without that, an identifier like `NEWUI_CHAT_OK` or
  // `some_var_name` — extremely common in this app's output — renders with
  // its middle italicised and the underscores eaten. CommonMark has the same
  // intra-word rule for `_` (but not for `*`) for exactly this reason.
  const pattern =
    /(`[^`]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|((?<!\w)__[^_]+__(?!\w))|((?<!\w)_[^_\n]+_(?!\w))|(~~[^~]+~~)|(\[[^\]]*\]\([^)\s]+\))/;

  while (remaining.length > 0) {
    const match = pattern.exec(remaining);
    if (!match || match.index === undefined) {
      out.push(remaining);
      break;
    }

    if (match.index > 0) out.push(remaining.slice(0, match.index));
    const token = match[0];
    const k = `${keyPrefix}-i${key++}`;

    if (token.startsWith('`')) {
      out.push(
        <code className="md-code" key={k}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('***')) {
      out.push(
        <strong key={k}>
          <em>{token.slice(3, -3)}</em>
        </strong>,
      );
    } else if (token.startsWith('**')) {
      out.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('__')) {
      out.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('~~')) {
      out.push(<del key={k}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      if (linkMatch) {
        const [, label, href] = linkMatch;
        // Only http(s) links are clickable. A `javascript:` or `file:` URL
        // from model output renders as inert text.
        const safe = /^https?:\/\//i.test(href ?? '');
        out.push(
          safe ? (
            <a key={k} href={href} target="_blank" rel="noreferrer noopener">
              {label}
            </a>
          ) : (
            <span key={k}>{token}</span>
          ),
        );
      } else {
        out.push(token);
      }
    } else {
      // Single * or _ emphasis.
      out.push(<em key={k}>{token.slice(1, -1)}</em>);
    }

    remaining = remaining.slice(match.index + token.length);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Code block                                                          */
/* ------------------------------------------------------------------ */

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard denied — the button simply does nothing */
      });
  };

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-bar">
        <span className="md-lang">{lang || 'text'}</span>
        <button type="button" className="md-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Block parsing                                                       */
/* ------------------------------------------------------------------ */

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    /* fenced code */
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // consume closing fence (or run off the end, which is fine)
      blocks.push(<CodeBlock key={`b${key++}`} code={body.join('\n')} lang={lang} />);
      continue;
    }

    /* horizontal rule: three or more -, * or _ (optionally spaced) */
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} />);
      i++;
      continue;
    }

    /* heading */
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const content = renderInline(heading[2] ?? '', `b${key}`);
      const Tag = (`h${Math.min(level + 2, 6)}`) as 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(<Tag key={`b${key++}`}>{content}</Tag>);
      i++;
      continue;
    }

    /* blockquote */
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={`b${key++}`}>{renderInline(body.join(' '), `b${key}`)}</blockquote>,
      );
      continue;
    }

    /* table: header row, separator row, then body rows */
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(lines[i + 1] ?? '')
    ) {
      const splitRow = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|')) {
        rows.push(splitRow(lines[i] ?? ''));
        i++;
      }
      blocks.push(
        <div className="md-table-wrap" key={`b${key++}`}>
          <table>
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi}>{renderInline(h, `h${hi}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{renderInline(c, `c${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    /* lists (unordered or ordered) */
    const isUl = /^\s*[-*+]\s+/.test(line);
    const isOl = /^\s*\d+[.)]\s+/.test(line);
    if (isUl || isOl) {
      const items: string[] = [];
      const test = isUl ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/;
      while (i < lines.length && test.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(test, ''));
        i++;
      }
      const rendered = items.map((item, ii) => <li key={ii}>{renderInline(item, `l${ii}`)}</li>);
      blocks.push(
        isUl ? <ul key={`b${key++}`}>{rendered}</ul> : <ol key={`b${key++}`}>{rendered}</ol>,
      );
      continue;
    }

    /* blank line */
    if (line.trim() === '') {
      i++;
      continue;
    }

    /* paragraph: consume until a blank line or a block-level construct */
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (
        l.trim() === '' ||
        /^\s*```/.test(l) ||
        /^(#{1,6})\s+/.test(l) ||
        /^\s*>\s?/.test(l) ||
        /^\s*[-*+]\s+/.test(l) ||
        /^\s*\d+[.)]\s+/.test(l)
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    blocks.push(<p key={`b${key++}`}>{renderInline(para.join('\n'), `b${key}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}
