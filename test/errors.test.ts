import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../src/errors.js';

test('friendlyError: unwraps nested JSON quota errors', () => {
  const inner = JSON.stringify({
    error: {
      code: 429,
      message:
        'You exceeded your current quota, please check your plan and billing details.',
      status: 'RESOURCE_EXHAUSTED',
    },
  });
  const outer = JSON.stringify({ error: { code: 429, message: inner } });

  assert.equal(friendlyError(new Error(outer)), 'Gemini quota is used up for now');
});

test('friendlyError: maps overload and network failures', () => {
  assert.equal(
    friendlyError(new Error('This model is currently experiencing high demand.')),
    'Gemini is overloaded right now',
  );
  assert.equal(friendlyError(new Error('fetch failed')), 'could not reach Gemini');
  assert.equal(
    friendlyError(new Error('This operation was aborted')),
    'the model took too long to respond',
  );
});
