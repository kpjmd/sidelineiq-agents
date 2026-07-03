export type MCPServerName = 'farcaster' | 'twitter' | 'web';

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
}

export interface ServerStatusMap {
  farcaster: boolean;
  twitter: boolean;
  web: boolean;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// ── Monitoring / Polling types ──────────────────────────────────────

export type SportKey = 'NFL' | 'NBA' | 'PREMIER_LEAGUE' | 'UFC';

export interface RawInjuryEvent {
  athlete_name: string;
  sport: SportKey;
  team: string;
  injury_description: string;
  source_url: string;
  reported_at: Date;
  team_timeline?: string;
  is_update?: boolean;
  source_name?: string;
}

export type AthleteTier = 1 | 2 | 3 | 4;

export type TriageDecision = 'PROCESS' | 'DEFER' | 'DROP';

export interface SignificanceSubscores {
  athlete_prominence: number;       // 0-100, deterministic from tier
  information_specificity: number;  // 0-100, Haiku-judged
  event_recency_novelty: number;    // 0-100, Haiku-judged
  content_type_prior: number;       // 0-100, deterministic from content_type
}

export interface SignificanceAssessment {
  raw_score: number;
  sport_multiplier: number;
  composite_score: number;
  triage_decision: TriageDecision;
  athlete_tier: AthleteTier;
  athlete_tier_source: 'lookup' | 'default';
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
