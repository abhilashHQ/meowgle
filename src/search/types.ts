export type Source = {
  id: string;
  url: string;
  title: string;
  publishedDate: string | null;
  excerpt: string;
  query: string;
  fetchedAt: string;
};

export interface SearchProvider {
  search(
    query: string,
    o: { numResults: number; fresh: boolean; signal: AbortSignal },
  ): Promise<Omit<Source, 'id' | 'query' | 'fetchedAt'>[]>;
}
