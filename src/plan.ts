import type { LLM, Reasoning } from './llm/types.js';
import type { Recall } from './recall.js';
import { localDateOf, weekdayNameOf } from './dates.js';
import { friendlyError } from './errors.js';

export type Plan = {
  level: 'instant' | 'quick';
  queries: string[];
  recheckClaimIds: number[];
  objective: string;
  reason: string;
};

export type PlanInput = {
  message: string;
  recall: Recall;
  now: Date;
  tz: string;
  reasoning: Reasoning;
  forcedLevel?: 'instant' | 'quick';
};

export const QUERY_BUDGET: Record<Reasoning, number> = {
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
};

const SMALL_TALK =
  /^(?:hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|got it|good (?:morning|afternoon|evening)|how are you)(?:\s+there)?[\s!.,?]*$/i;

export function isSmallTalk(message: string): boolean {
  return SMALL_TALK.test(message.trim());
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'string', enum: ['instant', 'quick'] },
    queries: { type: 'array', items: { type: 'string' } },
    recheckClaimIds: { type: 'array', items: { type: 'number' } },
    objective: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['level', 'queries', 'recheckClaimIds', 'objective', 'reason'],
};

const SYSTEM = `You are the planner for a chat assistant whose only tool is web search.
Return JSON that matches the schema.

Rules:
- "instant": greetings, chit-chat, pure reasoning, or questions answerable entirely from memory (for example "what did I ask on 3 Nov?" with no question about whether the answer is still correct). queries must be [].
- "quick": anything needing current facts, or any "still correct / changed since / latest" question. Provide 1 to the query budget of standalone search queries.
- For re-checks, write one query per product aimed at its current official page (for example "Neon pricing plans"), not news about it.
- Never search for the user's own chat history. If the user asks about a past turn and memory has no record for that date and no nearby match, use "instant": there is nothing to verify.
- Queries must be self-contained: resolve pronouns and follow-ups using the memory below, include entity names, and include the current year/month when freshness matters.
- Split multi-part questions into one focused query per part. Do not pad the list with near-duplicates.
- objective: one sentence saying what a good result must contain, for example "the current official free-tier limits, with exact storage and compute figures". Search ranking uses this, so name the kind of page that should win.
- recheckClaimIds: ids from the claims below that the user is asking to verify. Use [] otherwise.
- reason: one short sentence explaining the choice.`;

const BUDGET_GUIDANCE: Record<Reasoning, string> = {
  low: 'Low research budget: prefer one focused query. Skip search for anything conversational or already in memory.',
  medium:
    'Medium research budget: up to 3 queries. Split a question only when it has clearly separate parts.',
  high:
    'High research budget: up to 4 queries. Split multi-part questions and cover official pages plus independent sources.',
  xhigh:
    'Extra-high research budget: up to 5 queries. Cover every part of the question from multiple angles; the agent will review results and run another round.',
};

function formatTurn(turn: Recall['topical'][number]): string {
  return `[${turn.local_date} ${turn.role}] ${turn.content}`;
}

function buildContext(input: PlanInput): string {
  const lines: string[] = [];
  lines.push(
    `Today is ${localDateOf(input.now, input.tz)} (${weekdayNameOf(input.now, input.tz)}), timezone ${input.tz}.`,
  );
  lines.push(BUDGET_GUIDANCE[input.reasoning]);

  const turns = new Map<number, Recall['topical'][number]>();
  for (const turn of input.recall.recent) turns.set(turn.id, turn);
  for (const group of input.recall.byDate) {
    for (const turn of group.turns) turns.set(turn.id, turn);
    if (group.nearby) {
      for (const turn of group.nearby.turns) turns.set(turn.id, turn);
    }
  }
  for (const turn of input.recall.topical) turns.set(turn.id, turn);

  const ordered = [...turns.values()].sort((a, b) => a.id - b.id);
  lines.push('Memory turns:');
  if (ordered.length === 0) {
    lines.push('  (none)');
  } else {
    for (const turn of ordered) lines.push(`  ${formatTurn(turn)}`);
  }

  lines.push('Claims:');
  if (input.recall.claims.length === 0) {
    lines.push('  (none)');
  } else {
    for (const claim of input.recall.claims) {
      lines.push(`  [C${claim.id}] (${claim.subject}) ${claim.claim}`);
    }
  }

  lines.push('User message:');
  lines.push(input.message);
  return lines.join('\n');
}

function normalize(raw: unknown, message: string, maxQueries: number): Plan {
  if (!raw || typeof raw !== 'object') throw new Error('plan response is not an object');
  const value = raw as Record<string, unknown>;
  if (value.level !== 'instant' && value.level !== 'quick') {
    throw new Error('plan response has an invalid level');
  }
  const queries = Array.isArray(value.queries)
    ? value.queries
        .filter((query): query is string => typeof query === 'string' && query.trim().length > 0)
        .map((query) => query.trim())
        .slice(0, maxQueries)
    : [];
  const recheckClaimIds = Array.isArray(value.recheckClaimIds)
    ? value.recheckClaimIds.filter(
        (id): id is number => typeof id === 'number' && Number.isInteger(id),
      )
    : [];
  const objective =
    typeof value.objective === 'string' && value.objective.trim().length > 0
      ? value.objective.trim()
      : message;
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  return { level: value.level, queries, recheckClaimIds, objective, reason };
}

export async function plan(llm: LLM, input: PlanInput): Promise<Plan> {
  const maxQueries = QUERY_BUDGET[input.reasoning];
  let result: Plan;
  try {
    const raw = await llm.json<unknown>({
      model: 'fast',
      system: SYSTEM,
      prompt: buildContext(input),
      schema: PLAN_SCHEMA,
    });
    result = normalize(raw, input.message, maxQueries);
    if (result.level === 'instant') {
      result = { ...result, queries: [] };
    } else if (result.queries.length === 0) {
      result = { ...result, queries: [input.message] };
    }
  } catch (error) {
    const detail = friendlyError(error);
    console.error(`planner failed, falling back to raw-message search: ${detail}`);
    result = isSmallTalk(input.message)
      ? {
          level: 'instant',
          queries: [],
          recheckClaimIds: [],
          objective: input.message,
          reason: 'small talk does not need a search',
        }
      : {
          level: 'quick',
          queries: [input.message],
          recheckClaimIds: [],
          objective: input.message,
          reason: `planner unavailable (${detail.slice(0, 120)}); searching the raw message`,
        };
  }

  const knownClaimIds = new Set(input.recall.claims.map((claim) => claim.id));
  result.recheckClaimIds = result.recheckClaimIds.filter((id) => knownClaimIds.has(id));

  if (input.forcedLevel) {
    result.level = input.forcedLevel;
    if (result.level === 'instant') {
      result.queries = [];
    } else if (result.queries.length === 0) {
      result.queries = [input.message];
    }
  }

  return result;
}
