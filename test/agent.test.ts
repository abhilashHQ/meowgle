import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, type AgentEvent } from '../src/agent.js';
import { openDb, getTurnsByConversation, type TurnRow } from '../src/db.js';
import type { JsonOptions, LLM, LLMStreamPart, StreamOptions } from '../src/llm/types.js';
import type { SearchOptions, SearchProvider } from '../src/search/types.js';

type AgentLLMInput = {
  planResponse: unknown;
  claimsResponse: unknown;
  parts: LLMStreamPart[];
  reviewResponse?: unknown;
};

class AgentLLM implements LLM {
  readonly kinds: string[] = [];
  private readonly planResponse: unknown;
  private readonly claimsResponse: unknown;
  private readonly parts: LLMStreamPart[];
  private readonly reviewResponse: unknown;

  constructor(input: AgentLLMInput) {
    this.planResponse = input.planResponse;
    this.claimsResponse = input.claimsResponse;
    this.parts = input.parts;
    this.reviewResponse = input.reviewResponse ?? {
      enough: true,
      gaps: [],
      followUpQueries: [],
      reason: 'covered',
    };
  }

  async json<T>(options: JsonOptions): Promise<T> {
    const schema = JSON.stringify(options.schema);
    if (schema.includes('recheckClaimIds')) {
      this.kinds.push('plan');
      return this.planResponse as T;
    }
    if (schema.includes('followUpQueries')) {
      this.kinds.push('review');
      return this.reviewResponse as T;
    }
    this.kinds.push('claims');
    return this.claimsResponse as T;
  }

  async *stream(_options: StreamOptions): AsyncGenerator<LLMStreamPart> {
    this.kinds.push('stream');
    for (const part of this.parts) yield part;
  }
}

class AgentSearch implements SearchProvider {
  readonly calls: SearchOptions[] = [];

  async search(query: string, options: SearchOptions) {
    this.calls.push(options);
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

const PLAN_RESPONSE = {
  level: 'quick',
  queries: ['supabase pricing 2026'],
  recheckClaimIds: [],
  objective: 'exact current free tier limits from the official pricing page',
  reason: 'needs current pricing',
};

function activityLabels(events: AgentEvent[]): string[] {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'activity' }> => event.type === 'activity')
    .map((event) => `${event.activity.id}:${event.activity.status}`);
}

test('runTurn: streams live activity, thoughts, and the answer, then persists', async () => {
  const db = openDb(':memory:');
  const llm = new AgentLLM({
    planResponse: PLAN_RESPONSE,
    claimsResponse: {
      claims: [
        {
          subject: 'Supabase pricing',
          claim: 'Supabase free tier includes 500MB.',
          sourceId: 'S1',
        },
      ],
    },
    parts: [
      { type: 'thought', text: 'Checking the current pricing page.' },
      { type: 'text', text: 'The free tier includes 500MB ' },
      { type: 'text', text: '[S1].' },
    ],
  });
  const search = new AgentSearch();

  const events: AgentEvent[] = [];
  for await (const event of runTurn(
    { db, llm, search, now: () => new Date('2026-11-11T10:00:00Z') },
    {
      conversationId: 'c1',
      message: 'What does Supabase cost today?',
      tz: 'Asia/Kolkata',
      reasoning: 'medium',
    },
  )) {
    events.push(event);
  }

  assert.deepEqual(activityLabels(events), [
    'recall:start',
    'recall:done',
    'plan:start',
    'plan:done',
    'search-1:start',
    'search-1:done',
    'thinking-answer:start',
    'thinking-answer:done',
    'writing:start',
    'writing:done',
  ]);

  const traceStages = events
    .filter((event): event is Extract<AgentEvent, { type: 'trace' }> => event.type === 'trace')
    .map((event) => event.stage);
  assert.deepEqual(traceStages, ['recall', 'plan', 'search']);

  const thought = events.find((event) => event.type === 'thought');
  assert.ok(thought);
  if (thought?.type !== 'thought') throw new Error('missing thought event');
  assert.match(thought.text, /pricing page/);

  const labels = events.map((event) => event.type);
  assert.ok(labels.indexOf('sources') < labels.indexOf('token'));

  const streamed = events
    .filter((event): event is { type: 'token'; text: string } => event.type === 'token')
    .map((event) => event.text)
    .join('');
  assert.equal(streamed, 'The free tier includes 500MB [S1].');

  const sourcesEvent = events.find((event) => event.type === 'sources');
  assert.ok(sourcesEvent);
  if (sourcesEvent?.type !== 'sources') throw new Error('missing sources event');
  assert.equal(sourcesEvent.sources.length, 1);
  assert.equal(sourcesEvent.sources[0].id, 'S1');
  assert.equal(search.calls.length, 1);
  assert.equal(search.calls[0].type, 'auto');

  const doneEvent = events.find((event) => event.type === 'done');
  assert.ok(doneEvent);
  if (doneEvent?.type !== 'done') throw new Error('missing done event');
  assert.deepEqual(doneEvent.citations, { valid: ['S1'], invalid: [] });
  assert.equal(doneEvent.reasoning, 'medium');
  assert.equal(doneEvent.rounds, 1);

  const turns = getTurnsByConversation(db, 'c1');
  assert.equal(turns.length, 2);
  const [userTurn, assistantTurn] = turns as [TurnRow, TurnRow];
  assert.equal(userTurn.role, 'user');
  assert.equal(userTurn.content, 'What does Supabase cost today?');
  assert.equal(assistantTurn.content, 'The free tier includes 500MB [S1].');
  assert.equal(assistantTurn.level, 'quick');

  assert.ok(assistantTurn.trace_json);
  const trace = JSON.parse(assistantTurn.trace_json) as Record<string, unknown>;
  assert.ok(trace.recall);
  assert.ok(trace.plan);
  assert.ok(trace.search);
  assert.ok(trace.citations);
  assert.ok(trace.timings);
  assert.ok(Array.isArray(trace.activities));
  assert.equal(trace.reasoning, 'medium');

  assert.deepEqual(llm.kinds, ['plan', 'stream', 'claims']);
});

