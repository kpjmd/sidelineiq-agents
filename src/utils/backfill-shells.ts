/**
 * What a "backfill shell" is, and why it needs its own predicate.
 *
 * On 2026-05-31T23:18:44.996Z → 23:19:34.586Z — a fifty-second window —
 * `src/scripts/backfill-entities.ts` walked `web_list_posts` chronologically and
 * minted 166 injury_entities so that already-published posts would have threads.
 * That script has no resolver import and never writes a date. Every one of those
 * rows therefore sits in the DB as an ACTIVE thread with no `injury_date`, no
 * `otm_projection`, no `date_resolution_sources`, no `accuracy_record`, zero
 * `audit_log` history, and `last_updated_at` frozen at its creation instant.
 *
 * They are INERT rather than harmful: `web_find_matching_entity` gates on
 * `last_updated_at >= NOW() - recency_days` with `recency_days` 21, so at 100+
 * days stale they cannot absorb a new report and no new report routes to them.
 * That is also the reason they were never resolved — not a failing resolution, an
 * unreachable one. Anything proposing to make the resolver back off on them is
 * answering a question the data does not ask: nothing was ever attempted.
 *
 * What they DO cost is 166 rows in the MD's ACTIVE list, and inflated denominators
 * in every corpus statistic about threads the resolver could ever see.
 *
 * The predicate below is CONJUNCTIVE and every conjunct is load-bearing, because
 * its output authorises a bulk write against rows nobody is watching. It is shared
 * by the dry run (which gates on it) and the sweep (which writes on it) so the two
 * can never drift — a divergence between "what the ship gate measured" and "what
 * the script voided" is exactly the failure this repo keeps having.
 *
 * `now` is INJECTED. A predicate that reads the clock cannot be tested at a
 * boundary, and both of its time-dependent conjuncts are boundaries.
 *
 * ONE CONJUNCT THAT LOOKED OBVIOUS AND IS NOT: `canonical_post_id != null`.
 * backfill-entities.ts always passes one, so "every shell has a canonical post"
 * reads as a safe cohort signature — and it is wrong. 27 of the 166 have NULL,
 * and their `injury_updates` rows carry NULL `post_id`s beside non-null ones,
 * which is the `ON DELETE SET NULL` signature of the pre-migration-021 Reject
 * button DELETING the post row. So a canonical-null shell is a backfill entity
 * whose post was later rejected out of existence — a thread with no link to
 * published content at all. That is the exact shape `web_thread_close
 * outcome:'VOID'` was added for (migration 020), and it is the Greenard failure
 * mode: post-less, ACTIVE, and dangerous only while inside the match window.
 * It makes retraction MORE clearly right, not less, so it is not a conjunct.
 *
 * The cohort's identity is carried by the creation window instead. That is also
 * what keeps a fresh orphan out (Kenyon Sadiq, 2026-08-10, no canonical post, no
 * updates) — a stronger discriminator, because it does not depend on a field
 * something else can null years later.
 */

/** The fields a thread must expose for a shell decision. A superset of both
 *  `web_list_threads` (post-widening) and `web_thread_get` rows. */
export interface ShellCandidate {
  id: string;
  player_id: string;
  athlete_name?: string | null;
  body_part: string | null;
  status: string;
  injury_date: string | null;
  otm_projection: unknown | null;
  date_resolution_sources: unknown[] | null;
  accuracy_record: unknown | null;
  needs_date_review: boolean;
  canonical_post_id: string | null;
  first_reported_at: string;
  last_updated_at: string;
}

export interface ShellPolicy {
  /** ms since epoch. Injected — never Date.now() inside the predicate. */
  now: number;
  /** ISO instant, INCLUSIVE lower bound on first_reported_at. */
  createdFrom: string;
  /** ISO instant, INCLUSIVE upper bound on first_reported_at. */
  createdTo: string;
  /**
   * web_find_matching_entity's `recency_days`. A thread updated more recently
   * than this can still absorb a live report, so it is not inert and must not
   * be swept. mcp `client.ts` defaults it to 21; deduplicator.ts passes 21.
   */
  matchWindowDays: number;
}

export type ShellReason =
  | 'ok'
  | 'not_active'
  | 'has_injury_date'
  | 'has_otm_projection'
  | 'has_resolution_sources'
  | 'needs_date_review'
  | 'has_accuracy_record'
  | 'outside_created_window'
  | 'recently_updated'
  | 'has_audit_history';

export interface ShellVerdict {
  shell: boolean;
  reason: ShellReason;
}

export const MATCH_WINDOW_DAYS = 21;
const DAY_MS = 86_400_000;

