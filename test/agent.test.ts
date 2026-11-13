import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { runTurn, cleanAnswer, type AgentEvent } from '../src/agent.ts';
import { openDb, startTurn, finishTurn } from '../src/memory.ts';
import type { Chunk, LLM } from '../src/llm.ts';
import type { Book, Tools } from '../src/tools.ts';

test('cleanAnswer: gpt-oss markers become [n], unknown and repeated ones go, odd unicode is normalized', () => {
  const raw = 'A 【3†L1-L2】​ b [2†source] c [9]. d [2][2]【2†x】 e %, non‑breaking';
  assert.equal(cleanAnswer(raw, new Set([2, 3])), 'A [3] b [2] c. d [2] e %, non-breaking');
  assert.equal(cleanAnswer('Views 19M [previous ledger]. See [Sources](https://x.y).', new Set()), 'Views 19M. See [Sources](https://x.y).');
});

test('cleanAnswer: grouped citations split into [n], dropping unknown and repeated ones', () => {
  assert.equal(cleanAnswer('A [7, 9]. B [2; 99]. C [3,3].', new Set([2, 3, 7, 9])), 'A [7][9]. B [2]. C [3].');
});

const call = (name: string, args: object): Chunk => ({
  kind: 'tools',
  calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

function fakeLLM(script: Chunk[][], extraction?: object) {
  const bodies: any[] = [];
  const llm: LLM = {
    async *stream(body) {
      bodies.push(structuredClone(body));
      yield* script[bodies.length - 1] ?? script.at(-1)!;
    },
    async complete() {
      return { choices: [{ message: { tool_calls: [{ function: { name: 'save_memory', arguments: JSON.stringify(extraction) } }] } }] };
    },
  };
  return { llm, bodies };
}

const add = (book: Book, url: string, title: string, opened: boolean, text = '') =>
  book.set(url, { n: book.size + 1, url, title, fetched_at: '2026-11-12T11:10:00.000Z', opened, text });

function fakeTools() {
  const seen: { live?: boolean } = {};
  const tools: Tools = {
    async openPage({ urls }, book, live) {
      seen.live = live;
      add(book, urls[0], 'Neon pricing', true, 'Launch $19/month');
      return { text: '[1] Neon pricing (neon.com, live)\nLaunch $19/month', ok: 1, failed: 0, domains: [] };
    },
    async webSearch(_args, book) {
      add(book, 'https://neon.com/blog/news', 'Neon news', false);
      add(book, 'https://example.com/roundup', 'Roundup', false);
      return { text: '[2] Neon news\n...\n\n[3] Roundup\n...', ok: 2, failed: 0, domains: ['neon.com', 'example.com'] };
    },
  };
  return { tools, seen };
}

test('runTurn: tool rounds, streamed answer, persistence, live re-open, extraction', async () => {
  const db = openDb(':memory:');
  const past = startTurn(db, { question: 'Neon pricing?', tz: 'Asia/Kolkata', askedAt: '2026-11-10T08:32:00.000Z' });
  finishTurn(db, past.turnId, 'Neon Launch is $19/month [1].', [{ n: 1, url: 'https://neon.com/pricing', title: 'Neon', fetched_at: '2026-11-10T08:32:00.000Z' }]);
  db.prepare("INSERT INTO claims (turn_id, entity, fact, value, source_url, fetched_at) VALUES (?, 'Neon', 'Launch price', '$19/month', 'https://neon.com/pricing', '2026-11-10T08:32:00.000Z')").run(past.turnId);

  const { llm, bodies } = fakeLLM([
    [{ kind: 'reasoning', text: 'Re-open the stored page.' }, call('open_page', { urls: ['https://neon.com/pricing'], focus: 'Launch price' })],
    [call('web_search', { queries: ['Neon pricing change'], since: '2026-11-10' })],
    [
      { kind: 'content', text: '\nStill $19/month 【' },
      { kind: 'content', text: '1†L3-L5】 per Neon [2], nothing new [7].' },
    ],
  ], { topic: 'Neon pricing', entities: ['Neon'], claims: [{ entity: 'Neon', fact: 'Launch price', value: '$19/month', source_url: 'https://neon.com/pricing' }] });
  const { tools, seen } = fakeTools();

  const events: AgentEvent[] = [];
  for await (const e of runTurn({ db, llm, tools, now: () => new Date('2026-11-12T11:10:00Z') }, { message: 'Is that still right?', tz: 'Asia/Kolkata' })) events.push(e);

  assert.deepEqual([...new Set(events.map((e) => e.type))], ['start', 'thinking', 'open', 'open_done', 'search', 'search_done', 'answer', 'sources', 'done']);
  const answer = events.flatMap((e) => (e.type === 'answer' ? [e.text] : [])).join('');
  assert.equal(answer, 'Still $19/month [1] per Neon [2], nothing new.');
  assert.equal(seen.live, true);
  assert.deepEqual(events.find((e) => e.type === 'search'), { type: 'search', queries: ['Neon pricing change'], since: '2026-11-10' });
  assert.deepEqual(events.find((e) => e.type === 'sources'), { type: 'sources', sources: [
    { n: 1, url: 'https://neon.com/pricing', title: 'Neon pricing' },
    { n: 2, url: 'https://neon.com/blog/news', title: 'Neon news' },
  ] });

  assert.equal(bodies.length, 3);
  assert.match(bodies[0].messages[0].content, /\] "Neon pricing\?"/);
  assert.doesNotMatch(bodies[0].messages[0].content.split('# Log of past questions')[1], /\$19/);
  const tail = bodies[0].messages.at(-1).content;
  assert.match(tail, /^Now: Thu 12 Nov 2026 16:40 \(Asia\/Kolkata\)\nLast 14 days:\nThu 12 Nov = 2026-11-12 \(today\)/);
  assert.match(tail, /Saved findings[\s\S]*- Neon \| Launch price: \$19\/month \(as of 10 Nov, https:\/\/neon\.com\/pricing\)\n\nIs that still right\?\n\n\(Reply to this message only/);
  const toolMsgs = bodies[2].messages.filter((m: any) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.ok(toolMsgs.every((m: any) => m.content.endsWith('reply only to: "Is that still right?". Plain paragraphs, cite as [n], no bold, headers, label bullets or closing summary.)')));
  assert.match(toolMsgs[0].content, /\(Today is Thu 12 Nov 2026\./);

  const row = db.prepare('SELECT answer, sources FROM turns WHERE id = 2').get() as { answer: string; sources: string };
  assert.equal(row.answer, answer);
  assert.deepEqual(JSON.parse(row.sources).map((s: any) => s.url), ['https://neon.com/pricing', 'https://neon.com/blog/news']);

  await tick();
  await tick();
  const turn = db.prepare('SELECT topic FROM turns WHERE id = 2').get() as { topic: string };
  assert.equal(turn.topic, 'Neon pricing');
  assert.equal((db.prepare('SELECT count(*) AS n FROM claims WHERE turn_id = 2').get() as { n: number }).n, 1);
});

test('runTurn: a question that does not refer to the past gets no saved findings', async () => {
  const db = openDb(':memory:');
  const past = startTurn(db, { question: 'Neon pricing?', tz: 'UTC', askedAt: '2026-11-10T08:32:00.000Z' });
  finishTurn(db, past.turnId, 'Neon Launch is $47/month [1].', []);
  db.prepare("INSERT INTO claims (turn_id, entity, fact, value, source_url, fetched_at) VALUES (?, 'Neon', 'Launch price', '$47/month', 'https://neon.com/pricing', '2026-11-10T08:32:00.000Z')").run(past.turnId);
  const { llm, bodies } = fakeLLM([[{ kind: 'content', text: 'Hi.' }]], { topic: 't', entities: [], claims: [] });
  for await (const _ of runTurn({ db, llm, tools: fakeTools().tools }, { message: 'what does neon cost', tz: 'UTC' }));
  assert.ok(bodies[0].messages.every((m: any) => !/\$47|Saved findings from past/.test(m.content)));
});

test('runTurn: the sixth call drops tools and tool history, and its tool calls are ignored', async () => {
  const db = openDb(':memory:');
  const { llm, bodies } = fakeLLM([
    ...Array.from({ length: 5 }, () => [call('web_search', { queries: ['x'] })]),
    [{ kind: 'content', text: 'Best I can tell, x.' }, call('web_search', { queries: ['y'] })],
  ], { topic: 't', entities: [], claims: [] });
  const events: AgentEvent[] = [];
  for await (const e of runTurn({ db, llm, tools: fakeTools().tools }, { message: 'q', tz: 'UTC', effort: 'high' })) events.push(e);
  assert.equal(bodies.length, 6);
  assert.ok(bodies.every((b) => b.reasoning_effort === 'high'));
  assert.ok(bodies.slice(0, 5).every((b) => b.tools));
  assert.equal(bodies[5].tools, undefined);
  assert.ok(bodies[5].messages.every((m: any) => m.role !== 'tool' && !m.tool_calls));
  assert.match(bodies[5].messages.at(-1).content, /^Your research for this question is finished[\s\S]*\[2\] Neon news/);
  assert.equal(events.filter((e) => e.type === 'search').length, 5);
  assert.equal(events.at(-1)?.type, 'done');
});

test('runTurn: narration streamed before a tool call is retracted into thinking, not stored as the answer', async () => {
  const db = openDb(':memory:');
  const { llm } = fakeLLM([
    [{ kind: 'content', text: "I'll look up Neon pricing. " }, call('web_search', { queries: ['neon pricing'] })],
    [{ kind: 'content', text: 'Neon Launch is usage-based [1].' }],
  ], { topic: 't', entities: [], claims: [] });
  const events: AgentEvent[] = [];
  for await (const e of runTurn({ db, llm, tools: fakeTools().tools }, { message: 'neon price?', tz: 'UTC' })) events.push(e);
  const types = events.map((e) => e.type);
  const reset = types.indexOf('answer_reset');
  assert.ok(reset > types.indexOf('answer') && reset < types.indexOf('search'));
  assert.deepEqual(events[reset + 1], { type: 'thinking', text: "I'll look up Neon pricing. " });
  const answer = events.slice(reset).flatMap((e) => (e.type === 'answer' ? [e.text] : [])).join('');
  assert.equal(answer, 'Neon Launch is usage-based [1].');
  assert.equal((db.prepare('SELECT answer FROM turns').get() as { answer: string }).answer, answer);
});

test('runTurn: an LLM failure emits error and keeps the partial answer', async () => {
  const db = openDb(':memory:');
  const llm: LLM = {
    async *stream() {
      yield { kind: 'content', text: 'Partial' };
      throw new Error('LLM 500: boom');
    },
    async complete() {},
  };
  const events: AgentEvent[] = [];
  for await (const e of runTurn({ db, llm, tools: fakeTools().tools }, { message: 'q', tz: 'UTC' })) events.push(e);
  assert.deepEqual(events.at(-1), { type: 'error', message: 'LLM 500: boom' });
  assert.equal((db.prepare('SELECT answer FROM turns').get() as { answer: string }).answer, 'Partial');
});