test('runTurn: search failure notice is friendly and part of the saved answer', async () => {
  const db = openDb(':memory:');
  const llm = new AgentLLM({
    planResponse: PLAN_RESPONSE,
    claimsResponse: { claims: [] },
    parts: [
      { type: 'text', text: 'I do not have current pricing. ' },
      { type: 'text', text: 'From memory, the free tier was 500MB [S1].' },
    ],
  });
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
      reasoning: 'medium',
    },
  )) {
    events.push(event);
  }

  const streamed = events
    .filter((event): event is { type: 'token'; text: string } => event.type === 'token')
    .map((event) => event.text)
    .join('');
  assert.match(streamed, /^Search did not come back/);

  const turns = getTurnsByConversation(db, 'c1');
  assert.equal(turns.length, 2);
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[1].content, streamed);

  assert.equal(
    events.some((event) => event.type === 'thought'),
    false,
    'a failed search should not trigger a thinking pass',
  );

  const done = events.find((event) => event.type === 'done');
  assert.ok(done);
  if (done?.type !== 'done') throw new Error('missing done event');
  assert.deepEqual(done.citations, { valid: [], invalid: [] });
});

test('runTurn: small talk skips the planner and search', async () => {
  const db = openDb(':memory:');
  const llm = new AgentLLM({
    planResponse: PLAN_RESPONSE,
    claimsResponse: { claims: [] },
    parts: [{ type: 'text', text: 'Hey! What are you working on?' }],
  });
  const search = new AgentSearch();

  const events: AgentEvent[] = [];
  for await (const event of runTurn(
    { db, llm, search, now: () => new Date('2026-11-11T10:00:00Z') },
    {
      conversationId: 'c1',
      message: 'hey there',
      tz: 'Asia/Kolkata',
      reasoning: 'low',
    },
  )) {
    events.push(event);
  }

  assert.equal(search.calls.length, 0);
  assert.deepEqual(llm.kinds, ['stream', 'claims']);
  const planTrace = events.find(
    (event): event is Extract<AgentEvent, { type: 'trace' }> =>
      event.type === 'trace' && event.stage === 'plan',
  );
  assert.ok(planTrace);
  assert.equal((planTrace.data as { level: string }).level, 'instant');
});

test('runTurn: instant plans skip search and still persist the assistant turn', async () => {
  const db = openDb(':memory:');
  const llm = new AgentLLM({
    planResponse: {
      level: 'instant',
      queries: [],
      recheckClaimIds: [],
      objective: 'just chat',
      reason: 'greeting',
    },
    claimsResponse: { claims: [] },
    parts: [{ type: 'text', text: 'hey there' }],
  });
  const search = new AgentSearch();

  const events: AgentEvent[] = [];
  for await (const event of runTurn(
    { db, llm, search, now: () => new Date('2026-11-11T10:00:00Z') },
    {
      conversationId: 'c1',
      message: 'hey',
      tz: 'Asia/Kolkata',
      reasoning: 'low',
    },
  )) {
    events.push(event);
  }

  assert.equal(search.calls.length, 0);
  const token = events.find((event) => event.type === 'token');
  assert.ok(token);

  const turns = getTurnsByConversation(db, 'c1');
  assert.equal(turns.length, 2);
  assert.equal(turns[1].level, 'instant');
});

test('runTurn: low reasoning caps queries at two', async () => {
  const db = openDb(':memory:');
  const llm = new AgentLLM({
    planResponse: {
      level: 'quick',
      queries: ['q1', 'q2', 'q3', 'q4', 'q5'],
      recheckClaimIds: [],
      objective: 'cover everything',
      reason: 'needs search',
    },
    claimsResponse: { claims: [] },
    parts: [{ type: 'text', text: 'answer' }],
  });
  const search = new AgentSearch();

  for await (const _event of runTurn(
    { db, llm, search, now: () => new Date('2026-11-11T10:00:00Z') },
    {
      conversationId: 'c1',
      message: 'compare five things',
      tz: 'Asia/Kolkata',
      reasoning: 'low',
    },
  )) {
    // drain
  }

  assert.equal(search.calls.length, 2);
});

test('runTurn: high reasoning reviews sources and runs a follow-up round', async () => {
  const db = openDb(':memory:');
  const llm = new AgentLLM({
    planResponse: PLAN_RESPONSE,
    claimsResponse: { claims: [] },
    reviewResponse: {
      enough: false,
      gaps: ['no official neon pricing'],
      followUpQueries: ['neon pricing official page'],
      reason: 'one vendor missing',
    },
    parts: [{ type: 'text', text: 'answer' }],
  });
  const search = new AgentSearch();

  const events: AgentEvent[] = [];
  for await (const event of runTurn(
    { db, llm, search, now: () => new Date('2026-11-11T10:00:00Z') },
    {
      conversationId: 'c1',
      message: 'compare supabase and neon pricing today',
      tz: 'Asia/Kolkata',
      reasoning: 'high',
    },
  )) {
    events.push(event);
  }

  assert.equal(search.calls.length, 2);
  assert.ok(llm.kinds.includes('review'));
  const activityIds = activityLabels(events);
  assert.ok(activityIds.includes('review-1:done'));
  assert.ok(activityIds.includes('search-2:done'));

  const done = events.find((event) => event.type === 'done');
  assert.ok(done);
  if (done?.type !== 'done') throw new Error('missing done event');
  assert.equal(done.rounds, 2);
});
