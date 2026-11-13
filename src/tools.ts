import { domain, type Source } from './memory.ts';

export type Book = Map<string, Source & { opened: boolean; text: string }>;
export type ToolResult = { text: string; ok: number; failed: number; domains: string[] };
export type Tools = {
  webSearch(args: { queries: string[]; since?: string }, book: Book): Promise<ToolResult>;
  openPage(args: { urls: string[]; focus?: string }, book: Book, live: boolean): Promise<ToolResult>;
};

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Pass every independent lookup as its own query in one call; they run in parallel. Returns numbered results with excerpts.',
      parameters: {
        type: 'object',
        properties: {
          queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
          since: { type: 'string', description: 'YYYY-MM-DD. Only for news or changes after a point in time ("this week", "since Monday"). It hides everything published earlier, including profiles, docs and pricing pages, so leave it out for normal lookups.' },
        },
        required: ['queries'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_page',
      description: 'Read pages in full, or just the parts about `focus`. Use when search excerpts lack the exact figure, or to re-check a page from the ledger.',
      parameters: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
          focus: { type: 'string', description: 'What to pull out, e.g. "Pro plan monthly price per user"' },
        },
        required: ['urls'],
      },
    },
  },
];

function addSource(book: Book, url: string, title: string, opened: boolean, text: string): Source {
  let s = book.get(url);
  if (!s) {
    s = { n: book.size + 1, url, title: title || domain(url), fetched_at: new Date().toISOString(), opened, text: '' };
    book.set(url, s);
  }
  if (opened) s.opened = true;
  s.text += `\n${text}`;
  return s;
}

async function exa(path: string, body: object, key: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`https://api.exa.ai${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      if (attempt === 0) continue;
      throw e;
    }
    if (res.ok) return res.json();
    if (res.status >= 500 && attempt === 0) continue;
    throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export function makeExaTools(key: string): Tools {
  return {
    async webSearch({ queries, since }, book) {
      const settled = await Promise.allSettled(queries.map((query) => exa('/search', {
        query,
        type: 'lite',
        numResults: 6,
        contents: { highlights: true },
        ...(since ? { startPublishedDate: `${since}T00:00:00.000Z` } : {}),
      }, key)));

      const seen = new Set<string>();
      const blocks: string[] = [];
      const errors: string[] = [];
      settled.forEach((r, i) => {
        if (r.status === 'rejected') return errors.push(`Search "${queries[i]}" failed: ${(r.reason as Error).message}`);
        for (const hit of r.value.results ?? []) {
          if (seen.has(hit.url)) continue;
          seen.add(hit.url);
          const excerpt = (hit.highlights ?? []).join(' … ');
          const s = addSource(book, hit.url, hit.title, false, excerpt);
          const date = hit.publishedDate ? `published ${hit.publishedDate.slice(0, 10)}` : 'no publish date';
          blocks.push(`[${s.n}] ${s.title}\n${hit.url} (${date})\n${excerpt}`);
        }
      });
      const text = [...blocks, ...errors].join('\n\n') || 'No results.';
      return { text, ok: seen.size, failed: errors.length, domains: [...new Set([...seen].map(domain))] };
    },

    async openPage({ urls, focus }, book, live) {
      let res: any;
      try {
        res = await exa('/contents', {
          urls,
          ...(focus ? { highlights: { query: focus, maxCharacters: 800 } } : { text: { maxCharacters: 6000 } }),
          ...(live ? { maxAgeHours: 0 } : {}),
        }, key);
      } catch (e) {
        return { text: `open_page failed: ${(e as Error).message}`, ok: 0, failed: urls.length, domains: [] };
      }

      const pages = new Map<string, any>((res.results ?? []).map((p: any) => [p.id ?? p.url, p]));
      const blocks: string[] = [];
      let ok = 0;
      for (const st of res.statuses ?? urls.map((id) => ({ id, status: 'success' }))) {
        const page = pages.get(st.id);
        if (st.status !== 'success' || !page) {
          blocks.push(`FAILED: ${st.id} (${st.error?.tag ?? 'no content'})`);
          continue;
        }
        ok++;
        const body = focus ? (page.highlights ?? []).join(' … ') : page.text ?? '';
        const s = addSource(book, page.url ?? st.id, page.title, true, body);
        const how = st.source === 'crawled' ? 'live' : 'cached copy';
        const date = page.publishedDate ? `published ${page.publishedDate.slice(0, 10)}` : 'no publish date';
        blocks.push(`[${s.n}] ${s.title}\n${s.url} (${date}, ${how})\n${body}`);
      }
      return { text: blocks.join('\n\n'), ok, failed: urls.length - ok, domains: [] };
    },
  };
}
