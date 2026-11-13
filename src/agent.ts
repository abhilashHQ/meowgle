import type { DatabaseSync } from 'node:sqlite';
import type { LLM, Message, ToolCall } from './llm.ts';
import { TOOL_SCHEMAS, type Book, type Tools } from './tools.ts';
import { buildMessages, refersToPast, toolFooter } from './prompt.ts';
import { extractClaims, finishTurn, knownUrls, recentMessages, renderFindings, renderLedger, resolveTz, startTurn, type Source } from './memory.ts';

export type AgentEvent =
  | { type: 'start'; conversationId: string; turnId: number }
  | { type: 'thinking'; text: string }
  | { type: 'search'; queries: string[]; since?: string }
  | { type: 'search_done'; results: number; domains: string[] }
  | { type: 'open'; urls: string[]; live: boolean }
  | { type: 'open_done'; ok: number; failed: number }
  | { type: 'answer'; text: string }
  | { type: 'answer_reset' }
  | { type: 'sources'; sources: { n: number; url: string; title: string }[] }
  | { type: 'done'; ms: number }
  | { type: 'error'; message: string };

export type Deps = { db: DatabaseSync; llm: LLM; tools: Tools; now?: () => Date };

const MAX_CALLS = 6;

export function cleanAnswer(text: string, valid: Set<number>): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u2011/g, '-')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/【(\d+)(?:†[^】]*)?】/g, '[$1]')
    .replace(/\[(\d+)†[^\]]*\]/g, '[$1]')
    .replace(/\[(\d+(?:\s*[,;]\s*\d+)+)\](?!\()/g, (_, list: string) => list.split(/\s*[,;]\s*/).map((n) => `[${n}]`).join(''))
    .replace(/\s*\[(\d+)\]/g, (m, n) => (valid.has(Number(n)) ? m : ''))
    .replace(/(\[\d+\])\1+/g, '$1')
    .replace(/\s*\[(?:previous|ledger|sources?)\b[^\]]*\](?!\()/gi, '');
}

const finalTurn = (findings: string[], footer: string) =>
  `Your research for this question is finished. Here is everything your searches returned:\n\n${findings.join('\n\n')}\n\nAnswer my question now from these results, citing them as [n]. Say plainly what you could not confirm.\n\n${footer}`;

function stablePrefix(raw: string): string {
  const open = Math.max(raw.lastIndexOf('['), raw.lastIndexOf('【'));
  const close = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('】'));
  return open > close ? raw.slice(0, open) : raw;
}

const strings = (v: unknown, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, max) : [];

async function* runTool(call: ToolCall, deps: Deps, book: Book, known: Set<string>): AsyncGenerator<AgentEvent, string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return 'Error: tool arguments were not valid JSON.';
  }

  if (call.function.name === 'web_search') {
    const queries = strings(args.queries, 8);
    if (!queries.length) return 'Error: queries must be a non-empty list of strings.';
    const since = typeof args.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.since) ? args.since : undefined;
    yield { type: 'search', queries, ...(since ? { since } : {}) };
    const r = await deps.tools.webSearch({ queries, since }, book);
    yield { type: 'search_done', results: r.ok, domains: r.domains };
    return r.text;
  }

  if (call.function.name === 'open_page') {
    const urls = strings(args.urls, 5);
    if (!urls.length) return 'Error: urls must be a non-empty list of strings.';
    const focus = typeof args.focus === 'string' && args.focus.trim() ? args.focus : undefined;
    const live = urls.some((u) => known.has(u));
    yield { type: 'open', urls, live };
    const r = await deps.tools.openPage({ urls, focus }, book, live);
    yield { type: 'open_done', ok: r.ok, failed: r.failed };
    return r.text;
  }

  return `Error: unknown tool ${call.function.name}.`;
}

export async function* runTurn(
  deps: Deps,
  req: { conversationId?: string; message: string; tz?: string; effort?: 'low' | 'medium' | 'high' },
): AsyncGenerator<AgentEvent> {
  const started = Date.now();
  const { db, llm } = deps;
  const now = deps.now?.() ?? new Date();
  const tz = resolveTz(db, req.tz);
  const { conversationId, turnId } = startTurn(db, { conversationId: req.conversationId, question: req.message, tz, askedAt: now.toISOString() });
  yield { type: 'start', conversationId, turnId };

  const base: Message[] = buildMessages({
    ledger: renderLedger(db, tz),
    findings: refersToPast(req.message) ? renderFindings(db, tz) : '',
    history: recentMessages(db, conversationId),
    now,
    tz,
    question: req.message,
  });
  const messages = [...base];
  const findings: string[] = [];
  const footer = toolFooter(now, tz, req.message);
  const book: Book = new Map();
  const known = knownUrls(db);
  const valid = () => new Set([...book.values()].map((s) => s.n));
  let raw = '';
  let sent = 0;
  let answer = '';
  let cited = new Set<number>();
  let failure: string | undefined;

  try {
    for (let call = 1; call <= MAX_CALLS; call++) {
      const last = call === MAX_CALLS;
      let toolCalls: ToolCall[] = [];
      const effort = req.effort ? { reasoning_effort: req.effort } : {};
      const body = last
        ? { messages: [...base, { role: 'user', content: finalTurn(findings, footer) }], max_tokens: 4000, ...effort }
        : { messages, max_tokens: 4000, tools: TOOL_SCHEMAS, ...effort };
      for await (const chunk of llm.stream(body)) {
        if (chunk.kind === 'reasoning') yield { type: 'thinking', text: chunk.text };
        else if (chunk.kind === 'tools') toolCalls = chunk.calls;
        else {
          raw += chunk.text;
          const shown = cleanAnswer(stablePrefix(raw), valid()).trim();
          if (shown.length > sent) {
            yield { type: 'answer', text: shown.slice(sent) };
            sent = shown.length;
          }
        }
      }
      if (last || !toolCalls.length) break;
      if (raw) {
        if (sent) yield { type: 'answer_reset' };
        yield { type: 'thinking', text: raw };
        raw = '';
        sent = 0;
      }
      messages.push({ role: 'assistant', content: '', tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const content = yield* runTool(tc, deps, book, known);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `${content}\n\n${footer}` });
        findings.push(content);
      }
    }
  } catch (e) {
    failure = (e as Error).message;
  } finally {
    answer = cleanAnswer(raw, valid()).trim();
    cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const sources: Source[] = [...book.values()]
      .filter((s) => cited.has(s.n) || s.opened)
      .map(({ n, url, title, fetched_at }) => ({ n, url, title, fetched_at }));
    finishTurn(db, turnId, answer, sources);
  }

  if (!answer && !failure) failure = 'The model returned an empty answer.';
  if (answer.length > sent) yield { type: 'answer', text: answer.slice(sent) };
  const shown = [...book.values()].filter((s) => cited.has(s.n)).map(({ n, url, title }) => ({ n, url, title }));
  if (shown.length) yield { type: 'sources', sources: shown };
  if (failure) {
    yield { type: 'error', message: failure };
    return;
  }
  const texts = new Map([...book.values()].map((s) => [s.url, s.text]));
  extractClaims(db, turnId, llm.complete, texts).catch((e) => console.error('extractClaims:', e));
  yield { type: 'done', ms: Date.now() - started };
}
