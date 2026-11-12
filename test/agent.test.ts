import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, type AgentEvent } from '../src/agent.js';
import { openDb, getTurnsByConversation, type TurnRow } from '../src/db.js';
import type { LLM } from '../src/llm/types.js';
import type { SearchProvider, Source } from '../src/search/types.js';

class AgentLLM implements LLM {
  readonly kinds: string[] = [];

  constructor(
    private readonly planResponse: unknown,
    private readonly claimsResponse: unknown,
    private readonly tokens: string[],
  ) {}

  async json<T>(options: {
    model: 'fast' | 'main';
    system: string;
    prompt: string;
    schema: object;
  }): Promise<T> {
    if (JSON.stringify(options.schema).includes('recheckClaimIds')) {
      this.kinds.push('plan');
      return this.planResponse as T;
    }
    this.kinds.push('claims');
    return this.claimsResponse as T;
  }

  async *stream(): AsyncGenerator<string> {
    this.kinds.push('stream');
    for (const token of this.tokens) yield token;
  }
}

class AgentSearch implements SearchProvider {
  readonly calls: { query: string; fresh: boolean; signal: AbortSignal }[] = [];

  async search(
    query: string,
    options: { numResults: number; fresh: boolean; signal: AbortSignal },
  ) {
    this.calls.push({ query, fresh: options.fresh, signal: options.signal });
    return [
      {
        url: 'https://supabase.com/pricing',
        title: 'Supabase Pricing',
        publishedDate: '2026-11-01',
        excerpt: 'The free tier includes 500MB of database storage.',
      },
    ];
  }
}

test('runTurn: emits stages in order and persists turns and claims', async () => {
  const db = openDb(':memory:');
  const llm = new AgentLLM(
    {
      level: 'quick',
      queries: ['supabase pricing 2026'],
      recheckClaimIds: [],
      reason: 'needs current pricing',
    },
    {
      claims: [
        {
          subject: 'Supabase pricing',
          claim: 'Supabase free tier includes 500MB [S1].',
          sourceId: 'S1',
        },
      ],
    },
    ['The free tier includes 500MB ', '[S1].'],
  );
  const search = new AgentSearch();

  const events: AgentEvent[] = [];
  for await (const event of runTurn(
    { db, llm, search, now: () => new Date('2026-11-11T10:00:00Z') },
    {
      conversationId: 'c1',
      message: 'What does Supabase cost today?',
      tz: 'Asia/Kolkata',
      level: 'auto',
    },
  )) {
    events.push(event);
  }

  const labels = events.map((event) => (event.type === 'trace' ? `trace:${event.stage}` : event.type));
  assert.deepEqual(
    labels.filter((label) => label !== 'token'),
    ['trace:recall', 'trace:plan', 'trace:search', 'sources', 'done'],
  );
  assert.equal(labels.filter((label) => label === 'token').length, 2);
  assert.ok(labels.indexOf('sources') < labels.indexOf('token'));

  const sourcesEvent = events.find((event) => event.type === 'sources');
  assert.ok(sourcesEvent);
  if (sourcesEvent?.type !== 'sources') throw new Error('missing sources event');
  assert.equal(sourcesEvent.sources.length, 1);
  assert.equal(sourcesEvent.sources[0].id, 'S1');
  assert.equal(search.calls[0].query, 'supabase pricing 2026');
  assert.equal(search.calls[0].fresh, true);

  const doneEvent = events.find((event) => event.type === 'done');
  assert.ok(doneEvent);
  if (doneEvent?.type !== 'done') throw new Error('missing done event');
  assert.deepEqual(doneEvent.citations, { valid: ['S1'], invalid: [] });
  for (const key of ['recallMs', 'planMs', 'searchMs', 'firstTokenMs', 'totalMs'] as const) {
    assert.equal(typeof doneEvent.timings[key], 'number');
  }

  const turns = getTurnsByConversation(db, 'c1');
  assert.equal(turns.length, 2);
  const [userTurn, assistantTurn] = turns as [TurnRow, TurnRow];
  assert.equal(userTurn.role, 'user');
  assert.equal(userTurn.content, 'What does Supabase cost today?');
  assert.equal(userTurn.local_date, '2026-11-11');
  assert.equal(userTurn.tz, 'Asia/Kolkata');

  assert.equal(assistantTurn.role, 'assistant');
  assert.equal(assistantTurn.content, 'The free tier includes 500MB [S1].');
  assert.equal(assistantTurn.level, 'quick');
  assert.equal(assistantTurn.local_date, '2026-11-11');
  assert.ok(assistantTurn.trace_json);
  const trace = JSON.parse(assistantTurn.trace_json) as Record<string, unknown>;
  assert.ok(trace.recall);
  assert.ok(trace.plan);
  assert.ok(trace.search);
  assert.ok(trace.citations);
  assert.ok(trace.timings);

  const claimRows = db.prepare('SELECT * FROM claims').all() as unknown as {
    turn_id: number;
    subject: string;
    claim: string;
    source_url: string;
    source_title: string;
    published_date: string;
    fetched_at: string;
  }[];
  assert.equal(claimRows.length, 1);
  assert.equal(claimRows[0].turn_id, assistantTurn.id);
  assert.equal(claimRows[0].subject, 'Supabase pricing');
  assert.equal(claimRows[0].source_url, 'https://supabase.com/pricing');
  assert.equal(claimRows[0].source_title, 'Supabase Pricing');
  assert.equal(claimRows[0].published_date, '2026-11-01');
  assert.ok(claimRows[0].fetched_at);

  assert.deepEqual(llm.kinds, ['plan', 'stream', 'claims']);
});

