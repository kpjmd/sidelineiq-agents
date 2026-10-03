/**
 * What the accuracy number counts: RETURNS, not threads.
 *
 * docs/accuracy-preregistration.md headlines "Returns inside the published
 * window: X of Y". The scorer writes one accuracy_record per closed THREAD, and
 * the two units diverge whenever one injury is carried on more than one thread.
 * That happens: Brian Burns' left ankle sat on a "sprain" thread and a
 * "surgery" thread (the matcher's injury_type test kept them apart), both
 * closed on the same 09-27 game, and both were scored — one return counted
 * twice. Amendment 2, A2.1 settles it:
 *
 *   Closed threads for the same player with the same actual_return_date are ONE
 *   observation. Its verdict is the scoreable record of the group's
 *   earliest-opened thread (first_reported_at, then id). A group with no
 *   scoreable member is one exclusion, under its earliest thread's reason.
 *
 * Earliest-opened is the A1.1 principle one level up — the first claim made,
 * before anyone knew how the recovery would go — chosen because it needs no
 * read beyond the thread list.
 *
 * Nothing here re-scores anything. The verdict, error and window come from the
 * record mcp `computeAccuracyRecord` froze at close; this only decides which
 * records are the same observation. There is no second formula.
 *
 * Population: RESOLVED and RETIRED threads in NFL and NBA, the
 * pre-registration's scope. VOID is excluded by the pre-registration (never a
 * real injury record) and ACTIVE has not closed. A row from another sport is
 * counted as out of scope, not silently dropped; a row with no sport is kept.
 * A record without a `scoreable` key predates 2026-09-15; the pre-registration
 * says to derive it from `within_range`, never to read `undefined` as `false`.
 * Those are counted and flagged `legacy` so a reader can see them.
 *
 * Arithmetic only — no policy beyond A2.1, no I/O, no imports. A byte-identical
 * copy lives at `lib/accuracy-observations.ts` in sidelineiq-frontend, and both
 * are pinned by `tests/fixtures/accuracy-observation-cases.json`. Change one,
 * bump ACCURACY_OBSERVATIONS_VERSION, re-record the fixture, copy both across.
 */

/**
 * Bumped whenever the grouping or the summary changes. Asserted against the
 * fixture's `helper_version` in BOTH repos, so a one-sided edit fails a test.
 */
export const ACCURACY_OBSERVATIONS_VERSION = 1;

/** The subset of an accuracy_record this reads. */
export interface ObservationRecord {
  scoreable?: boolean;
  within_range?: boolean | null;
  error_days?: number | null;
  unscoreable_reason?: string | null;
  otm_min_weeks?: number | null;
  otm_max_weeks?: number | null;
  censored?: boolean | null;
}

/** The subset of a web_list_threads row this reads. */
export interface ObservationThread {
  id: string;
  player_id: string;
  status: string;
  sport?: string | null;
  athlete_name?: string | null;
  first_reported_at?: string | null;
  actual_return_date?: string | null;
  accuracy_record?: ObservationRecord | null;
}

export interface Observation {
  /** The thread whose record is the verdict. */
  thread_id: string;
  athlete_name: string | null;
  /** Every thread in the group, representative first. */
  member_ids: string[];
  actual_return_date: string | null;
  within_range: boolean;
  error_days: number | null;
  window_weeks: number | null;
  censored: boolean | null;
  /** The record predates `scoreable` (2026-09-15); its verdict was derived. */
  legacy: boolean;
}

export interface Exclusion {
  thread_id: string;
  athlete_name: string | null;
  member_ids: string[];
  reason: string;
}

export interface NumberSummary {
  n: number;
  min: number | null;
  median: number | null;
  max: number | null;
}

export interface AccuracySummary {
  /** Closed (RESOLVED/RETIRED) NFL/NBA threads read. */
  closed_threads: number;
  /** Closed threads from a sport the pre-registration does not cover. */
  out_of_scope: number;
  observations: Observation[];
  exclusions: Exclusion[];
  /** Headline: returns inside the published window. */
  within: number;
  /** Headline denominator: scored returns. */
  n: number;
  /** Secondary, with its own n: median signed error in days. */
  signed_error_days: NumberSummary;
  /** Published beside the headline: window width, max_weeks − min_weeks. */
  window_weeks: NumberSummary;
  /** Exclusions by reason, counted per RETURN, not per thread. */
  excluded_by_reason: Record<string, number>;
  /** Groups that held more than one thread. */
  collapsed: Array<{ thread_ids: string[]; athlete_name: string | null; actual_return_date: string | null }>;
  /** Scored observations whose record predates `scoreable`. */
  legacy: number;
}

