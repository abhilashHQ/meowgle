import test from 'node:test';
import assert from 'node:assert/strict';
import type { Source } from '../src/search/types.js';
import type { SearchProvider } from '../src/search/types.js';
import { runSearch } from '../src/search/run.js';

type RawResult = Omit<Source, 'id' | 'query' | 'fetchedAt'>;

function result(url: string, publishedDate: string | null = null): RawResult {
  return { url, title: `Title ${url}`, publishedDate, excerpt: `Excerpt ${url}` };
}

class FakeSearch implements SearchProvider {
  readonly calls: { query: string; numResults: number; fresh: boolean }[] = [];
  readonly signals: AbortSignal[] = [];
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly handler: (query: string, attempt: number) => Promise<RawResult[]>,
  ) {}

  async search(
    query: string,
    options: { numResults: number; fresh: boolean; signal: AbortSignal },
  ) {
    this.calls.push({ query, numResults: options.numResults, fresh: options.fresh });
    this.signals.push(options.signal);
    const attempt = (this.attempts.get(query) ?? 0) + 1;
    this.attempts.set(query, attempt);
    return this.handler(query, attempt);
  }
}

test('runSearch: dedupes by url across queries', async () => {
  const provider = new FakeSearch(async (query) =>
    query === 'a'
      ? [result('https://one.com/x', '2026-01-01'), result('https://two.com/y', '2026-01-02')]
      : [result('https://one.com/x', '2026-01-01'), result('https://three.com/z', '2026-01-03')],
  );

  const { sources } = await runSearch(provider, ['a', 'b'], { fresh: false });

  assert.deepEqual(
    sources.map((source) => source.url),
    ['https://one.com/x', 'https://two.com/y', 'https://three.com/z'],
  );
  assert.deepEqual(
    sources.map((source) => source.id),
    ['S1', 'S2', 'S3'],
  );
  assert.equal(new Set(sources.map((source) => source.url)).size, sources.length);
});

test('runSearch: keeps at most one result per domain', async () => {
  const provider = new FakeSearch(async () => [
    result('https://example.com/a', '2026-01-03'),
    result('https://example.com/b', '2026-01-02'),
    result('https://www.example.com/c', '2026-01-01'),
    result('https://other.com/d', '2026-01-01'),
  ]);

  const { sources } = await runSearch(provider, ['q'], { fresh: false });

  assert.deepEqual(
    sources.map((source) => source.url),
    ['https://example.com/a', 'https://other.com/d'],
  );
});

test('runSearch: interleaves queries by rank so no query is starved', async () => {
  const provider = new FakeSearch(async (query) =>
    query === 'a'
      ? [result('https://a1.com/x', '2026-06-01'), result('https://a2.com/x', '2026-06-01'), result('https://a3.com/x', '2026-06-01'), result('https://a4.com/x', '2026-06-01')]
      : [result('https://b1.com/x', null), result('https://b2.com/x', null)],
  );

  const { sources } = await runSearch(provider, ['a', 'b'], { fresh: false });

  assert.deepEqual(
    sources.map((source) => new URL(source.url).hostname),
    ['a1.com', 'b1.com', 'a2.com', 'b2.com', 'a3.com', 'a4.com'],
  );
});

test('runSearch: caps results at six', async () => {
  const provider = new FakeSearch(async () =>
    Array.from({ length: 8 }, (_, index) =>
      result(`https://site${index}.com/page`, `2026-01-0${index + 1}`),
    ),
  );

  const { sources } = await runSearch(provider, ['q'], { fresh: false });

  assert.equal(sources.length, 6);
  assert.deepEqual(
    sources.map((source) => source.id),
    ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'],
  );
});

test('runSearch: times out and retries once', async () => {
  const provider = new FakeSearch(async (_query, attempt) => {
    if (attempt === 1) return new Promise<RawResult[]>(() => {});
    return [result('https://retry.com/page', '2026-02-01')];
  });

  const { sources, error } = await runSearch(provider, ['q'], {
    fresh: false,
    timeoutMs: 20,
  });

  assert.equal(provider.calls.length, 2);
  assert.equal(error, undefined);
  assert.deepEqual(
    sources.map((source) => source.url),
    ['https://retry.com/page'],
  );
});

test('runSearch: aborts the signal when a provider hangs past the timeout', async () => {
  const provider = new FakeSearch(async () => new Promise<RawResult[]>(() => {}));

  const { sources, error } = await runSearch(provider, ['q'], {
    fresh: false,
    timeoutMs: 20,
  });

  assert.deepEqual(sources, []);
  assert.ok(error);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.signals.length, 2);
  assert.equal(provider.signals[0].aborted, true);
  assert.equal(provider.signals[1].aborted, true);
});

test('runSearch: returns an error only when every query fails', async () => {
  const provider = new FakeSearch(async () => {
    throw new Error('boom');
  });

  const { sources, error } = await runSearch(provider, ['first', 'second'], {
    fresh: false,
    timeoutMs: 20,
  });

  assert.deepEqual(sources, []);
  assert.ok(error);
  assert.match(error, /first/);
  assert.match(error, /second/);
  assert.equal(provider.calls.length, 4);
});

test('runSearch: keeps partial results when only one query fails', async () => {
  const provider = new FakeSearch(async (query) => {
    if (query === 'bad') throw new Error('nope');
    return [result('https://good.com/page', '2026-01-01')];
  });

  const { sources, error } = await runSearch(provider, ['bad', 'good'], {
    fresh: false,
    timeoutMs: 20,
  });

  assert.equal(error, undefined);
  assert.deepEqual(
    sources.map((source) => source.url),
    ['https://good.com/page'],
  );
});

test('runSearch: passes fresh and result count to the provider', async () => {
  const provider = new FakeSearch(async () => []);

  await runSearch(provider, ['q'], { fresh: true });

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].fresh, true);
  assert.equal(provider.calls[0].numResults, 8);
});

test('runSearch: no queries means no provider calls', async () => {
  const provider = new FakeSearch(async () => []);

  const { sources } = await runSearch(provider, [], { fresh: false });

  assert.deepEqual(sources, []);
  assert.equal(provider.calls.length, 0);
});