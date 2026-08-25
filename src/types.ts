export type MCPServerName = 'farcaster' | 'twitter' | 'web' | 'x_api';

export type ContentType = 'BREAKING' | 'TRACKING' | 'DEEP_DIVE' | 'CONFLICT_FLAG';

export type InjurySeverity = 'MINOR' | 'MODERATE' | 'SEVERE' | 'UNKNOWN';

export interface ReturnToPlayEstimate {
  min_weeks: number;
  max_weeks: number;
  probability_week_2: number;
  probability_week_4: number;
  probability_week_8: number;
  confidence: number;
}

export interface InjuryPostContent {
  athlete_name: string;
  sport: string;
  team: string;
  injury_type: string;
  injury_severity: InjurySeverity;
  content_type: ContentType;
  headline: string;
  clinical_summary: string;
  return_to_play: ReturnToPlayEstimate;
  source_url?: string;
  confidence: number;
  conflict_reason?: string;
  team_timeline_weeks?: number;
  parent_post_id?: string;
  injury_date?: string;
  // Internal review triggers raised during processing (e.g.
  // 'rtp_monotonicity_violation'). When non-empty, the publishing pipeline
  // routes the post to MD review regardless of confidence/severity. Never
  // published — used only for gating.
  md_review_flags?: string[];
}