const CLOSED = new Set(['RESOLVED', 'RETIRED']);
const SCOPE = new Set(['NFL', 'NBA']);

/** A record that answers within_range and does not disown the answer. */
export function isScoredRecord(rec: ObservationRecord | null | undefined): boolean {
  if (!rec || rec.scoreable === false) return false;
  return rec.within_range === true || rec.within_range === false;
}

function isoDay(v: string | null | undefined): string | null {
  return v ? String(v).slice(0, 10) : null;
}

function exclusionReason(t: ObservationThread): string {
  const rec = t.accuracy_record;
  if (rec?.unscoreable_reason) return rec.unscoreable_reason;
  if (t.status === 'RETIRED') return 'retired';
  if (!rec) return 'no_record';
  return 'no_verdict';
}

function summarize(values: number[]): NumberSummary {
  if (values.length === 0) return { n: 0, min: null, median: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { n: s.length, min: s[0], median, max: s[s.length - 1] };
}

function openedOrder(a: ObservationThread, b: ObservationThread): number {
  const ta = a.first_reported_at ? new Date(a.first_reported_at).getTime() : Number.POSITIVE_INFINITY;
  const tb = b.first_reported_at ? new Date(b.first_reported_at).getTime() : Number.POSITIVE_INFINITY;
  const fa = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
  const fb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function summarizeAccuracy(threads: ObservationThread[]): AccuracySummary {
  const allClosed = threads.filter((t) => CLOSED.has(t.status));
  const inScope = (t: ObservationThread) => t.sport == null || SCOPE.has(t.sport);
  const closed = allClosed.filter(inScope);

  // A thread with no return date cannot share a return with anything.
  const groups = new Map<string, ObservationThread[]>();
  for (const t of closed) {
    const ret = isoDay(t.actual_return_date);
    const key = ret ? `${t.player_id}|${ret}` : `thread|${t.id}`;
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }

  const observations: Observation[] = [];
  const exclusions: Exclusion[] = [];
  const collapsed: AccuracySummary['collapsed'] = [];

  for (const members of groups.values()) {
    members.sort(openedOrder);
    const scored = members.find((t) => isScoredRecord(t.accuracy_record));
    const rep = scored ?? members[0];
    const ids = [rep.id, ...members.filter((t) => t !== rep).map((t) => t.id)];
    if (members.length > 1) {
      collapsed.push({
        thread_ids: ids,
        athlete_name: rep.athlete_name ?? null,
        actual_return_date: isoDay(rep.actual_return_date),
      });
    }
    if (scored) {
      const rec = scored.accuracy_record!;
      const min = rec.otm_min_weeks;
      const max = rec.otm_max_weeks;
      observations.push({
        thread_id: scored.id,
        athlete_name: scored.athlete_name ?? null,
        member_ids: ids,
        actual_return_date: isoDay(scored.actual_return_date),
        within_range: rec.within_range === true,
        error_days: typeof rec.error_days === 'number' && Number.isFinite(rec.error_days) ? rec.error_days : null,
        window_weeks: typeof min === 'number' && typeof max === 'number' ? max - min : null,
        censored: rec.censored ?? null,
        legacy: rec.scoreable === undefined,
      });
    } else {
      exclusions.push({
        thread_id: rep.id,
        athlete_name: rep.athlete_name ?? null,
        member_ids: ids,
        reason: exclusionReason(rep),
      });
    }
  }

  const excluded_by_reason: Record<string, number> = {};
  for (const e of exclusions) excluded_by_reason[e.reason] = (excluded_by_reason[e.reason] ?? 0) + 1;

  return {
    closed_threads: closed.length,
    out_of_scope: allClosed.length - closed.length,
    observations,
    exclusions,
    within: observations.filter((o) => o.within_range).length,
    n: observations.length,
    signed_error_days: summarize(observations.flatMap((o) => (o.error_days === null ? [] : [o.error_days]))),
    window_weeks: summarize(observations.flatMap((o) => (o.window_weeks === null ? [] : [o.window_weeks]))),
    excluded_by_reason,
    collapsed,
    legacy: observations.filter((o) => o.legacy).length,
  };
}
