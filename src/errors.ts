function unwrapMessage(raw: string): string {
  let text = raw;
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === 'string') {
        text = parsed.error.message;
        continue;
      }
    } catch {
      // Not a wrapped API error.
    }
    break;
  }
  return text;
}

export function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = unwrapMessage(raw);
  if (/quota|rate limit|exceeded your current quota/i.test(text)) {
    return 'Gemini quota is used up for now';
  }
  if (/high demand|UNAVAILABLE|\b503\b/i.test(text)) {
    return 'Gemini is overloaded right now';
  }
  if (/timed out|aborted|AbortError/i.test(raw)) {
    return 'the model took too long to respond';
  }
  if (/fetch failed|network|ENOTFOUND|ECONNRESET|ECONNREFUSED/i.test(text)) {
    return 'could not reach Gemini';
  }
  return text;
}
