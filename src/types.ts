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
