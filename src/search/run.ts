import {
  SearchProviderError,
  type RawSource,
  type SearchMode,
  type SearchProvider,
  type Source,
} from './types.js';

export type SearchResult = {
  sources: Source[];
  error?: string;
};

export type RunSearchOptions = {
  fresh: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  type?: SearchMode;
  objective?: string;
  includeText?: boolean;
  maxAgeHours?: number;
  maxSources?: number;
  maxPerDomain?: number;
  numResults?: number;
  existingSources?: Source[];
};

type QueryOutcome =
  | { query: string; results: RawSource[] }
  | { query: string; error: string };

const DEFAULT_TIMEOUT_MS = 15000;
const RESULTS_PER_QUERY = 8;
const MAX_SOURCES = 6;
const MAX_ATTEMPTS = 2;
const RETRY_BASE_MS = 150;

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof SearchProviderError && error.status !== undefined) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error && /timed out/i.test(error.message)) return false;
  if (error instanceof Error && error.name === 'AbortError') return false;
  return true;
}

function retryDelayMs(error: unknown, attempt: number): number {
  if (error instanceof SearchProviderError && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, 2000);
  }
  const backoff = RETRY_BASE_MS * 2 ** attempt;
  return backoff + Math.floor(Math.random() * 100);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function attemptSearch(
  provider: SearchProvider,
  query: string,
  options: RunSearchOptions,
  timeoutMs: number,
): Promise<RawSource[]> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', forwardAbort, { once: true });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', forwardAbort);
      action();
    };
    timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new Error(`search timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    provider
      .search(query, {
        numResults: options.numResults ?? RESULTS_PER_QUERY,
        fresh: options.fresh,
        signal: controller.signal,
        type: options.type,
        objective: options.objective,
        includeText: options.includeText,
        maxAgeHours: options.maxAgeHours,
        highlightQuery: query,
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
  options: RunSearchOptions,
  timeoutMs: number,
): Promise<QueryOutcome> {
  let lastError: unknown = new Error('search failed');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const results = await attemptSearch(provider, query, options, timeoutMs);
      return { query, results };
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS - 1) break;
      await sleep(retryDelayMs(error, attempt), options.signal);
    }
  }
  return {
    query,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

function mergeInto(
  merged: Source[],
  lists: { query: string; results: RawSource[] }[],
  fetchedAt: string,
  maxSources: number,
  maxPerDomain: number,
): Source[] {
  const seenUrls = new Set(merged.map((source) => source.url));
  const domainCounts = new Map<string, number>();
  for (const source of merged) {
    const domain = domainOf(source.url);
    if (domain) domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
  }

  const depth = Math.max(0, ...lists.map((list) => list.results.length));
  for (let rank = 0; rank < depth && merged.length < maxSources; rank++) {
    for (const list of lists) {
      if (merged.length >= maxSources) break;
      const result = list.results[rank];
      if (!result?.url || seenUrls.has(result.url)) continue;
      const domain = domainOf(result.url);
      if (domain !== null) {
        const count = domainCounts.get(domain) ?? 0;
        if (count >= maxPerDomain) continue;
        domainCounts.set(domain, count + 1);
      }
      seenUrls.add(result.url);
      merged.push({
        ...result,
        id: `S${merged.length + 1}`,
        query: list.query,
        fetchedAt,
      });
    }
  }
  return merged;
}

export async function runSearch(
  provider: SearchProvider,
  queries: string[],
  options: RunSearchOptions,
): Promise<SearchResult> {
  const existing = options.existingSources ?? [];
  if (queries.length === 0) return { sources: existing };

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSources = options.maxSources ?? MAX_SOURCES;
  const maxPerDomain = options.maxPerDomain ?? 1;
  const fetchedAt = new Date().toISOString();

  const outcomes = await Promise.all(
    queries.map((query) => searchWithRetry(provider, query, options, timeoutMs)),
  );

  const lists = outcomes.flatMap((outcome) =>
    'results' in outcome ? [{ query: outcome.query, results: outcome.results }] : [],
  );
  const sources = mergeInto([...existing], lists, fetchedAt, maxSources, maxPerDomain);

  const errors = outcomes
    .filter((outcome): outcome is { query: string; error: string } => 'error' in outcome)
    .map((outcome) => `${outcome.query}: ${outcome.error}`);

  if (sources.length === 0) {
    return { sources: [], error: errors.join('; ') || 'no results' };
  }
  return { sources };
}
