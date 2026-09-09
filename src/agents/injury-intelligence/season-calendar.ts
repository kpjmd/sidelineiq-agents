import type { SportKey } from '../../types.js';

/**
 * A computed CALENDAR REFERENCE block for the date-resolution prompt.
 *
 * The resolver had no year logic at all — one clause in the confidence ladder
 * ("with an unambiguous year") presupposed the judgement it was asking for, and
 * nothing in code or prompt said that an NFL/NBA/PL season straddles the
 * calendar year. Reported live: with today = 2026-09-09, three December
 * injuries resolved to the December BEFORE the most recent one, every MD
 * correction being exactly +1 year (Micah Parsons 2024-12-14 → 2025-12-14,
 * Patrick Mahomes 2024-12-15 → 2025-12-15, Noah Sewell 2024-12-28 →
 * 2025-12-28). OTM, reading the same source, got the year right both times.
 *
 * So the arithmetic is done HERE, in code, and handed to the model as fact.
 * The model is told the block is authoritative; asking it to derive
 * "the most recent past December" from a bare `Current date` is asking for the
 * step it demonstrably gets wrong.
 *
 * Second job: the local calendar date. Both temporal signals the resolver
 * receives are UTC — `today` is `new Date().toISOString().slice(0, 10)` in the
 * poller, and the prompt carries `reportedAt.toISOString()` — while every rule
 * in DATE_ANCHORING_SHARED ("the most recent occurrence of that weekday on or
 * before Reported at") reasons about a LOCAL calendar. A feed row stamped
 * 2026-08-19T00:14:00Z is the evening of Aug 18 in the US, and the observed
 * one-day flip-flops (08-19 ↔ 08-20 four times on Danny Pinter, 08-23 ↔ 08-24
 * on Ashton Jeanty, and two cases where the system reverted an MD's date by
 * exactly one day) are all consistent with resolving relative language against
 * a UTC instant that names a different local day than the source's author
 * meant.
 */

/** A sport's season spans, as the prompt states them. */
export interface SeasonSpans {
  /** e.g. 2026 — the calendar year the current (or upcoming) season STARTS in. */
  currentSeasonYear: number;
  /** Prose lines describing the current and previous season spans. */
  lines: string[];
}

interface SeasonShape {
  /** 1-indexed month the season starts in. */
  startMonth: number;
  /** 1-indexed month the season ends in, in the FOLLOWING calendar year. */
  endMonth: number;
  /** How the league itself names a season: '2025' (NFL) or '2025-26' (NBA/PL). */
  label: 'single' | 'span';
  /** Displayed name of the league for the prompt line. */
  name: string;
}

/**
 * Deliberately NOT `significance-config.json`'s `sport_seasons`. Those windows
 * are publishing-threshold knobs (`threshold_delta`), and binding the prompt to
 * them would mean a threshold edit silently rewrites what the model is told
 * about the calendar. `tests/season-calendar.test.ts` pins the two tables
 * against each other on the month boundaries so they cannot drift unnoticed.
 */
const SPORT_SEASON_SHAPES: Partial<Record<SportKey, SeasonShape>> = {
  NFL: { startMonth: 9, endMonth: 2, label: 'single', name: 'NFL' },
  NBA: { startMonth: 10, endMonth: 6, label: 'span', name: 'NBA' },
  PREMIER_LEAGUE: { startMonth: 8, endMonth: 5, label: 'span', name: 'Premier League' },
  // UFC has no season. Emitting an invented one would be worse than emitting
  // none — the month table alone is the honest answer for an individual sport.
};

