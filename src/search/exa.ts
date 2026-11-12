import {
  SearchProviderError,
  type RawSource,
  type SearchProvider,
} from './types.js';

type ExaResult = {
  url?: string;
  title?: string | null;
  publishedDate?: string | null;
  highlights?: string[];
  text?: string;
};

type ExaResponse = {
  requestId?: string;
  results?: ExaResult[];
  warnings?: { field?: string; message?: string }[];
  notices?: string[];
};

function retryAfterMsOf(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function createExaSearch(apiKey: string): SearchProvider {
  return {
    async search(query, o) {
      const contents: Record<string, unknown> = {
        highlights: {
          ...(o.highlightQuery ? { query: o.highlightQuery } : {}),
          maxCharacters: 1500,
        },
        maxAgeHours: o.maxAgeHours ?? (o.fresh ? 0 : 24),
      };
      if (o.includeText) {
        contents.text = {
          maxCharacters: o.maxTextChars ?? 6000,
          verbosity: 'compact',
        };
      }

      const response = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        signal: o.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          query,
          type: o.type ?? 'auto',
          numResults: o.numResults,
          contents,
          ...(o.objective ? { objective: o.objective } : {}),
          moderation: false,
        }),
      });

      if (!response.ok) {
        let detail = `status ${response.status}`;
        let tag = '';
        try {
          const payload = (await response.json()) as { error?: string; tag?: string };
          if (payload.error) detail = payload.error;
          if (payload.tag) tag = ` (${payload.tag})`;
        } catch {
          // Keep the status-based message when the body is not JSON.
        }
        throw new SearchProviderError(
          `Exa ${response.status}: ${detail}${tag}`,
          response.status,
          retryAfterMsOf(response),
        );
      }

      const data = (await response.json()) as ExaResponse;
      if (data.warnings?.length) {
        console.warn(
          `exa warnings for "${query}": ${data.warnings
            .map((warning) => warning.message ?? warning.field ?? 'unknown')
            .join('; ')}`,
        );
      }

      const results: RawSource[] = [];
      for (const result of data.results ?? []) {
        if (!result.url) continue;
        const highlights = (result.highlights ?? []).join(' ').trim();
        const text = typeof result.text === 'string' ? result.text.trim() : '';
        const excerpt = (highlights || text).slice(0, o.includeText ? 4000 : 2000);
        results.push({
          url: result.url,
          title: result.title ?? result.url,
          publishedDate: result.publishedDate ?? null,
          excerpt,
        });
      }
      return results;
    },
  };
}
