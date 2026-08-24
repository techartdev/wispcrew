/**
 * Web tools — fetch pages / search the web.
 *
 * web_fetch: GET a URL and return readable text (strips HTML, keeps links).
 * web_search: minimal DuckDuckGo HTML search fallback (no API key needed).
 * Both are best-effort; providers without network access will see errors.
 */
import type { Tool, ToolResult } from '@ghostbot/shared';

const MAX_BODY = 300_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|h3|h4|li|tr|pre|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface FetchArgs {
  url: string;
  maxBytes?: number;
}

export const webFetchTool: Tool<FetchArgs> = {
  definition: {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its readable text content. Use for documentation pages, plain sites, and raw files. ' +
      'If a site blocks the fetch provider, try curl via the shell tool instead.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL (http/https)' },
        maxBytes: { type: 'number', description: 'Max bytes to read (default 300000)' },
      },
      required: ['url'],
    },
  },
  async run(args: FetchArgs): Promise<ToolResult> {
    let url: URL;
    try {
      url = new URL(args.url);
    } catch {
      return { id: '', name: 'web_fetch', ok: false, errorCode: 'bad_url', content: `Invalid URL: ${args.url}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { id: '', name: 'web_fetch', ok: false, errorCode: 'bad_url', content: 'Only http/https URLs are supported' };
    }
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,*/*' },
        redirect: 'follow',
      });
      if (!res.ok) {
        return {
          id: '',
          name: 'web_fetch',
          ok: false,
          errorCode: `http_${res.status}`,
          content: `HTTP ${res.status} ${res.statusText}`,
        };
      }
      const maxBytes = Math.min(args.maxBytes ?? MAX_BODY, MAX_BODY);
      const buf = Buffer.from(await res.arrayBuffer());
      const body = buf.subarray(0, maxBytes).toString('utf8');
      const truncated = buf.length > maxBytes;
      const contentType = res.headers.get('content-type') ?? '';
      const isHtml = /html|xml/.test(contentType) || body.trimStart().startsWith('<');
      const text = isHtml ? htmlToText(body) : body;
      const finalText = text.trim().slice(0, MAX_BODY);
      return {
        id: '',
        name: 'web_fetch',
        ok: true,
        content: finalText + (truncated || body.length >= maxBytes ? '\n...[truncated]' : ''),
        data: { url: url.href, contentType },
      };
    } catch (err) {
      return {
        id: '',
        name: 'web_fetch',
        ok: false,
        errorCode: 'network_error',
        content: `web_fetch failed: ${(err as Error).message}`,
      };
    }
  },
};

interface SearchArgs {
  query: string;
  maxResults?: number;
}

export const webSearchTool: Tool<SearchArgs> = {
  definition: {
    name: 'web_search',
    description:
      'Search the web for a query and return result titles, URLs and snippets. ' +
      'Keyless fallback search; may be rate-limited. For deep research prefer web_fetch on known sources.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Max results (default 8)' },
      },
      required: ['query'],
    },
  },
  async run(args: SearchArgs): Promise<ToolResult> {
    try {
      const max = Math.min(args.maxResults ?? 8, 15);
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
        headers: { 'user-agent': USER_AGENT },
      });
      if (!res.ok) return { id: '', name: 'web_search', ok: false, errorCode: `http_${res.status}`, content: `HTTP ${res.status}` };
      const html = await res.text();
      // parse result blocks: <a class="result__a" href="...">title</a> ... <a class="result__snippet">
      const blocks: string[] = [];
      const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(html)) !== null && count < max) {
        const href = m[1] ?? '';
        const title = htmlToText(m[2] ?? '').trim();
        const snippet = m[3] ? htmlToText(m[3]).trim() : '';
        let url = href;
        try {
          const u = new URL(href);
          if (u.hostname === 'duckduckgo.com' && u.searchParams.get('uddg')) {
            url = u.searchParams.get('uddg') ?? href;
          }
        } catch {
          /* keep raw */
        }
        blocks.push(`${title}\n  ${url}\n  ${snippet}`.trim());
        count++;
      }
      if (!blocks.length) {
        return { id: '', name: 'web_search', ok: true, content: 'No results (page may have changed or been rate-limited).' };
      }
      return { id: '', name: 'web_search', ok: true, content: blocks.join('\n\n'), data: { results: blocks } };
    } catch (err) {
      return {
        id: '',
        name: 'web_search',
        ok: false,
        errorCode: 'network_error',
        content: `web_search failed: ${(err as Error).message}`,
      };
    }
  },
};
