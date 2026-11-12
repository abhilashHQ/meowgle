import type { DatabaseSync } from 'node:sqlite';
import { extractClaims } from './claims.js';
import { checkCitations } from './citations.js';
import { insertClaim, insertTurn } from './db.js';
import { localDateOf } from './dates.js';
import type { LLM } from './llm/types.js';
import { plan as runPlan, type Plan } from './plan.js';
import { buildAnswerPrompt } from './prompt.js';
import { recall as runRecall, type Recall } from './recall.js';
import { runSearch } from './search/run.js';
import type { SearchProvider, Source } from './search/types.js';

export type Timings = {
  recallMs: number;
  planMs: number;
  searchMs: number;
  firstTokenMs: number;
  totalMs: number;
};

export type Citations = {
  valid: string[];
  invalid: string[];
};

export type AgentEvent =
  | { type: 'trace'; stage: 'recall' | 'plan' | 'search'; data: unknown }
  | { type: 'sources'; sources: Source[] }
  | { type: 'token'; text: string }
  | { type: 'done'; turnId: number; citations: Citations; timings: Timings }
  | { type: 'error'; message: string };

export type AgentDeps = {
  db: DatabaseSync;
  llm: LLM;
  search: SearchProvider;
  now: () => Date;
};

export type TurnInput = {
  conversationId: string;
  message: string;
  tz: string;
  level: 'auto' | 'instant' | 'quick';
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asksForFreshFacts(message: string): boolean {
  return /\b(still|current|currently|latest|now|change|changed|changes|update|updated|outdated|verify|recheck|today)\b/i.test(
    message,
  );
}

export async function* runTurn(deps: AgentDeps, input: TurnInput): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now();
  const nowDate = deps.now();
  const timings: Timings = {
    recallMs: 0,
    planMs: 0,
    searchMs: 0,
    firstTokenMs: 0,
    totalMs: 0,
  };
  const trace: Record<string, unknown> = {};

  let userTurnId: number;
  try {
    userTurnId = insertTurn(deps.db, {
      conversationId: input.conversationId,
      role: 'user',
      content: input.message,
      createdAt: nowDate.toISOString(),
      localDate: localDateOf(nowDate, input.tz),
      tz: input.tz,
    });
  } catch (error) {
    yield { type: 'error', message: `failed to save user turn: ${errorMessage(error)}` };
    return;
  }

  const recallStarted = Date.now();
  let recalled: Recall;
  try {
    recalled = runRecall(deps.db, {
      message: input.message,
      now: nowDate,
      tz: input.tz,
      conversationId: input.conversationId,
      excludeTurnId: userTurnId,
    });
  } catch (error) {
    yield { type: 'error', message: `recall failed: ${errorMessage(error)}` };
    return;
  }
  timings.recallMs = Date.now() - recallStarted;
  const recallTrace = {
    dateRefs: recalled.dateRefs,
    counts: {
      turns:
        recalled.byDate.reduce(
          (total, group) => total + group.turns.length + (group.nearby?.turns.length ?? 0),
          0,
        ) +
        recalled.topical.length +
        recalled.recent.length,
      byDate: recalled.byDate.length,
      topical: recalled.topical.length,
      recent: recalled.recent.length,
      claims: recalled.claims.length,
    },
    nearby: recalled.byDate
      .filter((group) => group.nearby !== null)
      .map((group) => ({ phrase: group.ref.phrase, date: group.nearby!.date })),
  };
  trace.recall = recallTrace;
  yield { type: 'trace', stage: 'recall', data: recallTrace };

  const planStarted = Date.now();
  let planned: Plan;
  try {
    planned = await runPlan(deps.llm, {
      message: input.message,
      recall: recalled,
      now: nowDate,
      tz: input.tz,
      forcedLevel: input.level === 'auto' ? undefined : input.level,
    });
  } catch (error) {
    yield { type: 'error', message: `plan failed: ${errorMessage(error)}` };
    return;
  }
  timings.planMs = Date.now() - planStarted;
  trace.plan = planned;
  yield { type: 'trace', stage: 'plan', data: planned };

  let answer = '';
  let sources: Source[] = [];
  let searchFailure: string | undefined;
  if (planned.queries.length > 0) {
    const searchStarted = Date.now();
    let result: Awaited<ReturnType<typeof runSearch>>;
    try {
      result = await runSearch(deps.search, planned.queries, {
        fresh: planned.recheckClaimIds.length > 0 || asksForFreshFacts(input.message),
      });
    } catch (error) {
      yield { type: 'error', message: `search failed: ${errorMessage(error)}` };
      return;
    }
    timings.searchMs = Date.now() - searchStarted;
    sources = result.sources;
    searchFailure = result.error;
    const searchTrace = {
      queries: planned.queries,
      sources: sources.map((source) => ({
        id: source.id,
        url: source.url,
        title: source.title,
        publishedDate: source.publishedDate,
      })),
      ms: timings.searchMs,
      ...(searchFailure ? { error: searchFailure } : {}),
    };
    trace.search = searchTrace;
    yield { type: 'trace', stage: 'search', data: searchTrace };
    yield { type: 'sources', sources };
    if (searchFailure) {
      const notice = `Web search failed (${searchFailure}). Answering from memory only.\n\n`;
      answer += notice;
      yield { type: 'token', text: notice };
    }
  }

  const streamStarted = Date.now();
  let firstChunk = true;
  try {
    const prompt = buildAnswerPrompt({
      message: input.message,
      recall: recalled,
      sources,
      now: nowDate,
      tz: input.tz,
      plan: planned,
      searchFailed: searchFailure,
    });
    for await (const chunk of deps.llm.stream({
      model: planned.level === 'instant' ? 'fast' : 'main',
      system: prompt.system,
      prompt: prompt.prompt,
    })) {
      if (firstChunk) {
        timings.firstTokenMs = Date.now() - streamStarted;
        firstChunk = false;
      }
      answer += chunk;
      yield { type: 'token', text: chunk };
    }
  } catch (error) {
    yield { type: 'error', message: `answer stream failed: ${errorMessage(error)}` };
    return;
  }

  const citations = checkCitations(answer, sources);
  timings.totalMs = Date.now() - startedAt;
  const finishedAt = deps.now();

  let assistantTurnId: number;
  try {
    assistantTurnId = insertTurn(deps.db, {
      conversationId: input.conversationId,
      role: 'assistant',
      content: answer,
      createdAt: finishedAt.toISOString(),
      localDate: localDateOf(finishedAt, input.tz),
      tz: input.tz,
      level: planned.level,
      traceJson: JSON.stringify({ ...trace, citations, timings }),
    });
  } catch (error) {
    yield { type: 'error', message: `failed to save assistant turn: ${errorMessage(error)}` };
    return;
  }

  yield { type: 'done', turnId: assistantTurnId, citations, timings };

  try {
    const claims = await extractClaims(deps.llm, { answer, sources });
    for (const claim of claims) {
      insertClaim(deps.db, assistantTurnId, claim);
    }
  } catch (error) {
    console.error(`claim extraction failed: ${errorMessage(error)}`);
  }
}