export interface PlatformResult {
  platform: MCPServerName;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface PublishResult {
  status: 'published' | 'pending_review' | 'skipped';
  reason?: string;
  post_id?: string;
  platform_results: PlatformResult[];
  /**
   * Pending review items this publish retired, because it covered the same
   * question they were queued to ask. Absent on every path but a successful
   * publish. See findSupersededPending in publishing-pipeline.ts.
   */
  superseded_post_ids?: string[];
}

export interface ServerStatusMap {
  farcaster: boolean;
  twitter: boolean;
  web: boolean;
  x_api: boolean;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// ── Monitoring / Polling types ──────────────────────────────────────

export type SportKey = 'NFL' | 'NBA' | 'PREMIER_LEAGUE' | 'UFC';

/**
 * Whether the event's URL identifies a specific STORY or a shared FEED.
 *
 * The distinction is load-bearing for dedup: a news source gives every event
 * its own article URL, so "have we already published this URL" is a precise
 * question. A structured source gives every event the same endpoint — every NFL
 * event carries `.../football/nfl/injuries` — so the same question there would
 * suppress every athlete after the first.
 *
 * Defaults to 'feed' when unset, which is the conservative reading: it disables
 * the URL-keyed guard rather than enabling it on a URL that cannot bear it.
 */
export type SourceKind = 'article' | 'feed';

export interface RawInjuryEvent {
  athlete_name: string;
  sport: SportKey;
  team: string;
  injury_description: string;
  source_url: string;
  reported_at: Date;
  team_timeline?: string;
  /**
   * Whether the SOURCE says this is a status change on an existing injury.
   *
   * Three states, and the third is not the same as the second:
   *   true      — the source has a status field and it changed.
   *   false     — the source has a status field and it did not.
   *   undefined — the source has no status field at all, so it cannot say.
   *
   * Only ESPN's structured injuries table sets it either way (see
   * inferIsUpdate in espn-base.ts). Every news source leaves it undefined,
   * which is what the poller's classifier fallback keys on: with no source
   * signal, the classifier's `is_new` judgement stands in. Collapsing
   * undefined into false is what would silence a follow-up story for the
   * 21-day entity window.
   */
  is_update?: boolean;
  source_name?: string;
  /** See SourceKind. Unset is read as 'feed'. */
  source_kind?: SourceKind;
  /**
   * ESPN's athlete id, when the source tags one. Lets the player lookup use the
   * strong key instead of the name — the only way to separate two athletes who
   * share one, and the seed for registering a fighter who has no roster.
   */
  espn_athlete_id?: string;
  /**
   * The tagged athlete's own injury status, verbatim from a structured feed
   * ("Active", "Out", "Questionable", "Day-To-Day"…). Undefined for news
   * sources, which have no status field.
   *
   * Distinct from is_update, which asks whether the REPORT is a change. This
   * asks whether the TAGGED ATHLETE is the injured one: an ESPN injuries row
   * for a healthy player exists only to carry a comment about a teammate —
   * "Allgeier could open the season as primary RB, as Adam Schefter reports
   * that Jeremiyah Love sustained a high-ankle sprain". The athlete re-anchor
   * keys on that (see athlete-reanchor.ts).
   */
  athlete_status?: string;
  /**
   * The source's own structured breakdown of the injury, when it has one.
   * ESPN's injuries feed carries {type:"Pectoral", location:"Torso",
   * detail:"Surgery", side:"Not Specified"} — fielded data that beats
   * regex-scraping the same facts back out of the prose summary. `side` uses
   * the literal "Not Specified" rather than omitting itself.
   */
  injury_details?: {
    type?: string;
    location?: string;
    detail?: string;
    side?: string;
  };
  /**
   * The source's own narrative context, published ALONGSIDE the one-line summary
   * and deliberately kept OUT of `injury_description`.
   *
   * ESPN's injuries feed carries two comments per row and `buildDescription`
   * takes only `shortComment` — 790 of 800 live rows have both. The historical
   * anchor for a carryover injury lives almost exclusively here: of the 21
   * in-window rows carrying an `injury_details` block, 13 state "last season" /
   * "December 2024" / "works his way back from ACL surgery" ONLY in longComment,
   * and ZERO state it only in shortComment.
   *
   * Read by date resolution and detectCarryoverSignals ONLY. It must never be
   * merged into `injury_description` — that string keys body-part extraction
   * (whose parts[0] keys entity matching), the classifier, the significance
   * gate, athlete re-anchoring, the dedup fingerprint, and the injury_updates
   * timeline row. Changing it changes which entity an event matches.
   */
  injury_description_long?: string;
  /**
   * The roster LIST designation the source assigns, verbatim ("PUP-P", "NFI-A",
   * "IR", "QUESTIONABLE"). ESPN: `details.fantasyStatus.abbreviation`.
   *
   * NOT the same question as `athlete_status`, and the two disagree in exactly
   * the case that matters: Mykel Williams is athlete_status "Out" with
   * roster_designation "PUP-P". `athlete_status` is game availability; this is
   * which list the player occupies. PUP-P/PUP-R/NFI-A/NFI-R are load-bearing
   * because NFL rules require the injury to PREDATE training camp — 26 of 26
   * live rows carrying one were carryovers. High precision, LOW recall: of 6
   * in-window surgical rows all 6 were carryovers and this caught 1. Recall
   * comes from `injury_description_long`.
   */
  roster_designation?: string;
}

export type AthleteTier = 1 | 2 | 3 | 4;

/**
 * Where an athlete's tier came from. Ordered by authority, which is the order
 * lookupAthleteTier consults them in:
 *
 *  - `lookup`  — data/athlete-tiers.json, hand-curated and physician-reviewed.
 *                A FLOOR over everything below it, never a ceiling.
 *  - `salary`  — ESPN contract salary against significance-config bands. NFL/NBA.
 *  - `club`    — the athlete's club is one of the configured tier-2 clubs.
 *                PREMIER_LEAGUE, which has no salary data on ESPN at all.
 *  - `card`    — the fighter's best slot on a recent or upcoming card (title
 *                fight, main event, main card). UFC, where pay is undisclosed
 *                and there is no roster to hang anything else on.
 *  - `default` — nothing knew, so tier 3. NOT a statement about the athlete.
 *
 * `club` and `card` are the derived-tier providers; like `salary` they can only
 * ever promote to 1 or 2. The distinction between them and `default` is what
 * poller.ts's concussion pre-drop keys on, so they must stay distinguishable.
 */
export type AthleteTierSource =
  | 'lookup'
  | 'salary'
  | 'club'
  | 'card'
  | 'draft'
  | 'default';

export type TriageDecision = 'PROCESS' | 'DEFER' | 'DROP';

export interface SignificanceSubscores {
  athlete_prominence: number;       // 0-100, deterministic from tier
  information_specificity: number;  // 0-100, Haiku-judged
  event_recency_novelty: number;    // 0-100, Haiku-judged
  content_type_prior: number;       // 0-100, deterministic from content_type
}

export interface SignificanceAssessment {
  raw_score: number;
  /** Season window that was in effect, or 'none'. Audit/logging only. */
  season_window: string;
  /** Points the season added to the PROCESS/DEFER thresholds. Positive = pickier. */
  season_threshold_delta: number;
  /** Equal to raw_score — the season shifts the threshold, not the score. */
  composite_score: number;
  /** Score this event had to clear to PROCESS, after the season delta. null
   *  when the content type always processes. Logged so score-vs-bar is visible. */
  process_threshold: number | null;
  /** Score needed to DEFER rather than DROP. */
  defer_threshold: number | null;
  /** True when the tier rule blocks PROCESS regardless of score, so the
   *  thresholds above are not what decided this event. */
  tier_blocked: boolean;
  triage_decision: TriageDecision;
  athlete_tier: AthleteTier;
  athlete_tier_source: AthleteTierSource;
  subscores: SignificanceSubscores;
  rationale: string;
}

// ── Promotion scoring (Phase 1: queue → Injury Desk candidate) ─────────
// A DIFFERENT objective from significance. Significance answers "should the
// machine publish this at all?"; promotion answers "does this conflict-flagged
// injury deserve a physician-attributed Injury Desk breakdown?".
export type CorroborationTier = 'T1' | 'T2' | 'T3' | 'unknown';

export interface PromotionScoreInput {
  composite: number;            // 0-100, the significance composite (or replay proxy)
  conflict_flag_present: boolean;
  // How many weeks the OTM estimate exceeds the team's stated timeline (the
  // team-downplaying divergence). Only counts when a conflict flag is present;
  // null/absent → no magnitude contribution. Capped internally.
  conflict_gap_weeks?: number | null;
  entity_staleness_days: number; // days since the entity was last updated; 0 = fresh
  corroboration_tier: CorroborationTier;
}

export interface PromotionScore {
  score: number;          // 0-100
  proposed: boolean;      // score >= PROMOTION_PROPOSE_THRESHOLD
  reasons: string[];      // per-term contribution breakdown, stored on the candidate
}

export interface ClassificationResult {
  is_injury_event: boolean;
  confidence: number;
  sport: SportKey;
  athlete_name: string;
  team: string;
  injury_description: string;
  content_type: ContentType;
  is_new: boolean;
  raw_event: RawInjuryEvent;
  // Present iff is_injury_event === true
  significance?: SignificanceAssessment;
  // Set when the classifier call itself failed. The result still carries
  // is_injury_event:false so callers stay safe, but this distinguishes "Claude
  // says this isn't an injury" from "we never got an answer" — without it an
  // expired API key looks exactly like a quiet news day.
  classification_error?: string;
}

// ── Social Engagement types ───────────────────────────────────────────

export type SocialPlatform = 'twitter' | 'farcaster';

export type MentionIntent =
  | 'CORRECTION'
  | 'CLINICAL_QUESTION'
  | 'ENGAGEMENT'
  | 'PUSHBACK'
  | 'SOURCING'
  | 'IGNORE';

export interface SocialMention {
  platform: SocialPlatform;
  mentionId: string;
  text: string;
  authorHandle: string;
  authorFollowerCount?: number;
  conversationId: string;
  parentPostId?: string;
  createdAt: string;
  rawPayload: Record<string, unknown>;
}
