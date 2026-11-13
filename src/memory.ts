import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Everything long-term: conversations, turns (question + answer + sources),
// and claims (checkable facts filed per turn by the extractor at the bottom).
export type Source = { n: number; url: string; title: string; fetched_at: string };
export type Claim = { entity: string; fact: string; value: string; source_url: string };
export type Complete = (body: Record<string, unknown>) => Promise<any>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  title TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  asked_at TEXT NOT NULL,
  tz TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  topic TEXT,
  entities TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  entity TEXT NOT NULL,
  fact TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);`;

// ---------------------------------------------------------------------------
// Date and timezone formatting
// ---------------------------------------------------------------------------

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The tz the client sent, or the last one stored, or UTC.
export function resolveTz(db: DatabaseSync, tz: unknown): string {
  if (isValidTz(tz)) return tz;
  const row = db.prepare('SELECT tz FROM turns ORDER BY id DESC LIMIT 1').get() as
    { tz: string } | undefined;
  return row?.tz ?? 'UTC';
}

// Weekday/day/month/year/time for one instant in one zone, computed once and
// reused by all the formatters below.
function parts(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    weekday: p.weekday,
    day: p.day,
    month: p.month,
    year: p.year,
    time: `${p.hour}:${p.minute}`,
  };
}

export function fmtStamp(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.weekday} ${p.day} ${p.month} ${p.year} ${p.time}`;
}

function fmtDay(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.day} ${p.month}`;
}

export function fmtDate(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

// The block shown at the top of every question: today, yesterday, then the
// 13 days before, each with its ISO date, so the model can resolve "Monday".
export function renderDateStrip(now: Date, tz: string): string {
  const isoDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = isoDay.format(now).split('-').map(Number);

  const days: string[] = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(Date.UTC(p[0], p[1] - 1, p[2] - i, 12)); // noon avoids DST edges
    const d = parts(date, 'UTC');
    const label = `${d.weekday} ${d.day} ${d.month} = ${date.toISOString().slice(0, 10)}`;
    days.push(i === 0 ? `${label} (today)` : i === 1 ? `${label} (yesterday)` : label);
  }
  return `Last 14 days:\n${days.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function startTurn(
  db: DatabaseSync,
  t: { conversationId?: string; question: string; tz: string; askedAt: string }
): { conversationId: string; turnId: number } {
  const conversationId = t.conversationId || randomUUID();
  db.prepare('INSERT OR IGNORE INTO conversations (id, created_at, title) VALUES (?, ?, ?)').run(
    conversationId,
    t.askedAt,
    t.question.slice(0, 60)
  );
  const r = db
    .prepare('INSERT INTO turns (conversation_id, asked_at, tz, question) VALUES (?, ?, ?, ?)')
    .run(conversationId, t.askedAt, t.tz, t.question);
  return { conversationId, turnId: Number(r.lastInsertRowid) };
}

export function finishTurn(
  db: DatabaseSync,
  turnId: number,
  answer: string,
  sources: Source[]
): void {
  db.prepare('UPDATE turns SET answer = ?, sources = ? WHERE id = ?').run(
    answer,
    JSON.stringify(sources),
    turnId
  );
}

type ChatMessage = { role: 'user' | 'assistant'; content: string };

// The last few question/answer pairs of this chat, for the model to see as
// history. Citations are stripped (they point at sources the model cannot
// see), empty answers are skipped, and everything but the newest answer is
// trimmed to 300 chars.
export function recentMessages(db: DatabaseSync, conversationId: string): ChatMessage[] {
  const rows = db
    .prepare(
      `
    SELECT question, answer FROM turns
    WHERE conversation_id = ? AND answer IS NOT NULL AND answer != ''
    ORDER BY id DESC LIMIT 4`
    )
    .all(conversationId) as { question: string; answer: string }[];
  rows.reverse();

  const messages: ChatMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const answer = rows[i].answer.replace(/\[\d+\]/g, '');
    const isNewest = i === rows.length - 1;
    const kept = isNewest || answer.length <= 300 ? answer : `${answer.slice(0, 300)}…`;
    messages.push(
      { role: 'user', content: rows[i].question },
      { role: 'assistant', content: kept }
    );
  }
  return messages;
}

// Every URL the model has ever cited, so open_page can re-fetch them live.
export function knownUrls(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT sources FROM turns WHERE answer IS NOT NULL').all() as {
    sources: string;
  }[];
  return new Set(rows.flatMap((r) => (JSON.parse(r.sources) as Source[]).map((s) => s.url)));
}

type TurnRow = {
  id: number;
  asked_at: string;
  question: string;
  answer: string | null;
  sources: string;
};