/** The observed backfill pass, bracketed generously around 23:18:44 → 23:19:34. */
export const BACKFILL_WINDOW = {
  from: '2026-05-31T23:00:00.000Z',
  to: '2026-06-01T00:00:00.000Z',
} as const;

export function defaultShellPolicy(now: number = Date.now()): ShellPolicy {
  return {
    now,
    createdFrom: BACKFILL_WINDOW.from,
    createdTo: BACKFILL_WINDOW.to,
    matchWindowDays: MATCH_WINDOW_DAYS,
  };
}

/** Whole days between `last_updated_at` and `now`. Negative is impossible in
 *  practice but is returned as-is rather than clamped, so a clock skew shows up. */
export function daysStale(t: Pick<ShellCandidate, 'last_updated_at'>, now: number): number {
  const ts = Date.parse(t.last_updated_at);
  if (!Number.isFinite(ts)) return Number.NaN;
  return Math.floor((now - ts) / DAY_MS);
}

/**
 * Conjunctive. Returns the FIRST failing conjunct so a manifest can print why a
 * row was left alone, which is the only way a 166-row skip list is reviewable.
 *
 * `auditEntryCount` is passed in rather than fetched because the caller already
 * has to page it, and because it MUST be read with
 * `entity_type: 'injury_thread'` — `'injury_entity'` returns `[]` with no error,
 * which reads as "clean history" for every thread in the corpus.
 */
export function classifyShell(
  t: ShellCandidate,
  policy: ShellPolicy,
  auditEntryCount: number,
): ShellVerdict {
  if (t.status !== 'ACTIVE') return { shell: false, reason: 'not_active' };

  // A date means something resolved it, or an MD entered it. Either way the
  // thread is not a shell.
  if (t.injury_date != null && String(t.injury_date).trim() !== '') {
    return { shell: false, reason: 'has_injury_date' };
  }
  // A projection is a clinical judgement that was actually made about this
  // thread, and it is what closeThread would score.
  if (t.otm_projection != null) return { shell: false, reason: 'has_otm_projection' };
  // Provenance of any kind — api, web_search, md_manual — means the resolver or
  // a human touched it.
  if (Array.isArray(t.date_resolution_sources) && t.date_resolution_sources.length > 0) {
    return { shell: false, reason: 'has_resolution_sources' };
  }
  // A flagged thread is a question already put to the MD. Retracting it answers
  // that question on their behalf.
  if (t.needs_date_review) return { shell: false, reason: 'needs_date_review' };
  if (t.accuracy_record != null) return { shell: false, reason: 'has_accuracy_record' };

  const created = Date.parse(t.first_reported_at);
  const from = Date.parse(policy.createdFrom);
  const to = Date.parse(policy.createdTo);
  if (!Number.isFinite(created) || created < from || created > to) {
    return { shell: false, reason: 'outside_created_window' };
  }

  // The inertness claim, stated as a check rather than assumed. A thread inside
  // the match window is a live absorber and bulk-voiding it removes real coverage.
  const updated = Date.parse(t.last_updated_at);
  if (!Number.isFinite(updated) || updated >= policy.now - policy.matchWindowDays * DAY_MS) {
    return { shell: false, reason: 'recently_updated' };
  }

  if (auditEntryCount > 0) return { shell: false, reason: 'has_audit_history' };

  return { shell: true, reason: 'ok' };
}

/**
 * True when a `web_list_threads` payload came from an mcp-servers build that
 * projects `date_resolution_sources`.
 *
 * The test is KEY PRESENCE, deliberately. The column is JSONB and legitimately
 * NULL on the 166 rows this module exists for, so `row.date_resolution_sources !=
 * null` reports "narrow" against a correctly-wide server — silently reinstating a
 * per-entity fan-out — and, worse, cannot tell "the resolver never ran" from
 * "this server predates the column".
 */
export function listRowsAreWide(rows: ReadonlyArray<object>): boolean {
  const first = rows.find(Boolean);
  return first !== undefined && 'date_resolution_sources' in first;
}

/**
 * Blast-radius cap. THROWS rather than truncating: a match count above what the
 * operator expected means the predicate or the window is wrong, and voiding the
 * first N of a wrong set is worse than voiding none.
 */
export function assertBlastRadius(matched: number, max: number): void {
  if (matched > max) {
    throw new Error(
      `${matched} entities match the shell predicate but --max is ${max}. ` +
        'Read the manifest and raise --max deliberately, or narrow ' +
        '--created-from/--created-to. Refusing to void a truncated set.',
    );
  }
}
