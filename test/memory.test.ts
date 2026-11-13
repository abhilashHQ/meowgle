import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb,
  renderDateStrip,
  renderLedger,
  renderFindings,
  startTurn,
  finishTurn,
  validateClaims,
  extractClaims,
  resolveTz,
  recentMessages,
} from '../src/memory.ts';

const src = (n: number, url: string) => ({
  n,
  url,
  title: `T${n}`,
  fetched_at: '2026-11-10T08:32:00.000Z',
});

test('date strip labels today, yesterday and weekdays', () => {
  const strip = renderDateStrip(new Date('2026-11-12T10:00:00Z'), 'UTC');
  assert.match(
    strip,
    /^Last 14 days:\nThu 12 Nov = 2026-11-12 \(today\)\nWed 11 Nov = 2026-11-11 \(yesterday\)\nTue 10 Nov = 2026-11-10\nMon 9 Nov = 2026-11-09\n/
  );
  assert.match(strip, /Fri 30 Oct = 2026-10-30$/);
});

test('date strip uses the local day across the tz boundary', () => {
  const strip = renderDateStrip(new Date('2026-11-11T20:00:00Z'), 'Asia/Kolkata');
  assert.match(strip, /^Last 14 days:\nThu 12 Nov = 2026-11-12 \(today\)/);
});

test('empty log', () => {
  assert.equal(renderLedger(openDb(':memory:'), 'UTC'), 'No past questions yet.');
});

function seeded() {
  const db = openDb(':memory:');
  const a = startTurn(db, {
    question: 'Neon vs Supabase pricing?',
    tz: 'Asia/Kolkata',
    askedAt: '2026-11-10T08:32:00.000Z',
  });
  finishTurn(db, a.turnId, 'Neon Launch is $19/month [1].', [src(1, 'https://neon.com/pricing')]);
  db.prepare(
    'UPDATE turns SET topic = \'Postgres hosting\', entities = \'["Neon","Supabase"]\' WHERE id = ?'
  ).run(a.turnId);
  db.prepare(
    "INSERT INTO claims (turn_id, entity, fact, value, source_url, fetched_at) VALUES (?, 'Neon', 'Launch plan price', '$19/month', 'https://neon.com/pricing', '2026-11-10T08:32:00.000Z')"
  ).run(a.turnId);
  const b = startTurn(db, {
    conversationId: a.conversationId,
    question: 'And PlanetScale?',
    tz: 'Asia/Kolkata',
    askedAt: '2026-11-11T09:00:00.000Z',
  });
  finishTurn(db, b.turnId, 'x', [src(1, 'https://planetscale.com/pricing')]);
  startTurn(db, { question: 'in flight', tz: 'UTC', askedAt: '2026-11-12T09:00:00.000Z' });
  return db;
}

test('log shows questions, topics and entities but never claim values', () => {
  assert.deepEqual(renderLedger(seeded(), 'Asia/Kolkata').split('\n'), [
    '[Tue 10 Nov 2026 14:02] "Neon vs Supabase pricing?" (topic: Postgres hosting; about: Neon, Supabase)',
    '[Wed 11 Nov 2026 14:30] "And PlanetScale?"',
  ]);
});

test('saved findings group claims by question, newest first, with dates and URLs', () => {
  assert.equal(
    renderFindings(seeded(), 'Asia/Kolkata'),
    '[Tue 10 Nov 2026 14:02] "Neon vs Supabase pricing?"\n- Neon | Launch plan price: $19/month (as of 10 Nov, https://neon.com/pricing)'
  );
});

test('log truncates oldest lines first when over budget', () => {
  const db = openDb(':memory:');
  for (const day of [1, 2, 3]) {
    const t = startTurn(db, {
      question: `q${day}`,
      tz: 'UTC',
      askedAt: `2026-11-0${day}T10:00:00.000Z`,
    });
    finishTurn(db, t.turnId, 'a', []);
    db.prepare(`UPDATE turns SET topic = 'a fairly long topic name ${day}' WHERE id = ?`).run(
      t.turnId
    );
  }
  const lines = renderLedger(db, 'UTC', 160).split('\n');
  assert.equal(lines[0], '[Sun 1 Nov 2026 10:00] "q1"');
  assert.match(lines[2], /topic: a fairly long topic name 3\)$/);
});

