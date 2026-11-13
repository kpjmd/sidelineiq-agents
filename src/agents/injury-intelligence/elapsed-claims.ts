import { elapsedWeeksSince } from '../../utils/conflict-gap.js';

/**
 * Elapsed time since an injury or surgery is arithmetic, so code does it.
 *
 * The prompt used to require a statement of elapsed time while supplying no
 * number, and the model got the arithmetic wrong in the way the year logic
 * elsewhere documents: it dropped the year. Kyrie Irving's surgery of 2025-03-26
 * read as "approximately 31 weeks post-op" on 2026-11-02, which is exactly the
 * distance from 2026-03-26. The true figure was 83 weeks. Noah Sewell's "35 weeks
 * post-injury" was 88.
 *
 * Two pieces, on the same principle as rebrandPersona: buildElapsedLine hands the
 * model the number, which is a request, and checkElapsedClaims compares what it
 * wrote, which is the guarantee.
 */

const WEEKS_PER_MONTH = 52.18 / 12;
const WEEKS_PER_YEAR = 52.18;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

const ANCHORED_CONFIDENCE = new Set(['probable', 'confirmed']);

export interface ElapsedThreadDates {
  injury_date: string | null;
  injury_date_confidence: string;
  surgery_date: string | null;
}

function describeElapsed(weeks: number, label: string): string {
  const months = Math.round(weeks / WEEKS_PER_MONTH);
  return `${weeks} weeks (about ${months} months) since ${label}`;
}

export interface ReturnedSince {
  games: number;
  first_game_date: string;
  last_game_date: string;
}

/**
 * The thread-block line for an athlete who has played since the anchored date
 * (returned-precheck.ts, `inform` and `review`). It says what the game log shows
 * and what that rules out, and leaves the reading of the current absence to the
 * model: Markkanen's was a new fracture, Trey Murphy III's a flare of the same
 * tendinopathy. The line it replaced told the model he was "not out recovering",
 * which is wrong for a flare.
 */
export function buildReturnedSinceLine(r: ReturnedSince): string {
  return (
    `Returned to play after this date: ${r.games} regular-season game(s), first ${r.first_game_date}, ` +
    `most recent ${r.last_game_date} (from the game log, authoritative). Any absence now is a recurrence, ` +
    `a setback or a new problem, not one continuous recovery from this date. Do not describe the athlete ` +
    `as still out or still recovering from it, and do not infer severity from the length of an ` +
    `uninterrupted absence.`
  );
}

/**
 * The computed line for the thread block, or '' when the date is not one the
 * prompt treats as authoritative. It adds no date the block does not already
 * state, so OTM's own injury_date stays an independent reading for
 * assessAnchorDivergence.
 */
export function buildElapsedLine(thread: ElapsedThreadDates, today: string): string {
  if (!ANCHORED_CONFIDENCE.has(thread.injury_date_confidence)) return '';
  const parts: string[] = [];
  const sinceInjury = elapsedWeeksSince(thread.injury_date, today);
  if (sinceInjury !== null) parts.push(describeElapsed(sinceInjury, 'injury'));
  const sinceSurgery = elapsedWeeksSince(thread.surgery_date, today);
  if (sinceSurgery !== null) parts.push(describeElapsed(sinceSurgery, 'surgery'));
  if (parts.length === 0) return '';
  return `Elapsed as of ${today} (computed, use these figures in clinical_summary, do not recalculate): ${parts.join('; ')}.`;
}

export interface ElapsedClaim {
  /** The matched prose. */
  text: string;
  /** The claim converted to weeks. */
  weeks: number;
}

export interface ElapsedMismatch extends ElapsedClaim {
  /** The computed elapsed weeks closest to the claim, floored for display. */
  computed_weeks: number;
  /** Which anchor that figure was measured from. */
  anchor: string;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, eighteen: 18, twenty: 20,
};

const NUMBER = `\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')}`;
const HEDGE = `(?:(?:approximately|approx\\.?|about|roughly|nearly|around|almost|some|just|over|under|more than|less than|only|at least|~)\\s*)*`;
const UNIT = `(weeks?|months?|years?)`;
const AMOUNT = `${HEDGE}(${NUMBER})[-\\s]${UNIT}`;

/**
 * Forward-looking windows are the trap, and they outnumber real claims: "39 weeks
 * from surgery", "3-5 months post-op", "Week 5 is ~39 weeks post-op" and "at 12
 * weeks post-op most athletes resume running" all describe when a return could
 * happen. So a post-op phrase counts only with evidence that it describes the
 * athlete today:
 *
 *  - a present-tense word before it ("now 31 weeks post-op", "he is 9 months
 *    post-surgery"),
 *  - a named subject and verb after it ("At 43 weeks post-op, Parsons sits"), or
 *  - a date frame after it ("29 weeks post-op at the time of this report").
 *
 * "since" and "removed from" can only look backward, and count on their own.
 * A range is a window by construction: AMOUNT must not follow a number and a dash
 * or "to", and "now 3-5 months post-op" fails because its marker does not touch
 * "5 months".
 */
