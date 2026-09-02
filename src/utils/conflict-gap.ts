/**
 * The one place a team-reported timeline is compared to the OTM window.
 *
 * The two numbers are on DIFFERENT CLOCKS and used not to be:
 *   - `min_weeks`/`max_weeks` are TOTAL weeks from `injury_date` (see the tool
 *     schema in agent.ts and the CLAUDE.md section "RTP weeks are TOTAL from
 *     injury_date"). They do not shrink as the athlete rehabs.
 *   - `team_timeline_weeks` is what the team said is LEFT, counted from the
 *     report date.
 * Subtracting one from the other yields an error EXACTLY equal to the elapsed
 * time since injury — zero on breaking news, which is why six separate sites
 * looked correct on the day each was written, and 50 weeks on a carryover.
 * Nick Bosa, 50 weeks post-ACL with the team saying one more week, displayed a
 * "+38 week gap" for a return that is comfortably inside the window.
 *
 * So the comparison is made in ONE currency: the team-implied TOTAL,
 * `elapsed + remaining`, against `[min_weeks, max_weeks]`. A conflict is a
 * team-implied total that falls outside that window by more than two weeks,
 * which is SKILL.md Rule 5 read literally ("faster or slower than literature
 * minimum") — not the window MIDPOINT the old detector used, which flagged
 * athletes sitting comfortably inside the literature range but off-centre.
 *
 * No anchor, no verdict. Without `injury_date` the elapsed term is unknowable,
 * so the status is `no_anchor` and callers must print that rather than a number
 * computed from a guess.
 *
 * This module is arithmetic only — no policy, no I/O, no imports. A byte
 * identical copy lives at `lib/conflict-gap.ts` in sidelineiq-frontend, and
 * both are pinned by `tests/fixtures/conflict-gap-cases.json`. If you change
 * the arithmetic, bump CONFLICT_GAP_HELPER_VERSION, re-record the fixture and
 * copy this file across. Do not add a seventh formula anywhere.
 */

/** SKILL.md Rule 5: flag only when the gap exceeds two weeks. */
export const CONFLICT_GAP_THRESHOLD_WEEKS = 2;

/**
 * Bumped whenever the arithmetic changes. Asserted against the `helper_version`
 * recorded in the shared fixture, in BOTH repos, so a one-sided edit fails a
 * test instead of silently drifting.
 */
export const CONFLICT_GAP_HELPER_VERSION = 1;

const MS_PER_WEEK = 7 * 86_400_000;

export type ConflictGapStatus =
  /** No team disclosure to compare against. */
  | 'no_timeline'
  /** No usable injury_date, so elapsed time — and therefore the gap — is unknowable. */
  | 'no_anchor'
  /** Team-implied total falls within [min_weeks, max_weeks]. */
  | 'inside'
  /** Team-implied total is below min_weeks. */
  | 'shorter'
  /** Team-implied total is above max_weeks. */
  | 'longer';

export interface ConflictGapInput {
  /** Weeks the team says REMAIN, counted from the report date. */
  team_timeline_weeks: number | null | undefined;
  /** TOTAL weeks from injury_date — the literature floor. */
  min_weeks: number | null | undefined;
  /** TOTAL weeks from injury_date — the literature ceiling. */
  max_weeks: number | null | undefined;
  /** 'YYYY-MM-DD' or a full ISO timestamp; only the date half is read. */
  injury_date: string | null | undefined;
  /**
   * When the team timeline was reported. The agent passes generation time; the
   * frontend passes the post's `created_at`. Never "now" for a stored row —
   * the number was remaining-as-of-then, not remaining-as-of-today.
   */
  as_of: string | Date;
}

export interface ConflictGap {
  status: ConflictGapStatus;
  /** Whole weeks between injury_date and as_of. Null unless anchored. */
  elapsed_weeks: number | null;
  /** elapsed + team remaining. Null unless anchored with a disclosure. */
  team_total_weeks: number | null;
  /**
   * Signed distance OUTSIDE the window: negative below min_weeks, positive
   * above max_weeks, 0 when inside or when there is no verdict to give.
   */
  gap_weeks: number;
}

function toEpochMs(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || value.trim() === '') return NaN;
  // Date-only strings are anchored at UTC midnight so a machine's local zone
  // cannot move an elapsed count across a week boundary.
  const dateOnly = value.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    return new Date(`${dateOnly}T00:00:00Z`).getTime();
  }
  return new Date(value).getTime();
}

/**
 * Whole weeks elapsed between an injury date and a reference moment, or null
 * when either is unreadable or the reference precedes the injury.
 *
 * `formatRtpWindow` derives its printed "N weeks elapsed" from this same
 * function, so the elapsed time a reader sees and the elapsed time inside the
 * gap can never disagree.
 */
export function elapsedWeeksSince(
  injuryDate: string | null | undefined,
  asOf: string | Date,
): number | null {
  const start = toEpochMs(injuryDate);
  const end = toEpochMs(asOf);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  // A reference before the injury is a data error, not "zero elapsed". Fail
  // closed: the caller gets no_anchor and prints no number.
  if (end < start) return null;
  return Math.floor((end - start) / MS_PER_WEEK);
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function computeConflictGap(input: ConflictGapInput): ConflictGap {
  const team = finite(input.team_timeline_weeks);
  if (team === null) {
    return { status: 'no_timeline', elapsed_weeks: null, team_total_weeks: null, gap_weeks: 0 };
  }

  const min = finite(input.min_weeks);
  const max = finite(input.max_weeks);
  const elapsed = elapsedWeeksSince(input.injury_date, input.as_of);
  if (min === null || max === null || elapsed === null) {
    return {
      status: 'no_anchor',
      elapsed_weeks: elapsed,
      team_total_weeks: null,
      gap_weeks: 0,
    };
  }

  const total = elapsed + team;
  if (total < min) {
    return { status: 'shorter', elapsed_weeks: elapsed, team_total_weeks: total, gap_weeks: total - min };
  }
  if (total > max) {
    return { status: 'longer', elapsed_weeks: elapsed, team_total_weeks: total, gap_weeks: total - max };
  }
  return { status: 'inside', elapsed_weeks: elapsed, team_total_weeks: total, gap_weeks: 0 };
}

/** True when the team-implied total sits outside the window by MORE than the threshold. */
export function isConflict(
  gap: ConflictGap,
  threshold: number = CONFLICT_GAP_THRESHOLD_WEEKS,
): boolean {
  if (gap.status !== 'shorter' && gap.status !== 'longer') return false;
  return Math.abs(gap.gap_weeks) > threshold;
}
