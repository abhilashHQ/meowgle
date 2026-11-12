import type { DatabaseSync } from 'node:sqlite';
import { extractClaims } from './claims.js';
import { checkCitations } from './citations.js';
import { insertClaim, insertTurn } from './db.js';
import { localDateOf } from './dates.js';
import type { LLM, Reasoning } from './llm/types.js';
import { isSmallTalk, plan as runPlan, type Plan } from './plan.js';
import { friendlyError } from './errors.js';
import { buildAnswerPrompt } from './prompt.js';
import { recall as runRecall, type Recall } from './recall.js';
import { reviewSources, type Review } from './review.js';
import { runSearch } from './search/run.js';
import type { SearchMode, SearchProvider, Source } from './search/types.js';

export type Timings = {
  recallMs: number;
  planMs: number;
  searchMs: number;
  reviewMs: number;
  firstTokenMs: number;
  totalMs: number;
};

export type Citations = {
  valid: string[];
  invalid: string[];
};

export type ActivityPhase = 'recall' | 'plan' | 'search' | 'review' | 'thinking' | 'writing';

export type Activity = {
  id: string;
  phase: ActivityPhase;
  status: 'start' | 'done' | 'error';
  title: string;
  detail?: string;
  queries?: string[];
  ms?: number;
};

export type AgentEvent =
  | { type: 'activity'; activity: Activity }
  | { type: 'thought'; text: string }
  | { type: 'trace'; stage: 'recall' | 'plan' | 'search' | 'review'; data: unknown }
  | { type: 'sources'; sources: Source[] }
  | { type: 'token'; text: string }
  | {
      type: 'done';
      turnId: number;
      citations: Citations;
      timings: Timings;
      reasoning: Reasoning;
      rounds: number;
    }
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
  reasoning: Reasoning;
  level?: 'instant' | 'quick';
  signal?: AbortSignal;
};

type Budget = {
  maxQueries: number;
  rounds: number;
  followUps: number;
  maxSources: number;
  searchType: SearchMode;
  fullText: boolean;
  freshAgeHours: number;
};