export function listConversations(db: DatabaseSync) {
  return db
    .prepare(
      `
    SELECT c.id, c.title, MAX(t.asked_at) AS updated_at FROM conversations c
    JOIN turns t ON t.conversation_id = c.id GROUP BY c.id ORDER BY updated_at DESC`
    )
    .all();
}

export function conversationTurns(db: DatabaseSync, id: string) {
  const rows = db
    .prepare(
      `
    SELECT id, asked_at, question, answer, sources FROM turns
    WHERE conversation_id = ? ORDER BY id`
    )
    .all(id) as TurnRow[];
  return rows.map((r) => ({ ...r, sources: JSON.parse(r.sources) as Source[] }));
}

// ---------------------------------------------------------------------------
// The ledger and saved findings, rendered into the prompt
// ---------------------------------------------------------------------------

type LedgerRow = {
  asked_at: string;
  question: string;
  topic: string | null;
  entities: string | null;
};

type FindingRow = {
  turn_id: number;
  asked_at: string;
  question: string;
  entity: string;
  fact: string;
  value: string;
  source_url: string;
  fetched_at: string;
};

const clip = (q: string) => (q.length > 200 ? `${q.slice(0, 200)}…` : q);

// Every question ever asked, one line each, oldest first. Lines carry the
// topic and entities when present; if the whole thing is over budget, the
// oldest lines are trimmed down to question + date only.
export function renderLedger(db: DatabaseSync, tz: string, maxChars = 30_000): string {
  const turns = db
    .prepare(
      'SELECT asked_at, question, topic, entities FROM turns WHERE answer IS NOT NULL ORDER BY id'
    )
    .all() as LedgerRow[];
  if (!turns.length) return 'No past questions yet.';

  const full: string[] = [];
  const short: string[] = [];
  for (const t of turns) {
    const head = `[${fmtStamp(new Date(t.asked_at), tz)}] "${clip(t.question)}"`;
    const entities = JSON.parse(t.entities ?? '[]') as string[];
    const aboutWho = entities.length ? `; about: ${entities.join(', ')}` : '';
    const about = t.topic ? ` (topic: ${t.topic}${aboutWho})` : '';
    full.push(head + about);
    short.push(head);
  }

  const lines = [...full];
  let total = lines.reduce((sum, l) => sum + l.length + 1, 0);
  for (let i = 0; i < lines.length && total > maxChars; i++) {
    total -= full[i].length - short[i].length;
    lines[i] = short[i];
  }
  return lines.join('\n');
}

// Claims filed for past questions, grouped under the question they came from,
// newest group first. Stops once the budget is reached.
export function renderFindings(db: DatabaseSync, tz: string, maxChars = 12_000): string {
  const rows = db
    .prepare(
      `
    SELECT c.turn_id, t.asked_at, t.question, c.entity, c.fact, c.value, c.source_url, c.fetched_at
    FROM claims c JOIN turns t ON t.id = c.turn_id ORDER BY t.id DESC, c.id`
    )
    .all() as FindingRow[];

  const blocks = new Map<number, string>();
  for (const r of rows) {
    const block =
      blocks.get(r.turn_id) ?? `[${fmtStamp(new Date(r.asked_at), tz)}] "${clip(r.question)}"`;
    const asOf = fmtDay(new Date(r.fetched_at), tz);
    blocks.set(
      r.turn_id,
      `${block}\n- ${r.entity} | ${r.fact}: ${r.value} (as of ${asOf}, ${r.source_url})`
    );
  }

  const kept: string[] = [];
  let size = 0;
  for (const block of blocks.values()) {
    if (size + block.length > maxChars) break;
    kept.push(block);
    size += block.length + 2;
  }
  return kept.join('\n\n');
}

// ---------------------------------------------------------------------------
// Claim validation
// ---------------------------------------------------------------------------

const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ''));
const normUrl = (u: string) => u.replace(/\/+$/, '');

// A value is supported when its numbers appear in the page text (or, for
// non-numeric values, when its meaningful words do).
function supports(value: string, text: string): boolean {
  const nums = numbers(value);
  if (nums.length) {
    const inText = new Set(numbers(text));
    return nums.every((n) => inText.has(n));
  }
  const low = text.toLowerCase();
  return value
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3)
    .every((w) => low.includes(w));
}

