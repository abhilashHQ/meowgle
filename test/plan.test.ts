import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClaimRow } from '../src/db.js';
import type { LLM } from '../src/llm/types.js';
import { plan } from '../src/plan.js';
import type { Recall } from '../src/recall.js';

const NOW = new Date('2026-11-11T10:00:00Z');
const TZ = 'Asia/Kolkata';
const MESSAGE = 'What is Supabase pricing?';

class FakeLLM implements LLM {
  calls = 0;

  constructor(private readonly response: unknown | (() => unknown)) {}

  async json<T>(_options: {
    model: 'fast' | 'main';
    system: string;
    prompt: string;
    schema: object;
  }): Promise<T> {
    this.calls += 1;
    const value =
      typeof this.response === 'function' ? (this.response as () => unknown)() : this.response;
    return value as T;
  }

  async *stream(): AsyncGenerator<string> {}
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

test('plan: falls back to quick with the raw message on LLM failure', async () => {
  const llm = new FakeLLM(() => {
    throw new Error('boom');
  });

  const result = await plan(llm, {
    message: MESSAGE,
    recall: emptyRecall(),
    now: NOW,
    tz: TZ,
  });

  assert.equal(result.level, 'quick');
  assert.deepEqual(result.queries, [MESSAGE]);
  assert.deepEqual(result.recheckClaimIds, []);
  assert.ok(result.reason.length > 0);
});

test('plan: falls back when the level is invalid', async () => {
  const llm = new FakeLLM({ level: 'deep', queries: ['x'], recheckClaimIds: [], reason: 'r' });

  const result = await plan(llm, {
    message: MESSAGE,
    recall: emptyRecall(),
    now: NOW,
    tz: TZ,
  });

  assert.equal(result.level, 'quick');
  assert.deepEqual(result.queries, [MESSAGE]);
});

test('plan: parses a valid quick plan', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: ['supabase pricing 2026'],
    recheckClaimIds: [1],
    reason: 'needs current pricing',
  });

  const result = await plan(llm, {
    message: MESSAGE,
    recall: emptyRecall({ claims: [claim(1)] }),
    now: NOW,
    tz: TZ,
  });

  assert.deepEqual(result, {
    level: 'quick',
    queries: ['supabase pricing 2026'],
    recheckClaimIds: [1],
    reason: 'needs current pricing',
  });
});

test('plan: instant clears queries', async () => {
  const llm = new FakeLLM({
    level: 'instant',
    queries: ['should be dropped'],
    recheckClaimIds: [],
    reason: 'chit chat',
  });

  const result = await plan(llm, {
    message: 'hey',
    recall: emptyRecall(),
    now: NOW,
    tz: TZ,
  });

  assert.equal(result.level, 'instant');
  assert.deepEqual(result.queries, []);
});

test('plan: quick with no queries falls back to the message as query', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: [],
    recheckClaimIds: [],
    reason: 'needs search',
  });

  const result = await plan(llm, {
    message: MESSAGE,
    recall: emptyRecall(),
    now: NOW,
    tz: TZ,
  });

  assert.deepEqual(result.queries, [MESSAGE]);
});

test('plan: forced instant overrides the model and clears queries', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: ['x'],
    recheckClaimIds: [],
    reason: 'needs search',
  });

  const result = await plan(llm, {
    message: MESSAGE,
    recall: emptyRecall(),
    now: NOW,
    tz: TZ,
    forcedLevel: 'instant',
  });

  assert.equal(result.level, 'instant');
  assert.deepEqual(result.queries, []);
});

test('plan: forced quick on an instant plan searches the message', async () => {
  const llm = new FakeLLM({
    level: 'instant',
    queries: [],
    recheckClaimIds: [],
    reason: 'memory only',
  });

  const result = await plan(llm, {
    message: MESSAGE,
    recall: emptyRecall(),
    now: NOW,
    tz: TZ,
    forcedLevel: 'quick',
  });

  assert.equal(result.level, 'quick');
  assert.deepEqual(result.queries, [MESSAGE]);
});

test('plan: drops recheck ids that are not in recalled claims', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: ['supabase pricing'],
    recheckClaimIds: [1, 2, 99],
    reason: 'verify claims',
  });

  const result = await plan(llm, {
    message: 'is that still correct?',
    recall: emptyRecall({ claims: [claim(2)] }),
    now: NOW,
    tz: TZ,
  });

  assert.deepEqual(result.recheckClaimIds, [2]);
});

test('plan: caps queries at four', async () => {
  const llm = new FakeLLM({
    level: 'quick',
    queries: ['q1', 'q2', 'q3', 'q4', 'q5'],
    recheckClaimIds: [],
    reason: 'needs search',
  });

  const result = await plan(llm, {
    message: MESSAGE,
    recall: emptyRecall(),
    now: NOW,
    tz: TZ,
  });

  assert.deepEqual(result.queries, ['q1', 'q2', 'q3', 'q4']);
});