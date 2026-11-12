import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Role = 'user' | 'assistant';

export type TurnRow = {
  id: number;
  conversation_id: string;
  role: Role;
  content: string;
  created_at: string;
  local_date: string;
  tz: string;
  level: string | null;
  trace_json: string | null;
};

export type ClaimRow = {
  id: number;
  turn_id: number;
  subject: string;
  claim: string;
  source_url: string | null;
  source_title: string | null;
  published_date: string | null;
  fetched_at: string;
};

export type NewTurn = {
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
  localDate: string;
  tz: string;
  level?: string | null;
  traceJson?: string | null;
};

export type NewClaim = {
  subject: string;
  claim: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  publishedDate: string | null;
  fetchedAt: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  tz TEXT NOT NULL,
  level TEXT,
  trace_json TEXT
);
CREATE INDEX IF NOT EXISTS turns_local_date ON turns(local_date);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  subject TEXT NOT NULL,
  claim TEXT NOT NULL,
  source_url TEXT,
  source_title TEXT,
  published_date TEXT,
  fetched_at TEXT NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function insertTurn(db: DatabaseSync, t: NewTurn): number {
  const result = db
    .prepare(
      `INSERT INTO turns (conversation_id, role, content, created_at, local_date, tz, level, trace_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.conversationId,
      t.role,
      t.content,
      t.createdAt,
      t.localDate,
      t.tz,
      t.level ?? null,
      t.traceJson ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function insertClaim(db: DatabaseSync, turnId: number, c: NewClaim): number {
  const result = db
    .prepare(
      `INSERT INTO claims (turn_id, subject, claim, source_url, source_title, published_date, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(turnId, c.subject, c.claim, c.sourceUrl, c.sourceTitle, c.publishedDate, c.fetchedAt);
  return Number(result.lastInsertRowid);
}

export function getTurn(db: DatabaseSync, id: number): TurnRow | null {
  const row = db.prepare(`SELECT * FROM turns WHERE id = ?`).get(id);
  return (row as unknown as TurnRow | undefined) ?? null;
}

export function getTurnsByConversation(db: DatabaseSync, conversationId: string): TurnRow[] {
  return db
    .prepare(`SELECT * FROM turns WHERE conversation_id = ? ORDER BY id ASC`)
    .all(conversationId) as unknown as TurnRow[];
}

export function getTurnsInRange(
  db: DatabaseSync,
  start: string,
  end: string,
  excludeTurnId?: number,
): TurnRow[] {
  if (excludeTurnId !== undefined) {
    return db
      .prepare(
        `SELECT * FROM turns WHERE local_date >= ? AND local_date <= ? AND id != ? ORDER BY local_date ASC, id ASC`,
      )
      .all(start, end, excludeTurnId) as unknown as TurnRow[];
  }
  return db
    .prepare(
      `SELECT * FROM turns WHERE local_date >= ? AND local_date <= ? ORDER BY local_date ASC, id ASC`,
    )
    .all(start, end) as unknown as TurnRow[];
}

export function getRecentTurns(
  db: DatabaseSync,
  conversationId: string,
  limit: number,
  excludeTurnId?: number,
): TurnRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM turns WHERE conversation_id = ? AND id != ? ORDER BY id DESC LIMIT ?`,
    )
    .all(conversationId, excludeTurnId ?? -1, limit) as unknown as TurnRow[];
  return rows.reverse();
}

export function getAllTurns(db: DatabaseSync, excludeTurnId?: number): TurnRow[] {
  return db
    .prepare(`SELECT * FROM turns WHERE id != ? ORDER BY id ASC`)
    .all(excludeTurnId ?? -1) as unknown as TurnRow[];
}

export function getClaimsByTurnIds(db: DatabaseSync, turnIds: number[]): ClaimRow[] {
  if (turnIds.length === 0) return [];
  const placeholders = turnIds.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM claims WHERE turn_id IN (${placeholders}) ORDER BY id ASC`)
    .all(...turnIds) as unknown as ClaimRow[];
}