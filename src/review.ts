import type { ClaimRow } from './db.js';
import { localDateOf } from './dates.js';
import { friendlyError } from './errors.js';
import type { LLM, Reasoning } from './llm/types.js';
import type { Source } from './search/types.js';

export type Review = {
  available: boolean;
  enough: boolean;
  gaps: string[];
  followUpQueries: string[];
  reason: string;
};

type ReviewInput = {
  message: string;
  sources: Source[];
  claims: ClaimRow[];
  previousQueries: string[];
  maxQueries: number;
  reasoning: Reasoning;
  now: Date;
  tz: string;
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    enough: { type: 'boolean' },
    gaps: { type: 'array', items: { type: 'string' } },
    followUpQueries: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['enough', 'gaps', 'followUpQueries', 'reason'],
};

const SYSTEM = `You are the research reviewer for a chat assistant. You get the user's question, the search queries already run, and the sources fetched so far. Decide whether the sources are enough to answer well.

Rules:
- enough is true only when the sources cover the core of the question with specific, current facts. Generic blog summaries do not cover a question about exact pricing, limits, dates, or current state.
- For "latest / current / still correct" questions, enough requires a recent source that states the fact directly.
- If stored claims are listed, check each one against the sources. A claim without source coverage is a gap.
- gaps: list specific missing facts, not topics. Empty when enough is true.
- followUpQueries: targeted queries that fill the biggest gaps. At most the budget given below. Self-contained, with entity names and the current month/year when freshness matters. Never repeat a query already run. Prefer official or primary sources.
- reason: one short sentence.
- Do not answer the question. Only review.`;

function buildPrompt(input: ReviewInput): string {
  const lines: string[] = [];
  lines.push(
    `Today is ${localDateOf(input.now, input.tz)}. Query budget for follow-ups: ${input.maxQueries}.`,
  );
  lines.push(`User question: ${input.message}`);
  lines.push(`Queries already run: ${input.previousQueries.join(' | ') || '(none)'}`);

  if (input.claims.length > 0) {
    lines.push('Stored claims being rechecked:');
    for (const claim of input.claims) {
      lines.push(`  [C${claim.id}] (${claim.subject}) ${claim.claim}`);
    }
  }

  lines.push('Sources:');
  for (const source of input.sources) {
    const published = source.publishedDate ?? 'unknown';
    lines.push(
      `<source id="${source.id}" url="${source.url}" published="${published}">${source.title}: ${source.excerpt.slice(0, 1200)}</source>`,
    );
  }
  return lines.join('\n');
}

export async function reviewSources(
  llm: LLM,
  input: ReviewInput,
): Promise<Review> {
  try {
    const raw = await llm.json<unknown>({
      model: 'fast',
      system: SYSTEM,
      prompt: buildPrompt(input),
      schema: REVIEW_SCHEMA,
      reasoning: input.reasoning,
    });
    if (!raw || typeof raw !== 'object') throw new Error('review response is not an object');
    const value = raw as Record<string, unknown>;
    const gaps = Array.isArray(value.gaps)
      ? value.gaps.filter((gap): gap is string => typeof gap === 'string' && gap.trim().length > 0)
      : [];
    const followUpQueries = Array.isArray(value.followUpQueries)
      ? value.followUpQueries
          .filter((query): query is string => typeof query === 'string' && query.trim().length > 0)
          .map((query) => query.trim())
          .slice(0, input.maxQueries)
      : [];
    return {
      available: true,
      enough: value.enough === true,
      gaps: gaps.slice(0, 5),
      followUpQueries: value.enough === true ? [] : followUpQueries,
      reason: typeof value.reason === 'string' ? value.reason.trim() : '',
    };
  } catch (error) {
    const detail = friendlyError(error);
    console.error(`source review failed, keeping current sources: ${detail}`);
    return {
      available: false,
      enough: true,
      gaps: [],
      followUpQueries: [],
      reason: `review unavailable (${detail.slice(0, 120)})`,
    };
  }
}
