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
}
