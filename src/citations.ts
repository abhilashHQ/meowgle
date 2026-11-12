export function checkCitations(
  answer: string,
  sources: { id: string }[],
): { valid: string[]; invalid: string[] } {
  const known = new Set(sources.map((source) => source.id));
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const match of answer.matchAll(/\[(S\d+(?:\s*,\s*S\d+)*)\]/g)) {
    for (const id of match[1].split(/\s*,\s*/)) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (known.has(id)) valid.push(id);
      else invalid.push(id);
    }
  }
  return { valid, invalid };
}