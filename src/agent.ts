import type { DatabaseSync } from 'node:sqlite';
import type { LLM, Message, ToolCall } from './llm.ts';
import { TOOL_SCHEMAS, type Book, type Tools } from './tools.ts';
import { buildMessages, refersToPast, toolFooter } from './prompt.ts';
import {
  extractClaims,
  finishTurn,
  knownUrls,
  recentMessages,
  renderFindings,
  renderLedger,
  resolveTz,
  startTurn,
  type Source,
} from './memory.ts';

export type Deps = { db: DatabaseSync; llm: LLM; tools: Tools; now?: () => Date };

// A turn gets at most this many model calls. The last one drops tools and
// forces a final answer.
const MAX_CALLS = 6;

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

// ---------------------------------------------------------------------------
// Answer cleanup
//
// gpt-oss emits odd unicode and its own citation syntax. cleanAnswer runs on
// every streamed chunk and on the final text. Each step is one pass; the
// order matters, so the steps are grouped and commented rather than chained
// into one expression.
// ---------------------------------------------------------------------------

// "[3, 7]" and "[2; 9]" become "[3][7]" and "[2][9]".
const splitCitationGroup = (_: string, list: string) =>
  list
    .split(/\s*[,;]\s*/)
    .map((n) => `[${n}]`)
    .join('');

export function cleanAnswer(text: string, valid: Set<number>): string {
  let t = text;

  // Unicode quirks: zero-width chars, non-breaking hyphen, bullets, and
  // narrow/non-breaking spaces glued into numbers, currencies and punctuation.
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, ''); // zero-width chars
  t = t.replace(/\u2011/g, '-'); // non-breaking hyphen
  t = t.replace(/^[ \t]*[\u2022\u25aa\u25e6\u2023][ \t]+/gm, '- '); // bullets -> list items
  t = t.replace(/(\d)[\u00A0\u202F](?=\d{3}(?!\d))/g, '$1,'); // 12 000 -> 12,000
  t = t.replace(/(\d)[\u00A0\u202F](?=[%/])/g, '$1'); // 70 % -> 70%
  t = t.replace(/([$\u20AC\u00A3\u20B9\u00A5])[\u00A0\u202F]/g, '$1'); // $ 5 -> $5
  t = t.replace(/\/[\u00A0\u202F]+/g, '/'); // $ / month -> $/month
  t = t.replace(/\([\u00A0\u202F]+/g, '(');
  t = t.replace(/[\u00A0\u202F]+\)/g, ')');
  t = t.replace(/[\u00A0\u202F]/g, ' '); // any remaining ones -> plain space

  // Unicode dashes: number ranges keep a hyphen, prose dashes become ", ".
  t = t.replace(/(\d)\s*[\u2013\u2014]\s*(?=\d)/g, '$1-'); // 5 - 6 -> 5-6
  t = t.replace(/(\S)\u2013(?=\S)/g, '$1-'); // word-word -> word-word
  t = t.replace(/\s*[\u2013\u2014]\s*/g, ', '); // remaining ones -> ", "

  // Citation markers from every shape the model emits -> plain [n].
  t = t.replace(/\s*\[n\]/g, ''); // literal [n] placeholder
  t = t.replace(/【(\d+)(?:†[^】]*)?】/g, '[$1]'); // 【3†L1-L2】
  t = t.replace(/\[(\d+)†[^\]]*\]/g, '[$1]'); // [2†source]
  t = t.replace(/\[(\d+(?:\s*[,;]\s*\d+)+)\](?!\()/g, splitCitationGroup); // [3, 7]

  // Keep only citations that point at sources fetched this turn, deduped.
  t = t.replace(/\s*\[(\d+)\]/g, (m, n) => (valid.has(Number(n)) ? m : ''));
  t = t.replace(/(\[\d+\])\1+/g, '$1'); // [2][2] -> [2]
  t = t.replace(/\s*\[(?:previous|ledger|sources?)\b[^\]]*\](?!\()/gi, ''); // [previous]

  return t;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// The text fed to the model in the final round, when tools are gone.
function finalTurn(findings: string[], footer: string): string {
  const instructions = [
    'Answer my question now from these results, citing them like [3].',
    'You have no tools now, so write the answer itself and never say you are going to search or open anything.',
    'Say plainly what you could not confirm.',
  ].join(' ');

  return [
    'Your research for this question is finished. Here is everything your searches returned:',
    findings.join('\n\n'),
    instructions,
    footer,
  ].join('\n\n');
}

// While streaming, a citation marker can be half-arrived ("A ["). cleanAnswer
// would mangle it, so everything from the last unclosed bracket on is held
// back until the bracket closes. A trailing dash is held back the same way so
// "5 - 6" can become "5-6" once the 6 shows up.
function stablePrefix(raw: string): string {
  const open = Math.max(raw.lastIndexOf('['), raw.lastIndexOf('【'));
  const close = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('】'));
  const hasUnclosedBracket = open > close;
  return (hasUnclosedBracket ? raw.slice(0, open) : raw).replace(/[–—]\s*$/, '');
}

const isText = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isText).slice(0, max);
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

