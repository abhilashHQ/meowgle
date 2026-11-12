import type { SearchProvider, Source } from './types.js';

export type SearchResult = {
  sources: Source[];
  error?: string;
};

export type RunSearchOptions = {
  fresh: boolean;
  timeoutMs?: number;
};

type RawResult = Omit<Source, 'id' | 'query' | 'fetchedAt'>;

type QueryOutcome =
  | { query: string; results: RawResult[] }
  | { query: string; error: string };

const DEFAULT_TIMEOUT_MS = 8000;
const RESULTS_PER_QUERY = 8;
const MAX_SOURCES = 6;

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}


function attemptSearch(
  provider: SearchProvider,
  query: string,
  fresh: boolean,
  timeoutMs: number,
): Promise<RawResult[]> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      action();
    };
    timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new Error(`search timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    provider
      .search(query, {
        numResults: RESULTS_PER_QUERY,
        fresh,
        signal: controller.signal,
      })
      .then(
        (results) => finish(() => resolve(results)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

async function searchWithRetry(
  provider: SearchProvider,
  query: string,
  fresh: boolean,
  timeoutMs: number,
): Promise<QueryOutcome> {
  let lastError = '';
  for (let i = 0; i < 2; i++) {
    try {
      const results = await attemptSearch(provider, query, fresh, timeoutMs);
      return { query, results };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { query, error: lastError };
}

export async function runSearch(
  provider: SearchProvider,
  queries: string[],
  options: RunSearchOptions,
): Promise<SearchResult> {
  if (queries.length === 0) return { sources: [] };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchedAt = new Date().toISOString();

  const outcomes = await Promise.all(
    queries.map((query) => searchWithRetry(provider, query, options.fresh, timeoutMs)),
  );

  const errors = outcomes
    .filter((outcome): outcome is { query: string; error: string } => 'error' in outcome)
    .map((outcome) => `${outcome.query}: ${outcome.error}`);

  if (errors.length === outcomes.length) {
    return { sources: [], error: errors.join('; ') };
  }

  // Interleave by rank (every query's #1, then every #2, ...) so one query's
  // results can't crowd out the others. Provider relevance order is kept;
  // recency is left to the model, which sees each source's published date.
  const lists = outcomes.flatMap((outcome) => ('results' in outcome ? [outcome] : []));
  const merged: Source[] = [];
  const seenUrls = new Set<string>();
  const seenDomains = new Set<string>();
  const depth = Math.max(0, ...lists.map((list) => list.results.length));
  for (let rank = 0; rank < depth && merged.length < MAX_SOURCES; rank++) {
    for (const list of lists) {
      if (merged.length >= MAX_SOURCES) break;
      const result = list.results[rank];
      if (!result?.url || seenUrls.has(result.url)) continue;
      const domain = domainOf(result.url);
      if (domain !== null) {
        if (seenDomains.has(domain)) continue;
        seenDomains.add(domain);
      }
      seenUrls.add(result.url);
      merged.push({ ...result, id: '', query: list.query, fetchedAt });
    }
  }

  const sources = merged.map((source, index) => ({ ...source, id: `S${index + 1}` }));

  return { sources };
}