/** IANA zone the sport's reporting is written in. */
const SPORT_TIMEZONE: Record<SportKey, string> = {
  NFL: 'America/New_York',
  NBA: 'America/New_York',
  UFC: 'America/New_York',
  PREMIER_LEAGUE: 'Europe/London',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/** Parse a `YYYY-MM-DD` into [year, month(1-12), day], or null. */
export function parseIsoDate(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Round-trip through UTC so 2026-02-30 is rejected rather than rolled over.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return [y, mo, d];
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isoFromUtc(dt: Date): string {
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * The most recent PAST-OR-CURRENT occurrence of `month` (1-12) relative to
 * `today`, as `YYYY-MM`.
 *
 * The current month maps to ITSELF: "in September", said on 2026-09-09, means
 * this September, not last one. Every other month walks back at most one year.
 */
export function mostRecentMonthOccurrence(today: string, month: number): string {
  const parsed = parseIsoDate(today);
  if (!parsed) throw new Error(`mostRecentMonthOccurrence: bad today '${today}'`);
  const [year, todayMonth] = parsed;
  const y = month <= todayMonth ? year : year - 1;
  return `${y}-${pad2(month)}`;
}

/** First Monday of September in `year`, as a UTC Date. Labor Day. */
function laborDay(year: number): Date {
  const sept1 = new Date(Date.UTC(year, 8, 1));
  const shift = (8 - sept1.getUTCDay()) % 7; // 0 = Sunday, 1 = Monday
  return new Date(Date.UTC(year, 8, 1 + shift));
}

/**
 * NFL Week 1 kickoff: the Thursday after Labor Day. Week N is (N-1) weeks
 * later. Exact enough to place "Week 14 of last season" in the right MONTH,
 * which is the whole job here — the failure being fixed is a 365-day error,
 * not a 3-day one.
 */
export function nflWeekDate(seasonYear: number, week: number): string {
  const kickoff = laborDay(seasonYear).getTime() + 3 * 86_400_000;
  return isoFromUtc(new Date(kickoff + (week - 1) * 7 * 86_400_000));
}

export function nflKickoff(seasonYear: number): string {
  return nflWeekDate(seasonYear, 1);
}

/**
 * Which season a date falls in, and the one before it.
 *
 * Returns null for a sport with no season (UFC), which is a real answer and
 * not a gap — see SPORT_SEASON_SHAPES.
 */
export function resolveSeasonSpans(sport: SportKey, today: string): SeasonSpans | null {
  const shape = SPORT_SEASON_SHAPES[sport];
  if (!shape) return null;
  const parsed = parseIsoDate(today);
  if (!parsed) throw new Error(`resolveSeasonSpans: bad today '${today}'`);
  const [year, month] = parsed;

  // A season that starts in month S and ends in month E of the NEXT year
  // covers [S..12] of its start year and [1..E] of the following one. A date
  // at or after S belongs to the season starting THIS year; a date at or
  // before E belongs to the season that started LAST year; anything between
  // E and S is the offseason, and the season that just ended is the relevant
  // "current" one for a reader in August.
  const currentSeasonYear = month >= shape.startMonth ? year : year - 1;

  const seasonLabel = (startYear: number): string =>
    shape.label === 'single' ? String(startYear) : `${startYear}-${pad2((startYear + 1) % 100)}`;

  const spanText = (startYear: number): string =>
    `${MONTH_NAMES[shape.startMonth - 1]} ${startYear} through ` +
    `${MONTH_NAMES[shape.endMonth - 1]} ${startYear + 1}`;

  const lines = [
    `${shape.name} "${seasonLabel(currentSeasonYear)} season" = ${spanText(currentSeasonYear)}` +
      (sport === 'NFL' ? ` (Week 1 kickoff ${nflKickoff(currentSeasonYear)})` : ' (approximate)'),
    `${shape.name} "${seasonLabel(currentSeasonYear - 1)} season" = ${spanText(currentSeasonYear - 1)}` +
      (sport === 'NFL' ? ` (Week 1 kickoff ${nflKickoff(currentSeasonYear - 1)})` : ' (approximate)'),
  ];

  return { currentSeasonYear, lines };
}

/**
 * The calendar date `instant` falls on in the sport's own timezone, plus its
 * weekday. `en-CA` because it formats as YYYY-MM-DD.
 */
export function localCalendarDate(instant: Date, sport: SportKey): { date: string; weekday: string } {
  const timeZone = SPORT_TIMEZONE[sport] ?? 'America/New_York';
  const date = instant.toLocaleDateString('en-CA', { timeZone });
  const weekday = instant.toLocaleDateString('en-US', { timeZone, weekday: 'long' });
  return { date, weekday };
}

function utcWeekday(iso: string): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) return 'unknown';
  const [y, m, d] = parsed;
  return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * The block prepended to BOTH resolver passes. Stated as computed and
 * authoritative, because the arithmetic it replaces is the arithmetic the
 * model got wrong.
 */
export function buildCalendarBlock(input: {
  today: string;
  reportedAt: Date;
  sport: SportKey;
}): string {
  const { today, reportedAt, sport } = input;
  const local = localCalendarDate(reportedAt, sport);
  const utcDate = reportedAt.toISOString().slice(0, 10);

  const months = MONTH_NAMES.map(
    (name, i) => `${name} → ${mostRecentMonthOccurrence(today, i + 1)}`,
  ).join(', ');

  const spans = resolveSeasonSpans(sport, today);
  const seasonLines = spans
    ? `\n${spans.lines.map((l) => `  ${l}`).join('\n')}`
    : '\n  (This sport has no season — resolve dates from the calendar alone.)';

  return `CALENDAR REFERENCE (computed — AUTHORITATIVE, do not re-derive):
  Today: ${today} (${utcWeekday(today)}).
  Reported at: ${reportedAt.toISOString()} — UTC calendar date ${utcDate} (${utcWeekday(utcDate)}); LOCAL calendar date where this is reported ${local.date} (${local.weekday}). Resolve weekday and "today"/"yesterday" language against the LOCAL date.
  Most recent past-or-current occurrence of each month: ${months}.
  Seasons:${seasonLines}`;
}