// Keeps only claims that survive three checks: all fields filled, every number
// in the value also stated in the answer, and the value supported by page text
// (the claim's own page first, then any other source of the turn).
export function validateClaims(
  claims: Claim[],
  answer: string,
  sources: Source[],
  texts: Map<string, string>
): (Claim & { fetched_at: string })[] {
  const inAnswer = new Set(numbers(answer));
  const byUrl = new Map(sources.map((s) => [normUrl(s.url), s]));

  const kept: (Claim & { fetched_at: string })[] = [];
  for (const c of claims) {
    if (!c.entity || !c.fact || !c.value) continue;
    if (!numbers(c.value).every((n) => inAnswer.has(n))) continue;

    const candidates = [byUrl.get(normUrl(String(c.source_url))), ...sources];
    const src = candidates.find((s) => s && supports(c.value, texts.get(s.url) ?? ''));
    if (!src) continue;

    const { entity, fact, value } = c;
    kept.push({ entity, fact, value, source_url: src.url, fetched_at: src.fetched_at });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// The extractor: files a finished turn into long-term memory
// ---------------------------------------------------------------------------

const SAVE_MEMORY = {
  type: 'function',
  function: {
    name: 'save_memory',
    description: 'File this exchange in long-term memory.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '2-5 words, e.g. "Postgres hosting pricing"' },
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Products or companies the question is about',
        },
        claims: {
          type: 'array',
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              entity: { type: 'string' },
              fact: { type: 'string', description: 'What the value is, e.g. "Launch plan price"' },
              value: {
                type: 'string',
                description: 'Bare value exactly as in the answer, e.g. "$19/month"',
              },
              source_url: {
                type: 'string',
                description: 'URL from the source list that supports it',
              },
            },
            required: ['entity', 'fact', 'value', 'source_url'],
          },
        },
      },
      required: ['topic', 'entities', 'claims'],
    },
  },
};

const EXTRACT_PROMPT = [
  `You file a research assistant's answers into long-term memory so it can later check whether they are still true.` +
    ` Call save_memory once.`,
  `- claims: up to 6 concrete, checkable facts stated in the answer,` +
    ` such as prices, plan limits, release dates, version numbers, launches.` +
    ` Prefer the ones the user would ask about again.`,
  `- value is the bare value as written in the answer ("$19/month", "10 GB", "v2.3"). No commentary or comparisons.`,
  `- source_url must be copied from the source list.`,
  `- Only facts the sources from this turn state. If the answer repeats facts from earlier in the chat, leave them out.`,
  `- fact names the thing and never contains the value. No relative times like "9 hours ago". No URLs as values.`,
  `- Small talk or answers with no checkable facts get an empty claims list.`,
].join('\n');

type StoredTurn = { question: string; answer: string | null; sources: string };

// Asks the LLM to file the turn's facts, validates them, then writes topic,
// entities and claims. Runs in the background after the answer is sent; a
// failure only means this turn is not remembered in detail.
export async function extractClaims(
  db: DatabaseSync,
  turnId: number,
  complete: Complete,
  texts: Map<string, string>
): Promise<void> {
  const turn = db
    .prepare('SELECT question, answer, sources FROM turns WHERE id = ?')
    .get(turnId) as StoredTurn | undefined;
  if (!turn?.answer) return;

  const sources = JSON.parse(turn.sources) as Source[];
  const sourceList = sources.map((s) => `[${s.n}] ${s.url} ${s.title}`).join('\n') || '(none)';
  const user = `Question: ${turn.question}\n\nAnswer:\n${turn.answer}\n\nSources:\n${sourceList}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await complete({
        messages: [
          { role: 'system', content: EXTRACT_PROMPT },
          { role: 'user', content: user },
        ],
        tools: [SAVE_MEMORY],
        tool_choice: 'required',
        reasoning_effort: 'low',
        max_tokens: 1500,
      });

      const args = JSON.parse(res.choices[0].message.tool_calls[0].function.arguments);
      const wellFormed =
        typeof args.topic === 'string' &&
        Array.isArray(args.entities) &&
        Array.isArray(args.claims);
      if (!wellFormed) throw new Error('bad shape');

      const kept = validateClaims(args.claims.slice(0, 6), turn.answer, sources, texts);
      const entities = args.entities.filter((e: unknown) => typeof e === 'string');

      db.prepare('UPDATE turns SET topic = ?, entities = ? WHERE id = ?').run(
        args.topic,
        JSON.stringify(entities),
        turnId
      );
      const insert = db.prepare(`
        INSERT INTO claims (turn_id, entity, fact, value, source_url, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const c of kept) {
        insert.run(turnId, c.entity, c.fact, c.value, c.source_url, c.fetched_at);
      }
      return;
    } catch (e) {
      if (attempt === 1) console.error(`extractClaims(${turnId}) failed:`, (e as Error).message);
    }
  }
}
