import test from 'node:test';
import assert from 'node:assert/strict';
import { extractKeywords } from '../src/keywords.js';

test('extractKeywords: drops stopwords and date words', () => {
  assert.deepEqual(extractKeywords('What did I ask you about Supabase pricing on 3 Nov?'), [
    'supabase',
    'pricing',
  ]);
});

test('extractKeywords: lowercases and dedupes in order', () => {
  assert.deepEqual(extractKeywords('Neon neon Postgres NEON'), ['neon', 'postgres']);
});

test('extractKeywords: drops words shorter than 3 characters', () => {
  assert.deepEqual(extractKeywords('AI is ok at it'), []);
});

test('extractKeywords: splits on non alphanumerics', () => {
  assert.deepEqual(extractKeywords('Supabase-pricing, Neon; RDS_vs_Aurora'), [
    'supabase',
    'pricing',
    'neon',
    'rds',
    'aurora',
  ]);
});

test('extractKeywords: date words alone produce nothing', () => {
  assert.deepEqual(
    extractKeywords('today Yesterday Monday November week ago asked last Sunday Sept'),
    [],
  );
});