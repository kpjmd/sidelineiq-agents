import { parseIsoDate } from './season-calendar.js';
// Type-only, so this does not create a runtime cycle with date-resolution.ts,
// which imports validateResolvedDates from here.
import type { DateConfidence } from './date-resolution.js';

/**
 * Shape and plausibility checks on a resolved injury/surgery date, run inside
 * `toResult` so they apply to BOTH resolver passes — and, critically, BEFORE
 * the Pass-1 fast path reads the confidence.
 *
 * The resolver had no validation whatsoever: `toResult` only `.trim()`ed, so
 * anything the model typed reached the database call verbatim. Two live
 * consequences, both observed in production logs:
 *
 *  - `[ThreadManager] Jonathan Greenard — injury_date=2026-07` and
 *    `[ThreadManager] Mykel Williams — … surgery=2025-11`. The MCP schema is
 *    `z.string().date()`, which rejects `YYYY-MM`, and the MCP SDK reports a
 *    rejected tool call as a normal VALUE carrying `isError` rather than
 *    throwing. Nothing on the agents side looked, so the ENTIRE thread-date
 *    write — date, confidence, sources, needs_date_review — was silently
 *    discarded while the poller logged a success line. Williams' audit row
 *    records `previous_injury_date: null` when an MD hand-entered 2025-11-02
 *    two hours after the resolver had already "resolved" it to exactly that.
 *  - `injury_date=2024-12-15` emitted alongside `surgery_date=2025-12-15` at
 *    confidence `confirmed` (Patrick Mahomes). Surgery a full year AFTER the
 *    injury, from one emit, and the same calendar day — the signature of one
 *    of the two dates being resolved into the wrong year.
 *
 * Two classes of action, and the split is deliberate:
 *
 *  - DROP for anything structurally unusable (V1-V3). DATE_ANCHORING_SHARED
 *    already states the principle: "An absent date is recoverable downstream;
 *    a confidently wrong one is not."
 *  - DOWNGRADE for anything merely incoherent (V4, V6). The value may still be
 *    right, and a downgrade routes it to the two mechanisms that can
 *    adjudicate — `chooseDateAnchor` falls through to OTM's date below
 *    `probable`, and `needs_date_review` puts it on the MD worklist. Dropping
 *    there would destroy evidence the MD needs.
 *
 * Explicitly NOT done: salvaging `2026-07` to `2026-07-01`. Inventing a day is
 * precisely the confidently-wrong date the anchoring rules forbid, and every
 * RTP week is measured from it.
 *
 * The violations are reported, logged and audited but do NOT themselves force
 * MD review — the drop/downgrade already routes through the existing gates
 * (`unknown` sets needs_date_review; the carryover pair fires the date gate),
 * and a third gate here would grow the queue for cases already covered.
 */

export type DateViolationCode =
  | 'injury_date_malformed'
  | 'surgery_date_malformed'
  | 'injury_date_future'
  | 'surgery_date_future'
  | 'injury_date_absurdly_old'
  | 'surgery_before_injury'
  | 'surgery_injury_year_apart'
  | 'confidence_without_date';

export interface ResolvedDates {
  injury_date: string | null;
  injury_date_confidence: DateConfidence;
  surgery_date: string | null;
  surgery_confirmed: boolean;
}

export interface ValidatedDates extends ResolvedDates {
  violations: DateViolationCode[];
}

/** Oldest plausible anchor. RTP literature tops out near a year; anything six
 *  years back is career biography, the exact trap carryover.ts was written for. */
const MAX_AGE_YEARS = 6;

/** A same-calendar-day pair this far apart is a year error, not a delayed
 *  procedure. Wide enough for leap years and month-length drift. */
const YEAR_APART_MIN_DAYS = 300;
const YEAR_APART_MAX_DAYS = 430;
const SAME_DAY_TOLERANCE = 5;

const TIER_ORDER: DateConfidence[] = ['unknown', 'possible', 'probable', 'confirmed'];

function downgradeOneTier(c: DateConfidence): DateConfidence {
  const i = TIER_ORDER.indexOf(c);
  return i > 0 ? TIER_ORDER[i - 1] : c;
}

function capAt(c: DateConfidence, ceiling: DateConfidence): DateConfidence {
  return TIER_ORDER.indexOf(c) > TIER_ORDER.indexOf(ceiling) ? ceiling : c;
}