test('runTurn: search failure notice is part of the saved answer', async () => {
  const db = openDb(':memory:');
  const llm = new AgentLLM(
    {
      level: 'quick',
      queries: ['supabase pricing 2026'],
      recheckClaimIds: [],
      reason: 'needs current pricing',
    },
    { claims: [] },
    ['I do not have current pricing. ', 'From memory, the free tier was 500MB [S1].'],
  );
  const search: SearchProvider = {
    async search() {
      throw new Error('offline');
    },
  };

  const events: AgentEvent[] = [];
  for await (const event of runTurn(
    { db, llm, search, now: () => new Date('2026-11-11T10:00:00Z') },
    {
      conversationId: 'c1',
      message: 'What does Supabase cost today?',
      tz: 'Asia/Kolkata',
      level: 'auto',
    },
  )) {
    events.push(event);
  }

  const streamed = events
    .filter((event): event is { type: 'token'; text: string } => event.type === 'token')
    .map((event) => event.text)
    .join('');
  assert.match(streamed, /^Web search failed/);

  const turns = getTurnsByConversation(db, 'c1');
  assert.equal(turns.length, 2);
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[1].content, streamed);

  const done = events.find((event) => event.type === 'done');
  assert.ok(done);
  if (done?.type !== 'done') throw new Error('missing done event');
  assert.deepEqual(done.citations, { valid: [], invalid: ['S1'] });
});

test('runTurn: instant plans skip search and still persist the assistant turn', async () => {
  const db = openDb(':memory:');
  const llm = new AgentLLM(
    {
      level: 'instant',
      queries: [],
      recheckClaimIds: [],
      reason: 'greeting',
    },
    { claims: [] },
    ['hey there'],
  );
  const search = new AgentSearch();

  const events: AgentEvent[] = [];
  for await (const event of runTurn(
    { db, llm, search, now: () => new Date('2026-11-11T10:00:00Z') },
    { conversationId: 'c1', message: 'hey', tz: 'Asia/Kolkata', level: 'auto' },
  )) {
    events.push(event);
  }

  const labels = events.map((event) => (event.type === 'trace' ? `trace:${event.stage}` : event.type));
  assert.deepEqual(labels, ['trace:recall', 'trace:plan', 'token', 'done']);
  assert.equal(search.calls.length, 0);

  const turns = getTurnsByConversation(db, 'c1');
  assert.equal(turns.length, 2);
  assert.equal(turns[1].level, 'instant');
});