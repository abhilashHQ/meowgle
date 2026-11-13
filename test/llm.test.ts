import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, parseLine } from '../src/llm.ts';

const stream = (event: object) => JSON.stringify({ type: 'stream_event', event });

test('flatten: developer text becomes the system prompt, history a tagged block above the message', () => {
  assert.deepEqual(
    flatten([
      { role: 'developer', content: 'Be MeowGle.' },
      { role: 'user', content: 'neon price?' },
      { role: 'assistant', content: '$19/month.' },
      { role: 'user', content: 'and supabase?' },
    ]),
    {
      system: 'Be MeowGle.',
      prompt:
        '<earlier_chat>\n<person>\nneon price?\n</person>\n<meowgle>\n$19/month.\n</meowgle>\n</earlier_chat>\n\nand supabase?',
    }
  );
  assert.equal(flatten([{ role: 'user', content: 'hi' }]).prompt, 'hi');
});

test('parseLine maps CLI stream-json to text, thinking, tool starts and the result', () => {
  const text = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } };
  const think = { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } };
  const tool = { type: 'content_block_start', content_block: { type: 'tool_use', name: 'x' } };
  const start = { type: 'content_block_start', content_block: { type: 'text', text: '' } };

  assert.deepEqual(parseLine(stream(text)), { kind: 'text', text: 'Hi' });
  assert.deepEqual(parseLine(stream(think)), { kind: 'thinking', text: 'hm' });
  assert.deepEqual(parseLine(stream(tool)), { kind: 'tool' });
  assert.equal(parseLine(stream(start)), null);
  assert.equal(parseLine(JSON.stringify({ type: 'system', subtype: 'init' })), null);
  assert.deepEqual(parseLine(JSON.stringify({ type: 'result', is_error: false })), {
    kind: 'result',
  });
  assert.deepEqual(
    parseLine(JSON.stringify({ type: 'result', is_error: true, result: 'Rate limited' })),
    { kind: 'result', error: 'Rate limited' }
  );
});
