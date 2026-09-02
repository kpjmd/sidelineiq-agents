import type { ContentType, InjuryPostContent, InjurySeverity } from '../types.js';

/**
 * Rebuilds an InjuryPostContent from a stored injury_posts row.
 *
 * Two near-identical copies of this used to exist — one in the /admin/approve
 * endpoint, one in ApprovalSync — and they had already diverged three ways.
 * The consequential one: the ApprovalSync copy hardcoded
 * `content_type: 'DEEP_DIVE'`, discarding the column. That was masked only by
 * the DEEP_DIVE-only republish filter above it, so it would have become a live
 * bug the moment that filter widened.
 *
 * It matters because content_type is not a label — it picks the formatter, and
 * the OrthoIQ referral CTA is emitted only by the DEEP_DIVE builders. Calling a
 * BREAKING post a DEEP_DIVE reformats it as a thread and appends a referral
 * link to breaking injury news, which CLAUDE.md forbids outright.
 *
 * The field names below are the REAL injury_posts columns (see
 * sidelineiq-mcp-servers/src/shared/migrations/001_injury_posts.sql). Both
 * earlier copies read `return_to_play_probability_week_*`, `return_to_play_confidence`
 * and `confidence`, none of which exist — the columns are `rtp_probability_week_*`,
 * `rtp_confidence` and `md_review_confidence`. Every reconstructed DEEP_DIVE and
 * CONFLICT_FLAG therefore cast "Wk 2: 0% | Wk 4: 0% | Wk 8: 0%".
 *
 * It stayed silent for two reasons, both worth keeping in mind before renaming
 * anything here: `return_to_play_min_weeks`/`_max_weeks` ARE real columns, so the
 * missing_rtp gate below kept working normally; and `?? 0` fabricated a zero that
 * reads exactly like a legitimately stored 0.000 (a complete tendon rupture really
 * does have a 0% chance of RTP at week 2). Hence the fail-closed check on the
 * probability columns rather than another silent default.
 */

const CONTENT_TYPES: readonly ContentType[] = [
  'BREAKING',
  'TRACKING',
  'DEEP_DIVE',
  'CONFLICT_FLAG',
];

/**
 * Content types whose formatters render numeric week-by-week probabilities.
 *
 * Mirrors the three builders in content-formatter.ts that print the
 * "Wk 2: N% | Wk 4: N% | Wk 8: N%" line — buildDeepDiveThread,
 * buildConflictTwitterThread and buildLongFormDeepDive. Note that
 * buildConflictFarcasterCast does NOT print them, which is why a broken
 * CONFLICT_FLAG looks clean on Farcaster and wrong on X.
 *
 * Kept as one named set because skills/SKILL.md Rule 4 currently disagrees with
 * the code about which types may show numbers at all; if that is resolved in
 * favour of the skill, this is the single line that changes.
 */
const PRINTS_NUMERIC_PROBABILITIES: ReadonlySet<ContentType> = new Set<ContentType>([
  'DEEP_DIVE',
  'CONFLICT_FLAG',
]);

/** Row shape as returned by web_list_posts / web_approve_injury_post. */
export interface StoredPostRow {
  athlete_name?: unknown;
  sport?: unknown;
  team?: unknown;
  injury_type?: unknown;
  injury_severity?: unknown;
  content_type?: unknown;
  headline?: unknown;
  clinical_summary?: unknown;
  md_review_confidence?: unknown;
  conflict_reason?: unknown;
  team_timeline_weeks?: unknown;
  /**
   * The RTP window's anchor. Dropping it on reconstruction meant every
   * approval-republish formatted a post as "start date unconfirmed" while the
   * stored row knew the date perfectly well — and a CONFLICT_FLAG rebuilt that
   * way could print no gap at all. Postgres DATE arrives as a full ISO
   * timestamp, so it is sliced back to YYYY-MM-DD.
   */
  injury_date?: unknown;
  parent_post_id?: unknown;
  // Real injury_posts columns. Note the asymmetric naming — the week columns are
  // return_to_play_*, the probabilities are rtp_*. That is the schema, not a typo.
  return_to_play_min_weeks?: unknown;
  return_to_play_max_weeks?: unknown;
  rtp_probability_week_2?: unknown;
  rtp_probability_week_4?: unknown;
  rtp_probability_week_8?: unknown;
  rtp_confidence?: unknown;
  // Nested RTP (web_create_injury_post shape)
  return_to_play_estimate?: {
    min_weeks?: unknown;
    max_weeks?: unknown;
    probability_week_2?: unknown;
    probability_week_4?: unknown;
    probability_week_8?: unknown;
    confidence?: unknown;
  };
}

