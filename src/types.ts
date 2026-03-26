export type MCPServerName = 'farcaster' | 'twitter' | 'web';

export type ContentType = 'BREAKING' | 'TRACKING' | 'DEEP_DIVE';

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
