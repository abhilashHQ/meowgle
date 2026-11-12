import type { LLM } from './llm/types.js';
import type { Recall } from './recall.js';
import { localDateOf, weekdayNameOf } from './dates.js';

export type Plan = {
  level: 'instant' | 'quick';
  queries: string[];
  recheckClaimIds: number[];
  reason: string;
};

export type PlanInput = {
  message: string;
  recall: Recall;
  now: Date;
  tz: string;
  forcedLevel?: 'instant' | 'quick';
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'string', enum: ['instant', 'quick'] },
    queries: { type: 'array', items: { type: 'string' } },
    recheckClaimIds: { type: 'array', items: { type: 'number' } },
    reason: { type: 'string' },
  },
  required: ['level', 'queries', 'recheckClaimIds', 'reason'],
};

const SYSTEM = `You are the planner for a chat assistant whose only tool is web search.
Return JSON that matches the schema.

Rules:
- "instant": greetings, chit-chat, pure reasoning, or questions answerable entirely from memory (for example "what did I ask on 3 Nov?" with no question about whether the answer is still correct). queries must be [].
- "quick": anything needing current facts, or any "still correct / changed since / latest" question. Provide 1 to 4 standalone search queries.
- For re-checks, write one query per product aimed at its current official page (for example "Neon pricing plans"), not news about it.
- Never search for the user's own chat history. If the user asks about a past turn and memory has no record for that date and no nearby match, use "instant": there is nothing to verify.
- Queries must be self-contained: resolve pronouns and follow-ups using the memory below, include entity names, and include the current year/month when freshness matters.
- recheckClaimIds: ids from the claims below that the user is asking to verify. Use [] otherwise.
- reason: one short sentence explaining the choice.`;

function formatTurn(turn: Recall['topical'][number]): string {
  return `[${turn.local_date} ${turn.role}] ${turn.content}`;
}

function buildContext(input: PlanInput): string {
  const lines: string[] = [];
  lines.push(
    `Today is ${localDateOf(input.now, input.tz)} (${weekdayNameOf(input.now, input.tz)}), timezone ${input.tz}.`,
  );

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

function normalize(raw: unknown): Plan {
  if (!raw || typeof raw !== 'object') throw new Error('plan response is not an object');
  const value = raw as Record<string, unknown>;
  if (value.level !== 'instant' && value.level !== 'quick') {
    throw new Error('plan response has an invalid level');
  }
  const queries = Array.isArray(value.queries)
    ? value.queries
        .filter((query): query is string => typeof query === 'string' && query.trim().length > 0)
        .map((query) => query.trim())
        .slice(0, 4)
    : [];
  const recheckClaimIds = Array.isArray(value.recheckClaimIds)
    ? value.recheckClaimIds.filter(
        (id): id is number => typeof id === 'number' && Number.isInteger(id),
      )
    : [];
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  return { level: value.level, queries, recheckClaimIds, reason };
}

export async function plan(llm: LLM, input: PlanInput): Promise<Plan> {
  let result: Plan;
  try {
    const raw = await llm.json<unknown>({
      model: 'fast',
      system: SYSTEM,
      prompt: buildContext(input),
      schema: PLAN_SCHEMA,
    });
    result = normalize(raw);
    if (result.level === 'instant') {
      result = { ...result, queries: [] };
    } else if (result.queries.length === 0) {
      result = { ...result, queries: [input.message] };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`planner failed, falling back to raw-message search: ${detail}`);
    result = {
      level: 'quick',
      queries: [input.message],
      recheckClaimIds: [],
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