test('claim validation requires the value in the answer and in its own page text', () => {
  const sources = [src(1, 'https://neon.com/pricing'), src(2, 'https://news.example/fir')];
  const texts = new Map([
    ['https://neon.com/pricing', 'Launch: $15/month. Billed yearly at $1,200.'],
    ['https://news.example/fir', 'Police filed an FIR on Monday against 40 people.'],
  ]);
  const answer =
    'Neon Launch dropped to $15/month from $1,200 a year [1]. His clip has 19 million views.';
  const kept = validateClaims(
    [
      {
        entity: 'Neon',
        fact: 'Launch price',
        value: '$15/month (dropped from $19/month)',
        source_url: 'https://neon.com/pricing',
      },
      {
        entity: 'Neon',
        fact: 'Launch price',
        value: '$15/month',
        source_url: 'https://neon.com/pricing/',
      },
      { entity: 'Neon', fact: 'Annual', value: '$1200', source_url: 'https://news.example/fir' },
      {
        entity: 'Kamra',
        fact: 'Clip views',
        value: '19 million',
        source_url: 'https://news.example/fir',
      },
    ],
    answer,
    sources,
    texts
  );
  assert.deepEqual(
    kept.map((c) => [c.value, c.source_url]),
    [
      ['$15/month', 'https://neon.com/pricing'],
      ['$1200', 'https://neon.com/pricing'],
    ]
  );
  assert.equal(kept[0].fetched_at, '2026-11-10T08:32:00.000Z');
});

test('extractClaims writes topic, entities and validated claims, retrying once', async () => {
  const db = openDb(':memory:');
  const t = startTurn(db, {
    question: 'Neon price?',
    tz: 'UTC',
    askedAt: '2026-11-10T08:32:00.000Z',
  });
  finishTurn(db, t.turnId, 'Neon Launch is $19/month [1].', [src(1, 'https://neon.com/pricing')]);
  let calls = 0;
  await extractClaims(
    db,
    t.turnId,
    async () => {
      if (calls++ === 0) return { choices: [{ message: { content: 'oops' } }] };
      const args = {
        topic: 'Neon pricing',
        entities: ['Neon'],
        claims: [
          {
            entity: 'Neon',
            fact: 'Launch plan price',
            value: '$19/month',
            source_url: 'https://neon.com/pricing',
          },
          {
            entity: 'Neon',
            fact: 'Scale plan price',
            value: '$69/month',
            source_url: 'https://neon.com/pricing',
          },
        ],
      };
      return {
        choices: [
          {
            message: {
              tool_calls: [{ function: { name: 'save_memory', arguments: JSON.stringify(args) } }],
            },
          },
        ],
      };
    },
    new Map([['https://neon.com/pricing', 'Launch $19/month, Scale $69/month']])
  );
  assert.equal(calls, 2);
  assert.match(renderLedger(db, 'UTC'), /\(topic: Neon pricing; about: Neon\)$/);
  assert.equal(renderFindings(db, 'UTC').split('\n').length, 2);
});

test('tz falls back to the last stored tz, then UTC', () => {
  const db = openDb(':memory:');
  assert.equal(resolveTz(db, 'Not/AZone'), 'UTC');
  startTurn(db, { question: 'q', tz: 'Asia/Kolkata', askedAt: '2026-11-10T08:32:00.000Z' });
  assert.equal(resolveTz(db, undefined), 'Asia/Kolkata');
  assert.equal(resolveTz(db, 'Europe/Berlin'), 'Europe/Berlin');
});

test('recent messages: this chat only, no citations, no empty answers, older answers trimmed', () => {
  const db = openDb(':memory:');
  const a = startTurn(db, { question: 'q1', tz: 'UTC', askedAt: '2026-11-10T08:32:00.000Z' });
  finishTurn(db, a.turnId, `long ${'x'.repeat(400)} [1].`, []);
  const empty = startTurn(db, {
    conversationId: a.conversationId,
    question: 'q2',
    tz: 'UTC',
    askedAt: '2026-11-10T08:33:00.000Z',
  });
  finishTurn(db, empty.turnId, '', []);
  const b = startTurn(db, {
    conversationId: a.conversationId,
    question: 'q3',
    tz: 'UTC',
    askedAt: '2026-11-10T08:34:00.000Z',
  });
  finishTurn(db, b.turnId, `newest ${'y'.repeat(400)} [2].`, []);
  const other = startTurn(db, {
    question: 'other chat',
    tz: 'UTC',
    askedAt: '2026-11-10T09:00:00.000Z',
  });
  finishTurn(db, other.turnId, 'x', []);
  const msgs = recentMessages(db, a.conversationId);
  assert.deepEqual(
    msgs.map((m) => m.content.slice(0, 6)),
    ['q1', 'long x', 'q3', 'newest']
  );
  assert.equal(msgs[1].content.length, 301);
  assert.ok(msgs[3].content.endsWith('y .'));
});
