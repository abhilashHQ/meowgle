import type { DatabaseSync } from 'node:sqlite';
import {
  getClaimsByTurnIds,
  getAllTurns,
  getRecentTurns,
  getTurnsInRange,
  type ClaimRow,
  type TurnRow,
} from './db.js';
import { addDays, daysBetween, resolveDates, type DateRef } from './dates.js';
import { extractKeywords } from './keywords.js';

export type NearbyTurns = {
  date: string;
  turns: TurnRow[];
};

export type Recall = {
  dateRefs: DateRef[];
  byDate: { ref: DateRef; turns: TurnRow[]; nearby: NearbyTurns | null }[];
  topical: TurnRow[];
  recent: TurnRow[];
  claims: ClaimRow[];
};

export type RecallInput = {
  message: string;
  now: Date;
  tz: string;
  conversationId: string;
  excludeTurnId?: number;
};

function matchesAnyKeyword(turn: TurnRow, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const content = turn.content.toLowerCase();
  return keywords.some((keyword) => content.includes(keyword));
}

function groupByDate(turns: TurnRow[]): Map<string, TurnRow[]> {
  const groups = new Map<string, TurnRow[]>();
  for (const turn of turns) {
    const group = groups.get(turn.local_date);
    if (group) group.push(turn);
    else groups.set(turn.local_date, [turn]);
  }
  return groups;
}

export function recall(db: DatabaseSync, input: RecallInput): Recall {
  const { message, now, tz, conversationId, excludeTurnId } = input;
  const dateRefs = resolveDates(message, now, tz);
  const keywords = extractKeywords(message);
  const inflightId = excludeTurnId;

  const byDate = dateRefs.map((ref) => {
    const turns = getTurnsInRange(db, ref.start, ref.end, inflightId);
    if (turns.length > 0) {
      return { ref, turns, nearby: null };
    }
    const window = getTurnsInRange(
      db,
      addDays(ref.start, -3),
      addDays(ref.end, 3),
      inflightId,
    );
    const matching = window.filter((turn) => matchesAnyKeyword(turn, keywords));
    if (matching.length === 0) {
      return { ref, turns, nearby: null };
    }
    const groups = groupByDate(matching);
    let best: NearbyTurns | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [date, list] of groups) {
      const distance =
        date < ref.start ? daysBetween(ref.start, date) : daysBetween(date, ref.end);
      if (
        distance < bestDistance ||
        (distance === bestDistance && best !== null && date > best.date)
      ) {
        bestDistance = distance;
        best = { date, turns: list };
      }
    }
    return { ref, turns, nearby: best };
  });

  const allTurns = getAllTurns(db, inflightId);
  const scored = allTurns
    .map((turn) => {
      const content = turn.content.toLowerCase();
      const score = keywords.filter((keyword) => content.includes(keyword)).length;
      return { turn, score };
    })
    .filter((entry) => entry.score >= 1)
    .sort((a, b) => b.score - a.score || b.turn.id - a.turn.id);
  const topical = scored.slice(0, 6).map((entry) => entry.turn);

  const recent = getRecentTurns(db, conversationId, 6, inflightId);

  const claimTurnIds = new Set<number>();
  for (const group of byDate) {
    for (const turn of group.turns) claimTurnIds.add(turn.id);
    if (group.nearby) {
      for (const turn of group.nearby.turns) claimTurnIds.add(turn.id);
    }
  }
  for (const turn of topical) claimTurnIds.add(turn.id);
  const claims = getClaimsByTurnIds(db, [...claimTurnIds]);

  return { dateRefs, byDate, topical, recent, claims };
}