import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningSplitter, parseStream, type Chunk } from '../src/llm.ts';

function joined(chunks: Chunk[]) {
  const out = { reasoning: '', content: '' };
  for (const c of chunks) if (c.kind !== 'tools') out[c.kind] += c.text;
  return out;
}

test('reasoning tags are stripped even when split across chunks', () => {
  const s = reasoningSplitter();
  const pieces = ['<reas', 'oning>Need to se', 'arch.</reaso', 'ning>Neon is $19', '/month. a < b <re'];
  const chunks = [...pieces.flatMap((p) => s.push(p)), ...s.flush()];
  assert.deepEqual(joined(chunks), { reasoning: 'Need to search.', content: 'Neon is $19/month. a < b <re' });
});

function sse(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = lines.map((l) => `data: ${l}\n\n`).join('');
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < text.length; i += 7) c.enqueue(enc.encode(text.slice(i, i + 7)));
      c.close();
    },
  });
}

const delta = (d: object) => JSON.stringify({ choices: [{ delta: d }] });

test('parseStream yields reasoning, content and accumulated tool calls', async () => {
  const chunks: Chunk[] = [];
  for await (const c of parseStream(sse([
    delta({ content: '<reasoning>plan</reasoning>' }),
    delta({ reasoning_content: ' more' }),
    delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"queries":' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '["neon pricing"]}' } }] }),
    '[DONE]',
  ]))) chunks.push(c);
  assert.deepEqual(joined(chunks), { reasoning: 'plan more', content: '' });
  assert.deepEqual(chunks.at(-1), {
    kind: 'tools',
    calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"queries":["neon pricing"]}' } }],
  });
});

test('parseStream separates index-less parallel calls and keeps provider extra_content', async () => {
  const sig = { google: { thought_signature: 'abc' } };
  const chunks: Chunk[] = [];
  for await (const c of parseStream(sse([
    delta({ tool_calls: [{ extra_content: sig, id: 'call_a', type: 'function', function: { name: 'web_search', arguments: '{"queries":["x"]}' } }] }),
    delta({ tool_calls: [{ id: 'call_b', type: 'function', function: { name: 'open_page', arguments: '{"urls":["https://a.b"]}' } }] }),
    '[DONE]',
  ]))) chunks.push(c);
  assert.deepEqual(chunks.at(-1), {
    kind: 'tools',
    calls: [
      { id: 'call_a', type: 'function', function: { name: 'web_search', arguments: '{"queries":["x"]}' }, extra_content: sig },
      { id: 'call_b', type: 'function', function: { name: 'open_page', arguments: '{"urls":["https://a.b"]}' } },
    ],
  });
});