const POST_PHRASE = `post[-\\s]?(?:op\\b|operative|operatively|surgery|surgical|surgically|injury)|out from (?:\\w+\\s+){0,2}(?:surgery|injury|procedure|operation)|into (?:\\w+\\s+){0,2}(?:recovery|rehab|rehabilitation)`;
const PRESENT_MARKER = `\\b(?:now|currently|presently|already|today)\\s+(?:(?:is|at|sits at|stands at)\\s+)?`;
const SUBJECT_MARKER = `\\b(?:he|she|he's|she's|he’s|she’s)\\s+(?:is\\s+|sits at\\s+|stands at\\s+)?`;
const NOT_A_RANGE = `(?<!\\d\\s?(?:[-–—]|to)\\s?)`;
const NAMED_SUBJECT_AFTER = `,\\s+[A-Z][\\w'’.-]+\\s+(?:sits|is|has|remains|stands)\\b`;
const DATE_FRAME_AFTER = `\\s+(?:as of|at the time of|heading into)\\b`;
const LOOKBACK = `(?:since\\s+(?:\\w+\\s+){0,2}(?:surgery|injury|procedure|operation|tear|repair|reconstruction)|removed from\\b)`;

const CLAIM_RES: RegExp[] = [
  new RegExp(`(?:${PRESENT_MARKER}|${SUBJECT_MARKER})${AMOUNT}[-\\s](?:${POST_PHRASE})`, 'gi'),
  // The named-subject form needs a real capital, so these are case-sensitive
  // apart from the unit and phrase, which the case-folded alternatives below cover.
  new RegExp(`${NOT_A_RANGE}\\b${AMOUNT}[-\\s](?:${POST_PHRASE})(?=${NAMED_SUBJECT_AFTER}|${DATE_FRAME_AFTER})`, 'g'),
  new RegExp(`${NOT_A_RANGE}\\b${AMOUNT}\\s+${LOOKBACK}`, 'gi'),
];

function toWeeks(amount: string, unit: string): number {
  const lower = amount.toLowerCase();
  const n = NUMBER_WORDS[lower] ?? Number(lower);
  if (/^month/i.test(unit)) return n * WEEKS_PER_MONTH;
  if (/^year/i.test(unit)) return n * WEEKS_PER_YEAR;
  return n;
}

/** Slack for the unit itself: "9 months" is honest anywhere inside the month. */
function unitSlackWeeks(text: string): number {
  if (/\byears?\b/i.test(text)) return WEEKS_PER_YEAR / 2;
  if (/\bmonths?\b/i.test(text)) return WEEKS_PER_MONTH / 2;
  return 0;
}

export function extractElapsedClaims(text: string): ElapsedClaim[] {
  const claims: ElapsedClaim[] = [];
  const seen = new Set<number>();
  for (const re of CLAIM_RES) {
    for (const m of text.matchAll(re)) {
      // One phrase can satisfy two forms; the end offset identifies it.
      const end = m.index + m[0].length;
      if (seen.has(end)) continue;
      seen.add(end);
      claims.push({ text: m[0].trim(), weeks: toWeeks(m[1], m[2]) });
    }
  }
  return claims;
}

function exactWeeks(anchor: string, asOf: string | Date): number | null {
  if (elapsedWeeksSince(anchor, asOf) === null) return null;
  const start = Date.parse(`${anchor.slice(0, 10)}T00:00:00Z`);
  const end = asOf instanceof Date ? asOf.getTime() : Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  return (end - start) / MS_PER_WEEK;
}

/**
 * Compare stated elapsed time with the computed figure. A claim passes when it
 * sits within max(2 weeks, 10%) of ANY anchor, so "post-op" written about the
 * injury date, or the reverse, cannot raise a false alarm: the question here is
 * whether the number is true of either date, not which word the model chose.
 * With no readable anchor there is nothing to compare, and nothing is flagged.
 */
export function checkElapsedClaims(
  text: string,
  anchors: Array<string | null | undefined>,
  asOf: string | Date,
): ElapsedMismatch[] {
  const readable = anchors
    .filter((a): a is string => typeof a === 'string' && a.length > 0)
    .map((anchor) => ({ anchor: anchor.slice(0, 10), weeks: exactWeeks(anchor, asOf) }))
    .filter((a): a is { anchor: string; weeks: number } => a.weeks !== null);
  if (readable.length === 0) return [];

  const mismatches: ElapsedMismatch[] = [];
  for (const claim of extractElapsedClaims(text)) {
    const slack = unitSlackWeeks(claim.text);
    const matches = readable.some(
      (a) => Math.abs(claim.weeks - a.weeks) <= Math.max(2, a.weeks * 0.1) + slack,
    );
    if (matches) continue;
    const closest = readable.reduce((best, a) =>
      Math.abs(claim.weeks - a.weeks) < Math.abs(claim.weeks - best.weeks) ? a : best,
    );
    mismatches.push({ ...claim, computed_weeks: Math.floor(closest.weeks), anchor: closest.anchor });
  }
  return mismatches;
}