export type ReconstructFailure =
  | 'missing_rtp'
  | 'missing_rtp_probabilities'
  | 'unknown_content_type';

export interface ReconstructResult {
  content: InjuryPostContent | null;
  /** Why it failed, so callers can report the two cases differently. */
  reason?: ReconstructFailure;
}

/**
 * One wording for each failure, so the three call sites cannot drift apart.
 *
 * The distinction matters operationally: an unknown content_type is a data
 * problem, a missing RTP window means the post never had an estimate, and
 * missing probabilities means the row has a window but no week-by-week numbers
 * — which is the one that used to publish as 0% instead of not publishing.
 */
export function describeReconstructFailure(reason: ReconstructFailure | undefined): string {
  switch (reason) {
    case 'unknown_content_type':
      return 'unrecognized content_type';
    case 'missing_rtp_probabilities':
      return 'missing RTP probability columns (rtp_probability_week_2/4/8)';
    case 'missing_rtp':
    default:
      return 'missing RTP data';
  }
}

/**
 * Returns null on a row that cannot be safely republished.
 *
 * Fails closed on an unrecognized or absent content_type rather than defaulting.
 * Defaulting is the bug this function exists to remove, and the cost of guessing
 * wrong is a referral link on breaking injury news — worse than not posting.
 */
export function reconstructPostContent(row: StoredPostRow): ReconstructResult {
  const rtpNested = row.return_to_play_estimate;
  const minWeeks = rtpNested?.min_weeks ?? row.return_to_play_min_weeks;

  if (minWeeks === undefined || minWeeks === null) {
    return { content: null, reason: 'missing_rtp' };
  }

  const contentType = String(row.content_type ?? '').toUpperCase() as ContentType;
  if (!CONTENT_TYPES.includes(contentType)) {
    return { content: null, reason: 'unknown_content_type' };
  }

  // Resolved before the fail-closed check so both read the same values.
  const prob2 = rtpNested?.probability_week_2 ?? row.rtp_probability_week_2;
  const prob4 = rtpNested?.probability_week_4 ?? row.rtp_probability_week_4;
  const prob8 = rtpNested?.probability_week_8 ?? row.rtp_probability_week_8;

  // Fail closed only where the numbers actually reach a reader. Defaulting a
  // missing probability to 0 publishes a clinical claim we never made, and a
  // fabricated 0% is indistinguishable from a true one. BREAKING and TRACKING
  // stay tolerant — their formatters print the week window, never percentages —
  // so an approval republish of breaking news is unaffected.
  //
  // `== null` on purpose: a stored 0 (or the string "0.000" Postgres returns for
  // DECIMAL) is a legitimate value and must still publish.
  if (PRINTS_NUMERIC_PROBABILITIES.has(contentType)) {
    if (prob2 == null || prob4 == null || prob8 == null) {
      return { content: null, reason: 'missing_rtp_probabilities' };
    }
  }

  return {
    content: {
      athlete_name: String(row.athlete_name ?? ''),
      sport: String(row.sport ?? ''),
      team: String(row.team ?? ''),
      injury_type: String(row.injury_type ?? ''),
      injury_severity: (row.injury_severity as InjurySeverity) ?? 'UNKNOWN',
      content_type: contentType,
      headline: String(row.headline ?? ''),
      clinical_summary: String(row.clinical_summary ?? ''),
      return_to_play: {
        min_weeks: Number(minWeeks),
        max_weeks: Number(rtpNested?.max_weeks ?? row.return_to_play_max_weeks ?? 0),
        probability_week_2: Number(prob2 ?? 0),
        probability_week_4: Number(prob4 ?? 0),
        probability_week_8: Number(prob8 ?? 0),
        confidence: Number(
          rtpNested?.confidence ?? row.rtp_confidence ?? row.md_review_confidence ?? 0,
        ),
      },
      // md_review_confidence is only written when a post is flagged for MD
      // review, so it is NULL on autonomously published rows. Neither this nor
      // the RTP confidence above is printed to social — publishApprovedPost
      // formats for Farcaster/X only and never calls formatForWeb — so a 0 here
      // is inert. Read correctly anyway rather than leaving a known-wrong name.
      confidence: Number(row.md_review_confidence ?? 0),
      ...(row.conflict_reason ? { conflict_reason: String(row.conflict_reason) } : {}),
      ...(row.team_timeline_weeks !== undefined
        ? { team_timeline_weeks: Number(row.team_timeline_weeks) }
        : {}),
      ...(typeof row.injury_date === 'string' && row.injury_date
        ? { injury_date: row.injury_date.slice(0, 10) }
        : {}),
      ...(row.parent_post_id ? { parent_post_id: String(row.parent_post_id) } : {}),
    },
  };
}
