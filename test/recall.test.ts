import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { insertClaim, insertTurn, openDb, type Role } from '../src/db.js';
import { recall } from '../src/recall.js';

const NOW = new Date('2026-11-11T10:00:00Z');
const TZ = 'Asia/Kolkata';

function addTurn(
  db: DatabaseSync,
  localDate: string,
  content: string,
  options: { role?: Role; conversationId?: string } = {},
): number {
  return insertTurn(db, {
    conversationId: options.conversationId ?? 'c1',
    role: options.role ?? 'user',
    content,
    createdAt: `${localDate}T10:00:00.000Z`,
    localDate,
    tz: TZ,
  });
}

test('recall: exact date hit includes turns and claims', () => {
  const db = openDb(':memory:');
  const turnId = addTurn(db, '2026-11-03', 'What are the free tier limits of Supabase and Neon?', {
    role: 'assistant',
  });
  insertClaim(db, turnId, {
    subject: 'Supabase free tier',
    claim: 'Supabase free tier includes 500MB.',
    sourceUrl: 'https://supabase.com/pricing',
    sourceTitle: 'Supabase Pricing',
    publishedDate: '2026-11-01',
    fetchedAt: '2026-11-03T10:05:00.000Z',
  });

  const result = recall(db, {
    message: 'what did I ask on 3 November?',
    now: NOW,
    tz: TZ,
    conversationId: 'c1',
  });

  assert.equal(result.dateRefs.length, 1);
  assert.equal(result.dateRefs[0].start, '2026-11-03');
  assert.equal(result.byDate.length, 1);
  assert.equal(result.byDate[0].turns.length, 1);
  assert.equal(result.byDate[0].turns[0].id, turnId);
  assert.equal(result.byDate[0].nearby, null);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].subject, 'Supabase free tier');
});

test('recall: nearby fallback within three days sharing a keyword', () => {
  const db = openDb(':memory:');
  const turnId = addTurn(db, '2026-11-01', 'Supabase free tier limits are 500MB and 2 projects');
  addTurn(db, '2026-10-20', 'Supabase is a database company');

  const result = recall(db, {
    message: 'what did I ask on 3 November about Supabase?',
    now: NOW,
    tz: TZ,
    conversationId: 'c1',
  });

  assert.equal(result.byDate[0].turns.length, 0);
  assert.ok(result.byDate[0].nearby);
  assert.equal(result.byDate[0].nearby.date, '2026-11-01');
  assert.deepEqual(
    result.byDate[0].nearby.turns.map((turn) => turn.id),
    [turnId],
  );
});

test('recall: nearby ignores turns without a shared keyword', () => {
  const db = openDb(':memory:');
  addTurn(db, '2026-11-01', 'Neon pricing is 19 dollars');

  const result = recall(db, {
    message: 'what did I ask on 3 November about Supabase?',
    now: NOW,
    tz: TZ,
    conversationId: 'c1',
  });

  assert.equal(result.byDate[0].turns.length, 0);
  assert.equal(result.byDate[0].nearby, null);
});

test('recall: no record of a date yields empty turns and no nearby', () => {
  const db = openDb(':memory:');

  const result = recall(db, {
    message: 'what did I ask on 3 November?',
    now: NOW,
    tz: TZ,
    conversationId: 'c1',
  });

  assert.equal(result.byDate[0].turns.length, 0);
  assert.equal(result.byDate[0].nearby, null);
  assert.deepEqual(result.dateRefs.map((ref) => ref.start), ['2026-11-03']);
});

test('recall: topical ranks by keyword score then newest first', () => {
  const db = openDb(':memory:');
  const older = addTurn(db, '2026-10-01', 'Neon pricing is 19 dollars per month');
  const middle = addTurn(db, '2026-10-07', 'Neon pricing');
  const best = addTurn(db, '2026-10-05', 'Neon pricing update: 19 dollars and Supabase is 25');

  const result = recall(db, {
    message: 'neon pricing update',
    now: NOW,
    tz: TZ,
    conversationId: 'c1',
  });

  assert.deepEqual(
    result.topical.map((turn) => turn.id),
    [best, middle, older],
  );
});

test('recall: topical caps at six turns', () => {
  const db = openDb(':memory:');
  const ids: number[] = [];
  for (let day = 1; day <= 8; day++) {
    ids.push(addTurn(db, `2026-10-0${day}`, `Neon pricing note ${day}`));
  }

  const result = recall(db, {
    message: 'neon pricing',
    now: NOW,
    tz: TZ,
    conversationId: 'c1',
  });

  assert.equal(result.topical.length, 6);
  assert.deepEqual(
    result.topical.map((turn) => turn.id),
    ids.slice(2).reverse(),
  );
});

test('recall: excludes the in-flight turn from date and recent results', () => {
  const db = openDb(':memory:');
  const inflight = addTurn(db, '2026-11-03', 'what did I ask on 3 November?', {
    conversationId: 'c1',
  });

  const result = recall(db, {
    message: 'what did I ask on 3 November?',
    now: NOW,
    tz: TZ,
    conversationId: 'c1',
    excludeTurnId: inflight,
  });

  assert.equal(result.byDate[0].turns.length, 0);
  assert.equal(result.recent.length, 0);
});

test('recall: excludes the in-flight turn from topical results', () => {
  const db = openDb(':memory:');
  const older = addTurn(db, '2026-11-10', 'Neon pricing was 19 dollars', {
    conversationId: 'c1',
  });
  const inflight = addTurn(db, '2026-11-11', 'Neon pricing now', { conversationId: 'c1' });

  const result = recall(db, {
    message: 'Neon pricing now',
    now: NOW,
    tz: TZ,
    conversationId: 'c1',
    excludeTurnId: inflight,
  });

  assert.ok(!result.topical.some((turn) => turn.id === inflight));
  assert.ok(result.topical.some((turn) => turn.id === older));
  assert.deepEqual(
    result.recent.map((turn) => turn.id),
    [older],
  );
});

test('recall: identical history messages are kept when only the in-flight turn is excluded', () => {
  const db = openDb(':memory:');
  const message = 'Neon pricing on 3 November?';
  const older = addTurn(db, '2026-11-03', message, { conversationId: 'c1' });
  const inflight = addTurn(db, '2026-11-03', message, { conversationId: 'c1' });

  const result = recall(db, {
    message,
    now: NOW,
    tz: TZ,
    conversationId: 'c1',
    excludeTurnId: inflight,
  });

  assert.deepEqual(
    result.byDate[0].turns.map((turn) => turn.id),
    [older],
  );
  assert.deepEqual(
    result.topical.map((turn) => turn.id),
    [older],
  );
  assert.deepEqual(
    result.recent.map((turn) => turn.id),
    [older],
  );
});

test('recall: recent is the last six turns of the conversation, oldest first', () => {
  const db = openDb(':memory:');
  const ids: number[] = [];
  for (let i = 1; i <= 8; i++) {
    ids.push(addTurn(db, `2026-10-0${i}`, `message number ${i}`, { conversationId: 'c1' }));
  }
  addTurn(db, '2026-10-01', 'other conversation', { conversationId: 'c2' });

  const result = recall(db, {
    message: 'hello',
    now: NOW,
    tz: TZ,
    conversationId: 'c1',
  });

  assert.deepEqual(result.recent.map((turn) => turn.id), ids.slice(2));
});