import type { NewClaim } from './db.js';
import type { LLM } from './llm/types.js';
import type { Source } from './search/types.js';

export type ClaimInput = NewClaim;

const CLAIMS_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          claim: { type: 'string' },
          sourceId: { type: 'string' },
        },
        required: ['subject', 'claim', 'sourceId'],
      },
    },
  },
  required: ['claims'],
};

const SYSTEM = `You extract atomic factual claims from an assistant answer.
Return JSON matching the schema.

Rules:
- Only include claims that are factual and carry a citation marker [S#] in the answer.
- Each claim must be one atomic statement, not a paragraph.
- subject is a short label for what the claim is about, for example "HubSpot Sales Hub pricing".
- sourceId is the source id (for example "S1") of the citation attached to the claim.
- Do not include opinions, hedges, instructions, or claims without a citation.
- Return an empty list when there are no such claims.`;

export async function extractClaims(
  llm: LLM,
  input: { answer: string; sources: Source[] },
): Promise<ClaimInput[]> {
  const byId = new Map(input.sources.map((source) => [source.id, source]));
  const sourceLines = input.sources.map(
    (source) =>
      `<source id="${source.id}" url="${source.url}" published="${source.publishedDate ?? ''}">${source.title}</source>`,
  );
  const prompt = `${sourceLines.join('\n')}\n\nAssistant answer:\n${input.answer}`;

  try {
    const raw = await llm.json<unknown>({
      model: 'fast',
      system: SYSTEM,
      prompt,
      schema: CLAIMS_SCHEMA,
    });
    const items = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { claims?: unknown }).claims)
        ? ((raw as { claims: unknown[] }).claims)
        : [];
    const claims: ClaimInput[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const { subject, claim, sourceId } = item as Record<string, unknown>;
      if (typeof subject !== 'string' || typeof claim !== 'string' || typeof sourceId !== 'string') {
        continue;
      }
      const source = byId.get(sourceId);
      if (!source) continue;
      if (!subject.trim() || !claim.trim()) continue;
      claims.push({
        subject: subject.trim(),
        claim: claim.trim(),
        sourceUrl: source.url,
        sourceTitle: source.title,
        publishedDate: source.publishedDate,
        fetchedAt: source.fetchedAt,
      });
    }
    return claims;
  } catch {
    return [];
  }
}