function toUtcMs(iso: string): number | null {
  const parsed = parseIsoDate(iso);
  if (!parsed) return null;
  const [y, m, d] = parsed;
  return Date.UTC(y, m - 1, d);
}

function daysBetween(aMs: number, bMs: number): number {
  return Math.round((bMs - aMs) / 86_400_000);
}

/** |a - b| measured only on month/day, wrapping the year end. */
function calendarDayGap(aIso: string, bIso: string): number {
  const a = parseIsoDate(aIso);
  const b = parseIsoDate(bIso);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  // Compare within an arbitrary common (non-leap) year, then wrap.
  const dayOf = ([, m, d]: [number, number, number]): number =>
    daysBetween(Date.UTC(2001, 0, 1), Date.UTC(2001, m - 1, Math.min(d, 28)));
  const raw = Math.abs(dayOf(a) - dayOf(b));
  return Math.min(raw, 365 - raw);
}

export function validateResolvedDates(
  input: ResolvedDates & { today: string },
): ValidatedDates {
  const violations: DateViolationCode[] = [];
  let injuryDate = input.injury_date;
  let surgeryDate = input.surgery_date;
  let confidence = input.injury_date_confidence;
  // surgery_confirmed is NEVER touched by a date problem: the repo treats
  // surgery CONFIRMATION and the surgery DATE as separate facts, and the
  // resolver prompt says so explicitly.
  const surgeryConfirmed = input.surgery_confirmed;

  const todayMs = toUtcMs(input.today);
  // Tolerance of one day absorbs the UTC-vs-local edge (`today` is computed
  // from toISOString() while the sport's calendar is US Eastern). More than a
  // day into the future is a hard error, not a timezone artefact.
  const futureCutoffMs = todayMs === null ? null : todayMs + 86_400_000;
  const oldestMs =
    todayMs === null ? null : todayMs - MAX_AGE_YEARS * 365.25 * 86_400_000;

  // ── V1/V2/V3 on the injury date ──────────────────────────────────────
  if (injuryDate !== null) {
    const ms = toUtcMs(injuryDate);
    if (ms === null) {
      violations.push('injury_date_malformed');
      injuryDate = null;
    } else if (futureCutoffMs !== null && ms > futureCutoffMs) {
      violations.push('injury_date_future');
      injuryDate = null;
    } else if (
      (oldestMs !== null && ms < oldestMs) ||
      (parseIsoDate(injuryDate)?.[0] ?? 0) < 1990
    ) {
      violations.push('injury_date_absurdly_old');
      injuryDate = null;
    }
  }

  // ── V1/V2 on the surgery date ────────────────────────────────────────
  if (surgeryDate !== null) {
    const ms = toUtcMs(surgeryDate);
    if (ms === null) {
      violations.push('surgery_date_malformed');
      surgeryDate = null;
    } else if (futureCutoffMs !== null && ms > futureCutoffMs) {
      violations.push('surgery_date_future');
      surgeryDate = null;
    }
  }

  // ── V4: surgery cannot precede the injury ────────────────────────────
  if (injuryDate !== null && surgeryDate !== null) {
    const inj = toUtcMs(injuryDate) as number;
    const sur = toUtcMs(surgeryDate) as number;
    if (sur < inj) {
      violations.push('surgery_before_injury');
      surgeryDate = null;
      confidence = downgradeOneTier(confidence);
    } else {
      // ── V6: the Mahomes signature ────────────────────────────────────
      const gap = daysBetween(inj, sur);
      if (
        gap >= YEAR_APART_MIN_DAYS &&
        gap <= YEAR_APART_MAX_DAYS &&
        calendarDayGap(injuryDate, surgeryDate) <= SAME_DAY_TOLERANCE
      ) {
        violations.push('surgery_injury_year_apart');
        confidence = capAt(confidence, 'possible');
      }
    }
  }

  // ── V5: a confidence tier is a claim ABOUT A DATE ────────────────────
  // Any tier above 'unknown', not just probable/confirmed. The emit schema
  // already says to use 'unknown' when no rule resolves a date, and the
  // distinction matters downstream: the poller sets needs_date_review on
  // 'unknown' alone, so a date dropped here at 'possible' would leave the
  // thread carrying no date and no flag.
  if (injuryDate === null && confidence !== 'unknown') {
    violations.push('confidence_without_date');
    confidence = 'unknown';
  }

  return {
    injury_date: injuryDate,
    injury_date_confidence: confidence,
    surgery_date: surgeryDate,
    surgery_confirmed: surgeryConfirmed,
    violations,
  };
}
