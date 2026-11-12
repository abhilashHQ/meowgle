import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCitations } from '../src/citations.js';

const SOURCES = [{ id: 'S1' }, { id: 'S2' }];

test('checkCitations: separates valid and invalid markers', () => {
  const result = checkCitations('Price is 10 dollars [S1]. Old answer [S2]. Made up [S9].', SOURCES);
  assert.deepEqual(result.valid, ['S1', 'S2']);
  assert.deepEqual(result.invalid, ['S9']);
});

test('checkCitations: stays empty without markers', () => {
  assert.deepEqual(checkCitations('No citations here.', SOURCES), { valid: [], invalid: [] });
});

test('checkCitations: dedupes repeated markers', () => {
  const result = checkCitations('A [S1] B [S1] C [S7] D [S7]', SOURCES);
  assert.deepEqual(result.valid, ['S1']);
  assert.deepEqual(result.invalid, ['S7']);
});

test('checkCitations: every marker is invalid when there are no sources', () => {
  const result = checkCitations('Claim [S1].', []);
  assert.deepEqual(result.valid, []);
  assert.deepEqual(result.invalid, ['S1']);
});
test('checkCitations: splits grouped markers like [S2, S4]', () => {
  const result = checkCitations('A [S2, S4]. B [S1,S9].', [{ id: 'S1' }, { id: 'S2' }, { id: 'S4' }]);
  assert.deepEqual(result, { valid: ['S2', 'S4', 'S1'], invalid: ['S9'] });
});
