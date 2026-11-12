import type { SearchProvider, Source } from './types.js';

type ExaResult = {
  url?: string;
  title?: string | null;
  publishedDate?: string | null;
  highlights?: string[];
};

type ExaResponse = {
  results?: ExaResult[];
};

export function createExaSearch(apiKey: string): SearchProvider {
  return {
    async search(query, o) {
      const response = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        signal: o.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          query,
          type: 'auto',
          numResults: o.numResults,
          contents: {
            highlights: { numSentences: 4, highlightsPerUrl: 3 },
            livecrawl: o.fresh ? 'preferred' : 'fallback',
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`Exa search failed with status ${response.status}`);
      }
      const data = (await response.json()) as ExaResponse;
      const results: Omit<Source, 'id' | 'query' | 'fetchedAt'>[] = [];
      for (const result of data.results ?? []) {
        if (!result.url) continue;
        results.push({
          url: result.url,
          title: result.title ?? result.url,
          publishedDate: result.publishedDate ?? null,
          excerpt: (result.highlights ?? []).join(' ').slice(0, 1500),
        });
      }
      return results;
    },
  };
}