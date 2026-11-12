import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClaimRow } from '../src/db.js';
import type { JsonOptions, LLM, LLMStreamPart, StreamOptions } from '../src/llm/types.js';
import { plan } from '../src/plan.js';
import type { Recall } from '../src/recall.js';

const NOW = new Date('2026-11-11T10:00:00Z');
const TZ = 'Asia/Kolkata';
const MESSAGE = 'What is Supabase pricing?';

class FakeLLM implements LLM {
  calls = 0;

  constructor(private readonly response: unknown | (() => unknown)) {}

  async json<T>(_options: JsonOptions): Promise<T> {
    this.calls += 1;
    const value =
      typeof this.response === 'function' ? (this.response as () => unknown)() : this.response;
    return value as T;
  }

  async *stream(_options: StreamOptions): AsyncGenerator<LLMStreamPart> {
    yield* [];
  }
}

function emptyRecall(overrides: Partial<Recall> = {}): Recall {
  return {
    dateRefs: [],
    byDate: [],
    topical: [],
    recent: [],
    claims: [],
    ...overrides,
  };
}

function claim(id: number): ClaimRow {
  return {
    id,
    turn_id: 1,
    subject: 'Supabase pricing',
    claim: 'Supabase free tier includes 500MB.',
    source_url: 'https://supabase.com/pricing',
    source_title: 'Supabase Pricing',
    published_date: '2026-11-01',
    fetched_at: '2026-11-03T10:00:00.000Z',
  };
}

function input(overrides: Partial<Parameters<typeof plan>[1]> = {}) {
  return {
    message: MESSAGE,
    recall: emptyRecall(),
    now: NOW,
    tz: TZ,
    reasoning: 'medium' as const,
    ...overrides,
  };
}

test('plan: falls back to quick with the raw message on LLM failure', async () => {
  const llm = new FakeLLM(() => {
    throw new Error('boom');
  });

  const result = await plan(llm, input());

  assert.equal(result.level, 'quick');
  assert.deepEqual(result.queries, [MESSAGE]);
  assert.deepEqual(result.recheckClaimIds, []);
  assert.equal(result.objective, MESSAGE);
  assert.ok(result.reason.length > 0);
});

test('plan: falls back when the level is invalid', async () => {
  const llm = new FakeLLM({
    level: 'deep',
    queries: ['x'],
    recheckClaimIds: [],
    objective: 'x',
    reason: 'r',
  });

  const result = await plan(llm, input());

  assert.equal(result.level, 'quick');
  assert.deepEqual(result.queries, [MESSAGE]);
});

test('plan: parses a valid quick plan', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: ['supabase pricing 2026'],
    recheckClaimIds: [1],
    objective: 'exact current pricing from the official page',
    reason: 'needs current pricing',
  });

  const result = await plan(llm, input({ recall: emptyRecall({ claims: [claim(1)] }) }));

  assert.deepEqual(result, {
    level: 'quick',
    queries: ['supabase pricing 2026'],
    recheckClaimIds: [1],
    objective: 'exact current pricing from the official page',
    reason: 'needs current pricing',
  });
});

test('plan: instant clears queries', async () => {
  const llm = new FakeLLM({
    level: 'instant',
    queries: ['should be dropped'],
    recheckClaimIds: [],
    objective: 'chat',
    reason: 'chit chat',
  });

  const result = await plan(llm, input({ message: 'hey' }));

  assert.equal(result.level, 'instant');
  assert.deepEqual(result.queries, []);
});

test('plan: quick with no queries falls back to the message as query', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: [],
    recheckClaimIds: [],
    objective: 'pricing',
    reason: 'needs search',
  });

  const result = await plan(llm, input());

  assert.deepEqual(result.queries, [MESSAGE]);
});

test('plan: forced instant overrides the model and clears queries', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: ['x'],
    recheckClaimIds: [],
    objective: 'x',
    reason: 'needs search',
  });

  const result = await plan(llm, input({ forcedLevel: 'instant' }));

  assert.equal(result.level, 'instant');
  assert.deepEqual(result.queries, []);
});

test('plan: forced quick on an instant plan searches the message', async () => {
  const llm = new FakeLLM({
    level: 'instant',
    queries: [],
    recheckClaimIds: [],
    objective: 'x',
    reason: 'memory only',
  });

  const result = await plan(llm, input({ forcedLevel: 'quick' }));

  assert.equal(result.level, 'quick');
  assert.deepEqual(result.queries, [MESSAGE]);
});

test('plan: drops recheck ids that are not in recalled claims', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: ['supabase pricing'],
    recheckClaimIds: [1, 2, 99],
    objective: 'verify pricing',
    reason: 'verify claims',
  });

  const result = await plan(
    llm,
    input({
      message: 'is that still correct?',
      recall: emptyRecall({ claims: [claim(2)] }),
    }),
  );

  assert.deepEqual(result.recheckClaimIds, [2]);
});

test('plan: high reasoning caps queries at four', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: ['q1', 'q2', 'q3', 'q4', 'q5'],
    recheckClaimIds: [],
    objective: 'x',
    reason: 'needs search',
  });

  const result = await plan(llm, input({ reasoning: 'high' }));

  assert.deepEqual(result.queries, ['q1', 'q2', 'q3', 'q4']);
});

test('plan: low reasoning caps queries at two', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: ['q1', 'q2', 'q3'],
    recheckClaimIds: [],
    objective: 'x',
    reason: 'needs search',
  });

  const result = await plan(llm, input({ reasoning: 'low' }));

  assert.deepEqual(result.queries, ['q1', 'q2']);
});

test('plan: xhigh reasoning allows five queries', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'],
    recheckClaimIds: [],
    objective: 'x',
    reason: 'needs search',
  });

  const result = await plan(llm, input({ reasoning: 'xhigh' }));

  assert.deepEqual(result.queries, ['q1', 'q2', 'q3', 'q4', 'q5']);
});
