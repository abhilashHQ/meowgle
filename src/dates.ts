export type DateRef = {
  phrase: string;
  start: string;
  end: string;
};

const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const WEEKDAY_PATTERN = WEEKDAY_NAMES.join('|');

const MONTH_PATTERN =
  'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec';

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(tz);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    }
    dateFormatters.set(tz, formatter);
  }
  return formatter;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function civilDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function localDateOf(date: Date, tz: string): string {
  const parts = formatterFor(tz).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

export function weekdayNameOf(date: Date, tz: string): string {
  let formatter = weekdayFormatters.get(tz);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
    } catch {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' });
    }
    weekdayFormatters.set(tz, formatter);
  }
  return formatter.format(date);
}

function splitDate(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

export function addDays(value: string, days: number): string {
  const { year, month, day } = splitDate(value);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return civilDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export function daysBetween(a: string, b: string): number {
  const left = splitDate(a);
  const right = splitDate(b);
  const ms = Date.UTC(left.year, left.month - 1, left.day) - Date.UTC(right.year, right.month - 1, right.day);
  return Math.round(ms / 86_400_000);
}

export function weekdayOf(value: string): number {
  const { year, month, day } = splitDate(value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function mostRecentYearDate(month: number, day: number, today: string): string | null {
  const todayYear = Number(today.slice(0, 4));
  for (let year = todayYear; year >= todayYear - 8; year--) {
    if (!isValidDate(year, month, day)) continue;
    const candidate = civilDate(year, month, day);
    if (candidate <= today) return candidate;
  }
  return null;
}

function mostRecentWeekday(today: string, weekday: number): string {
  const diff = (weekdayOf(today) - weekday + 7) % 7 || 7;
  return addDays(today, -diff);
}

function mondayOfWeek(value: string): string {
  return addDays(value, -((weekdayOf(value) + 6) % 7));
}

export function resolveDates(text: string, now: Date, tz: string): DateRef[] {
  const today = localDateOf(now, tz);
  const lower = text.toLowerCase();
  const found: { from: number; to: number; ref: DateRef }[] = [];

  const overlaps = (from: number, to: number) =>
    found.some((item) => from < item.to && to > item.from);

  const add = (from: number, to: number, start: string, end: string = start) => {
    if (overlaps(from, to)) return;
    found.push({
      from,
      to,
      ref: { phrase: text.slice(from, to).trim(), start, end },
    });
  };

  const each = (pattern: RegExp, handle: (match: RegExpExecArray) => void) => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lower)) !== null) {
      handle(match);
      if (match.index === pattern.lastIndex) pattern.lastIndex++;
    }
  };

  each(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match) => {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isValidDate(year, month, day)) return;
    const date = civilDate(year, month, day);
    add(match.index, match.index + match[0].length, date);
  });

  const dayMonth = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?\\b`,
    'g',
  );
  each(dayMonth, (match) => {
    const day = Number(match[1]);
    const month = MONTHS[match[2]];
    if (!month) return;
    const explicitYear = match[3] ? Number(match[3]) : undefined;
    const date =
      explicitYear !== undefined
        ? isValidDate(explicitYear, month, day)
          ? civilDate(explicitYear, month, day)
          : null
        : mostRecentYearDate(month, day, today);
    if (!date) return;
    add(match.index, match.index + match[0].length, date);
  });

  const monthDay = new RegExp(
    `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
    'g',
  );
  each(monthDay, (match) => {
    const month = MONTHS[match[1]];
    const day = Number(match[2]);
    if (!month) return;
    const explicitYear = match[3] ? Number(match[3]) : undefined;
    const date =
      explicitYear !== undefined
        ? isValidDate(explicitYear, month, day)
          ? civilDate(explicitYear, month, day)
          : null
        : mostRecentYearDate(month, day, today);
    if (!date) return;
    add(match.index, match.index + match[0].length, date);
  });

  each(/\bthis\s+week\b/g, (match) => {
    const monday = mondayOfWeek(today);
    add(match.index, match.index + match[0].length, monday, today);
  });

  each(/\blast\s+week\b/g, (match) => {
    const monday = mondayOfWeek(today);
    add(match.index, match.index + match[0].length, addDays(monday, -7), addDays(monday, -1));
  });

  const lastWeekday = new RegExp(`\\blast\\s+(${WEEKDAY_PATTERN})\\b`, 'g');
  each(lastWeekday, (match) => {
    const weekday = WEEKDAY_NAMES.indexOf(match[1]);
    const date = mostRecentWeekday(today, weekday);
    add(match.index, match.index + match[0].length, date);
  });

  const onWeekday = new RegExp(`\\bon\\s+(${WEEKDAY_PATTERN})\\b`, 'g');
  each(onWeekday, (match) => {
    const weekday = WEEKDAY_NAMES.indexOf(match[1]);
    const date = mostRecentWeekday(today, weekday);
    add(match.index, match.index + match[0].length, date);
  });

  const bareWeekday = new RegExp(`\\b(${WEEKDAY_PATTERN})\\b`, 'g');
  each(bareWeekday, (match) => {
    const weekday = WEEKDAY_NAMES.indexOf(match[1]);
    const date = mostRecentWeekday(today, weekday);
    add(match.index, match.index + match[0].length, date);
  });

  each(/\byesterday\b/g, (match) => {
    add(match.index, match.index + match[0].length, addDays(today, -1));
  });

  each(/\btoday\b/g, (match) => {
    add(match.index, match.index + match[0].length, today);
  });

  each(/\b(\d{1,3})\s+days?\s+ago\b/g, (match) => {
    add(match.index, match.index + match[0].length, addDays(today, -Number(match[1])));
  });

  found.sort((a, b) => a.from - b.from);
  return found.map((item) => item.ref);
}