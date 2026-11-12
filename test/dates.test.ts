import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDates } from '../src/dates.js';

const NOW = new Date('2026-11-11T10:00:00Z');
const TZ = 'Asia/Kolkata';

function spans(text: string, now: Date = NOW, tz: string = TZ): string[] {
  return resolveDates(text, now, tz).map((ref) => `${ref.start}..${ref.end}`);
}

test('resolveDates: last Tuesday', () => {
  assert.deepEqual(spans('last Tuesday'), ['2026-11-10..2026-11-10']);
});

test('resolveDates: On Monday is case insensitive', () => {
  assert.deepEqual(spans('On Monday'), ['2026-11-09..2026-11-09']);
  assert.deepEqual(spans('On MONDAY'), ['2026-11-09..2026-11-09']);
});

test('resolveDates: 3 November', () => {
  assert.deepEqual(spans('3 November'), ['2026-11-03..2026-11-03']);
});

test('resolveDates: December 25 falls back to last year', () => {
  assert.deepEqual(spans('December 25'), ['2025-12-25..2025-12-25']);
});

test('resolveDates: yesterday', () => {
  assert.deepEqual(spans('yesterday'), ['2026-11-10..2026-11-10']);
});

test('resolveDates: last week range', () => {
  assert.deepEqual(spans('last week'), ['2026-11-02..2026-11-08']);
});

test('resolveDates: this week range', () => {
  assert.deepEqual(spans('this week'), ['2026-11-09..2026-11-11']);
});

test('resolveDates: today', () => {
  assert.deepEqual(spans('today'), ['2026-11-11..2026-11-11']);
});

test('resolveDates: nothing matches', () => {
  assert.deepEqual(spans('hello'), []);
});

test('resolveDates: bare weekday is strictly before today', () => {
  assert.deepEqual(spans('Tuesday'), ['2026-11-10..2026-11-10']);
  assert.deepEqual(spans('Wednesday'), ['2026-11-04..2026-11-04']);
});

test('resolveDates: numeric days ago', () => {
  assert.deepEqual(spans('2 days ago'), ['2026-11-09..2026-11-09']);
  assert.deepEqual(spans('1 day ago'), ['2026-11-10..2026-11-10']);
});

test('resolveDates: date formats', () => {
  assert.deepEqual(spans('2026-11-03'), ['2026-11-03..2026-11-03']);
  assert.deepEqual(spans('3 Nov 2026'), ['2026-11-03..2026-11-03']);
  assert.deepEqual(spans('3rd Nov'), ['2026-11-03..2026-11-03']);
  assert.deepEqual(spans('Nov 3'), ['2026-11-03..2026-11-03']);
  assert.deepEqual(spans('November 3rd, 2026'), ['2026-11-03..2026-11-03']);
});

test('resolveDates: explicit future year is kept', () => {
  assert.deepEqual(spans('3 Nov 2027'), ['2027-11-03..2027-11-03']);
});

test('resolveDates: phrase is the matched text', () => {
  const refs = resolveDates('what did I ask on 3 November?', NOW, TZ);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].phrase, '3 November');
});

test('resolveDates: timezone edge, 20:00Z is the next day in Asia/Kolkata', () => {
  const lateNow = new Date('2026-11-11T20:00:00Z');
  assert.deepEqual(spans('today', lateNow), ['2026-11-12..2026-11-12']);
  assert.deepEqual(spans('yesterday', lateNow), ['2026-11-11..2026-11-11']);
  assert.deepEqual(spans('Wednesday', lateNow), ['2026-11-11..2026-11-11']);
  assert.deepEqual(spans('last week', lateNow), ['2026-11-02..2026-11-08']);
});