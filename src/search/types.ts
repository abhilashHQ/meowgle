export type Source = {
  id: string;
  url: string;
  title: string;
  publishedDate: string | null;
  excerpt: string;
  query: string;
  fetchedAt: string;
};

export type SearchMode = 'auto' | 'lite' | 'deep-lite' | 'deep';

export type SearchOptions = {
  numResults: number;
  fresh: boolean;
  signal: AbortSignal;
  type?: SearchMode;
  objective?: string;
  highlightQuery?: string;
  includeText?: boolean;
  maxTextChars?: number;
  maxAgeHours?: number;
};

export type RawSource = Omit<Source, 'id' | 'query' | 'fetchedAt'>;

export class SearchProviderError extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'SearchProviderError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface SearchProvider {
  search(query: string, o: SearchOptions): Promise<RawSource[]>;
}