const BUDGETS: Record<Reasoning, Budget> = {
  low: {
    maxQueries: 2,
    rounds: 1,
    followUps: 0,
    maxSources: 4,
    searchType: 'auto',
    fullText: false,
    freshAgeHours: 6,
  },
  medium: {
    maxQueries: 3,
    rounds: 1,
    followUps: 0,
    maxSources: 6,
    searchType: 'auto',
    fullText: false,
    freshAgeHours: 6,
  },
  high: {
    maxQueries: 4,
    rounds: 2,
    followUps: 2,
    maxSources: 8,
    searchType: 'auto',
    fullText: true,
    freshAgeHours: 0,
  },
  xhigh: {
    maxQueries: 5,
    rounds: 3,
    followUps: 3,
    maxSources: 12,
    searchType: 'auto',
    fullText: true,
    freshAgeHours: 0,
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asksForFreshFacts(message: string): boolean {
  return /\b(still|current|currently|latest|now|change|changed|changes|update|updated|outdated|verify|recheck|today)\b/i.test(
    message,
  );
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export async function* runTurn(deps: AgentDeps, input: TurnInput): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now();
  const nowDate = deps.now();
  const signal = input.signal;
  const budget = BUDGETS[input.reasoning];
  const timings: Timings = {
    recallMs: 0,
    planMs: 0,
    searchMs: 0,
    reviewMs: 0,
    firstTokenMs: 0,
    totalMs: 0,
  };
  const trace: Record<string, unknown> = { reasoning: input.reasoning };
  const activities: Activity[] = [];
  const activityStarted = new Map<string, number>();

  function activity(
    id: string,
    phase: ActivityPhase,
    status: 'start' | 'done' | 'error',
    title: string,
    detail?: string,
    queries?: string[],
  ): AgentEvent {
    if (status === 'start') activityStarted.set(id, Date.now());
    const started = activityStarted.get(id);
    const ms = status === 'start' || started === undefined ? undefined : Date.now() - started;
    const next: Activity = {
      id,
      phase,
      status,
      title,
      ...(detail ? { detail } : {}),
      ...(queries && queries.length > 0 ? { queries } : {}),
      ...(ms !== undefined ? { ms } : {}),
    };
    const index = activities.findIndex((item) => item.id === id);
    if (index >= 0) activities[index] = next;
    else activities.push(next);
    return { type: 'activity', activity: next };
  }

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

  yield activity('recall', 'recall', 'start', 'Checking memory');
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
    yield activity('recall', 'recall', 'error', 'Memory lookup failed', errorMessage(error));
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
  const recallTurns = recallTrace.counts.turns;
  yield activity(
    'recall',
    'recall',
    'done',
    recallTurns > 0 ? `Found ${recallTurns} related turns` : 'No relevant memory',
    recalled.dateRefs.length > 0
      ? `Dates in question: ${recalled.dateRefs.map((ref) => ref.phrase).join(', ')}`
      : undefined,
  );
  yield { type: 'trace', stage: 'recall', data: recallTrace };

  if (signal?.aborted) return;

  yield activity('plan', 'plan', 'start', 'Thinking it through');
  const planStarted = Date.now();
  let planned: Plan;
  try {
    planned = !input.level && isSmallTalk(input.message)
      ? {
          level: 'instant',
          queries: [],
          recheckClaimIds: [],
          objective: input.message,
          reason: 'small talk does not need a search',
        }
      : await runPlan(deps.llm, {
      message: input.message,
      recall: recalled,
      now: nowDate,
      tz: input.tz,
      reasoning: input.reasoning,
      forcedLevel: input.level,
    });
  } catch (error) {
    yield activity('plan', 'plan', 'error', 'Planning failed', errorMessage(error));
    yield { type: 'error', message: `plan failed: ${errorMessage(error)}` };
    return;
  }
  if (signal?.aborted) return;
  timings.planMs = Date.now() - planStarted;
  trace.plan = planned;
  yield activity(
    'plan',
    'plan',
    'done',
    planned.level === 'instant' ? 'No search needed' : 'Search plan ready',
    planned.reason,
  );
  yield { type: 'trace', stage: 'plan', data: planned };

  let sources: Source[] = [];
  let searchFailure: string | undefined;
  let rounds = 0;
  let latestReview: Review | undefined;
  const searchRounds: {
    round: number;
    queries: string[];
    ms: number;
    error?: string;
  }[] = [];
  let previousQueries: string[] = [];

  if (planned.queries.length > 0) {
    let queries = planned.queries.slice(0, budget.maxQueries);
    while (queries.length > 0 && rounds < budget.rounds) {
      rounds += 1;
      const id = `search-${rounds}`;
      const title = rounds === 1 ? 'Searching the web' : 'Digging deeper';
      yield activity(id, 'search', 'start', title, undefined, queries);

      const searchStarted = Date.now();
      let result: Awaited<ReturnType<typeof runSearch>>;
      try {
        result = await runSearch(deps.search, queries, {
          fresh: planned.recheckClaimIds.length > 0 || asksForFreshFacts(input.message),
          maxAgeHours:
            planned.recheckClaimIds.length > 0 || asksForFreshFacts(input.message)
              ? budget.freshAgeHours
              : 24,
          signal,
          type: rounds === 1 ? budget.searchType : 'auto',
          objective: planned.objective,
          includeText: budget.fullText && (rounds > 1 || planned.recheckClaimIds.length > 0),
          maxSources: budget.maxSources,
          existingSources: sources,
        });
      } catch (error) {
        if (signal?.aborted) return;
        const detail = errorMessage(error);
        searchFailure = detail;
        searchRounds.push({ round: rounds, queries, ms: Date.now() - searchStarted, error: detail });
        yield activity(id, 'search', 'error', 'Search failed', detail);
        break;
      }

      const searchMs = Date.now() - searchStarted;
      timings.searchMs += searchMs;
      previousQueries = [...previousQueries, ...queries];
      sources = result.sources;
      searchFailure = result.error;
      searchRounds.push({
        round: rounds,
        queries,
        ms: searchMs,
        ...(result.error ? { error: result.error } : {}),
      });

      if (result.error) {
        yield activity(id, 'search', 'error', 'Search came back empty', result.error);
        break;
      }

      yield activity(
        id,
        'search',
        'done',
        `${sources.length} source${sources.length === 1 ? '' : 's'}`,
        `${searchMs} ms`,
      );
      yield { type: 'sources', sources };

      if (signal?.aborted) return;
      if (rounds >= budget.rounds || budget.rounds === 1 || sources.length === 0) break;

      const reviewId = `review-${rounds}`;
      yield activity(reviewId, 'review', 'start', 'Checking coverage');
      const reviewStarted = Date.now();
      latestReview = await reviewSources(deps.llm, {
        message: input.message,
        sources,
        claims: recalled.claims,
        previousQueries,
        maxQueries: budget.followUps,
        reasoning: input.reasoning,
        now: nowDate,
        tz: input.tz,
      });
      if (signal?.aborted) return;
      timings.reviewMs += Date.now() - reviewStarted;
      trace.review = latestReview;
      yield { type: 'trace', stage: 'review', data: latestReview };

      if (!latestReview.available) {
        yield activity(reviewId, 'review', 'done', 'Skipped the coverage check', latestReview.reason);
        break;
      }

      if (latestReview.followUpQueries.length === 0) {
        yield activity(
          reviewId,
          'review',
          'done',
          'Sources look sufficient',
          latestReview.reason,
        );
        break;
      }

      yield activity(
        reviewId,
        'review',
        'done',
        'Found a gap',
        latestReview.gaps.join('; ') || latestReview.reason,
      );
      queries = latestReview.followUpQueries.slice(0, budget.followUps);
    }
  }

  if (searchRounds.length > 0) {
    trace.search = {
      queries: searchRounds.flatMap((round) => round.queries),
      sources: sources.map((source) => ({
        id: source.id,
        url: source.url,
        title: source.title,
        publishedDate: source.publishedDate,
      })),
      ms: timings.searchMs,
      rounds: searchRounds,
      ...(searchFailure ? { error: searchFailure } : {}),
    };
    yield { type: 'trace', stage: 'search', data: trace.search };
  }

  let answer = '';
  const noSearchResults =
    planned.queries.length > 0 && sources.length === 0 && Boolean(searchFailure);

  if (noSearchResults) {
    const streamStarted = Date.now();
    yield activity('writing', 'writing', 'start', 'Writing the answer');
    answer =
      'Search did not come back, so I do not want to guess at the latest. Want me to try again?';
    yield { type: 'token', text: answer };
    timings.firstTokenMs = Date.now() - streamStarted;
    yield activity('writing', 'writing', 'done', 'Answer ready', `${wordCount(answer)} words`);
  } else {
    if (searchFailure) {
      const notice = 'Search did not come back, so this is from what I already know.\n\n';
      answer += notice;
      yield { type: 'token', text: notice };
    }

    const thinkingId = 'thinking-answer';
    const thinkingStart = Date.now();
    yield activity(thinkingId, 'thinking', 'start', rounds > 0 ? 'Thinking again' : 'Thinking');
    let thinkingClosed = false;
    let writingStarted = false;
    let firstText = true;
    const streamStarted = Date.now();

    try {
      const prompt = buildAnswerPrompt({
        message: input.message,
        recall: recalled,
        sources,
        now: nowDate,
        tz: input.tz,
        reasoning: input.reasoning,
        plan: planned,
        searchFailed: searchFailure,
      });
      for await (const part of deps.llm.stream({
        model: planned.level === 'instant' ? 'fast' : 'main',
        system: prompt.system,
        prompt: prompt.prompt,
        reasoning: planned.level === 'instant' ? undefined : input.reasoning,
        includeThoughts: planned.level !== 'instant',
        signal,
      })) {
        if (part.type === 'thought') {
          if (!thinkingClosed) yield { type: 'thought', text: part.text };
          continue;
        }
        if (firstText) {
          timings.firstTokenMs = Date.now() - streamStarted;
          thinkingClosed = true;
          yield activity(
            thinkingId,
            'thinking',
            'done',
            `Thought for ${((Date.now() - thinkingStart) / 1000).toFixed(1)}s`,
          );
          yield activity('writing', 'writing', 'start', 'Writing the answer');
          writingStarted = true;
          firstText = false;
        }
        answer += part.text;
        yield { type: 'token', text: part.text };
      }
    } catch (error) {
      if (signal?.aborted) return;
      yield activity(thinkingId, 'thinking', 'error', 'The model failed', errorMessage(error));
      yield { type: 'error', message: `The answer failed: ${friendlyError(error)}` };
      return;
    }

    if (signal?.aborted) return;

    if (!thinkingClosed) {
      yield activity(
        thinkingId,
        'thinking',
        'done',
        `Thought for ${((Date.now() - thinkingStart) / 1000).toFixed(1)}s`,
      );
    }
    if (!writingStarted) {
      yield activity('writing', 'writing', 'start', 'Writing the answer');
    }

    if (!answer.trim()) {
      yield activity('writing', 'writing', 'error', 'Empty answer');
      yield { type: 'error', message: 'The model returned an empty answer. Try again.' };
      return;
    }

    yield activity(
      'writing',
      'writing',
      'done',
      'Answer ready',
      `${wordCount(answer)} words`,
    );
  }

  if (signal?.aborted) return;

  const citations = checkCitations(answer, sources);
  timings.totalMs = Date.now() - startedAt;
  const finishedAt = deps.now();

  trace.rounds = rounds;
  trace.activities = activities;
  const tracePayload = { ...trace, citations, timings };

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
      traceJson: JSON.stringify(tracePayload),
    });
  } catch (error) {
    yield { type: 'error', message: `failed to save assistant turn: ${errorMessage(error)}` };
    return;
  }

  yield {
    type: 'done',
    turnId: assistantTurnId,
    citations,
    timings,
    reasoning: input.reasoning,
    rounds,
  };

  if (!noSearchResults) {
    try {
      const claims = await extractClaims(deps.llm, { answer, sources });
      for (const claim of claims) {
        insertClaim(deps.db, assistantTurnId, claim);
      }
    } catch (error) {
      console.error(`claim extraction failed: ${errorMessage(error)}`);
    }
  }
}