// Runs one tool call: yields progress events, returns the text the model gets
// back. Every source seen lands in `book`, the shared ledger for this turn.
async function* runTool(
  call: ToolCall,
  deps: Deps,
  book: Book,
  known: Set<string>
): AsyncGenerator<AgentEvent, string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return 'Error: tool arguments were not valid JSON.';
  }

  if (call.function.name === 'web_search') {
    const queries = strings(args.queries, 8);
    if (!queries.length) return 'Error: queries must be a non-empty list of strings.';
    const since = isDay(args.since) ? args.since : undefined;

    yield { type: 'search', queries, ...(since ? { since } : {}) };
    const r = await deps.tools.webSearch({ queries, since }, book);
    yield { type: 'search_done', results: r.ok, domains: r.domains };
    return r.text;
  }

  if (call.function.name === 'open_page') {
    const urls = strings(args.urls, 5);
    if (!urls.length) return 'Error: urls must be a non-empty list of strings.';
    const focus = typeof args.focus === 'string' && args.focus.trim() ? args.focus : undefined;
    const live = urls.some((u) => known.has(u)); // known URLs get fetched fresh

    yield { type: 'open', urls, live };
    const r = await deps.tools.openPage({ urls, focus }, book, live);
    yield { type: 'open_done', ok: r.ok, failed: r.failed };
    return r.text;
  }

  return `Error: unknown tool ${call.function.name}.`;
}

// ---------------------------------------------------------------------------
// The turn loop
// ---------------------------------------------------------------------------

// One user question, end to end:
//   1. persist the turn and resolve the timezone
//   2. build the opening messages (system, ledger, findings, history, question)
//   3. up to MAX_CALLS model calls; tool calls run and results go back in;
//      the last call drops tools and forces a final answer
//   4. clean up the answer, persist it with the sources it cited
//   5. file findings into long-term memory in the background
export async function* runTurn(
  deps: Deps,
  req: { conversationId?: string; message: string; tz?: string; effort?: 'low' | 'medium' | 'high' }
): AsyncGenerator<AgentEvent> {
  const started = Date.now();
  const { db, llm } = deps;
  const now = deps.now?.() ?? new Date();
  const tz = resolveTz(db, req.tz);

  // -- 1. persist the turn before any work starts
  const { conversationId, turnId } = startTurn(db, {
    conversationId: req.conversationId,
    question: req.message,
    tz,
    askedAt: now.toISOString(),
  });
  yield { type: 'start', conversationId, turnId };

  // -- 2. opening context, never mutated
  const base: Message[] = buildMessages({
    ledger: renderLedger(db, tz),
    findings: refersToPast(req.message) ? renderFindings(db, tz) : '',
    history: recentMessages(db, conversationId),
    now,
    tz,
    question: req.message,
  });

  // -- 3. tool rounds
  const messages = [...base]; // grows with each round
  const findings: string[] = []; // tool output, reused in the final prompt
  const footer = toolFooter(now, tz, req.message);
  const book: Book = new Map(); // every source seen this turn, numbered
  const known = knownUrls(db);
  const valid = () => new Set([...book.values()].map((s) => s.n));

  let raw = ''; // model text of the current round
  let sent = 0; // how much of it was streamed already
  let answer = '';
  let cited = new Set<number>();
  let failure: string | undefined;

  try {
    for (let call = 1; call <= MAX_CALLS; call++) {
      const isLast = call === MAX_CALLS;
      let toolCalls: ToolCall[] = [];
      const effort = req.effort ? { reasoning_effort: req.effort } : {};

      let body: Record<string, unknown>;
      if (isLast) {
        const wrapUp: Message = { role: 'user', content: finalTurn(findings, footer) };
        body = { messages: [...base, wrapUp], max_tokens: 4000, ...effort };
      } else {
        body = { messages, max_tokens: 4000, tools: TOOL_SCHEMAS, ...effort };
      }

      for await (const chunk of llm.stream(body)) {
        if (chunk.kind === 'reasoning') {
          yield { type: 'thinking', text: chunk.text };
        } else if (chunk.kind === 'tools') {
          toolCalls = chunk.calls;
        } else {
          raw += chunk.text;
          // stream the cleaned prefix that is safe to show so far
          const shown = cleanAnswer(stablePrefix(raw), valid()).trim();
          if (shown.length > sent) {
            yield { type: 'answer', text: shown.slice(sent) };
            sent = shown.length;
          }
        }
      }

      if (isLast || !toolCalls.length) break;

      // the model narrated instead of calling a tool: retract it into thinking
      if (raw) {
        if (sent) yield { type: 'answer_reset' };
        yield { type: 'thinking', text: raw };
        raw = '';
        sent = 0;
      }

      // run each tool call and feed the results back in
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
    // whatever happened above, persist the final answer and its sources
    answer = cleanAnswer(raw, valid()).trim();
    cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const sources: Source[] = [...book.values()]
      .filter((s) => cited.has(s.n) || s.opened)
      .map(({ n, url, title, fetched_at }) => ({ n, url, title, fetched_at }));
    finishTurn(db, turnId, answer, sources);
  }

  // -- 4. send what was not streamed yet, list sources, report failures
  if (!answer && !failure) failure = 'The model returned an empty answer.';
  if (answer.length > sent) yield { type: 'answer', text: answer.slice(sent) };

  const shown = [...book.values()]
    .filter((s) => cited.has(s.n))
    .map(({ n, url, title }) => ({ n, url, title }));
  if (shown.length) yield { type: 'sources', sources: shown };

  if (failure) {
    yield { type: 'error', message: failure };
    return;
  }

  // -- 5. filing findings happens in the background; the turn is over
  const texts = new Map([...book.values()].map((s) => [s.url, s.text]));
  extractClaims(db, turnId, llm.complete, texts).catch((e) => console.error('extractClaims:', e));
  yield { type: 'done', ms: Date.now() - started };
}
