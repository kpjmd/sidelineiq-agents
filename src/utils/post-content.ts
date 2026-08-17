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
 */

const CONTENT_TYPES: readonly ContentType[] = [
  'BREAKING',
  'TRACKING',
  'DEEP_DIVE',
  'CONFLICT_FLAG',
];

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
  confidence?: unknown;
  conflict_reason?: unknown;
  team_timeline_weeks?: unknown;
  parent_post_id?: unknown;
  // Flat RTP columns (web_approve_injury_post / web_list_posts)
  return_to_play_min_weeks?: unknown;
  return_to_play_max_weeks?: unknown;
  return_to_play_probability_week_2?: unknown;
  return_to_play_probability_week_4?: unknown;
  return_to_play_probability_week_8?: unknown;
  return_to_play_confidence?: unknown;
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

export type ReconstructFailure = 'missing_rtp' | 'unknown_content_type';

export interface ReconstructResult {
  content: InjuryPostContent | null;
  /** Why it failed, so callers can report the two cases differently. */
  reason?: ReconstructFailure;
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
        probability_week_2: Number(
          rtpNested?.probability_week_2 ?? row.return_to_play_probability_week_2 ?? 0,
        ),
        probability_week_4: Number(
          rtpNested?.probability_week_4 ?? row.return_to_play_probability_week_4 ?? 0,
        ),
        probability_week_8: Number(
          rtpNested?.probability_week_8 ?? row.return_to_play_probability_week_8 ?? 0,
        ),
        confidence: Number(
          rtpNested?.confidence ?? row.return_to_play_confidence ?? row.confidence ?? 0,
        ),
      },
      confidence: Number(row.confidence ?? 0),
      ...(row.conflict_reason ? { conflict_reason: String(row.conflict_reason) } : {}),
      ...(row.team_timeline_weeks !== undefined
        ? { team_timeline_weeks: Number(row.team_timeline_weeks) }
        : {}),
      ...(row.parent_post_id ? { parent_post_id: String(row.parent_post_id) } : {}),
    },
  };
}
