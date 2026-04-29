import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { publishApprovedDeepDive } from '../utils/publishing-pipeline.js';
import type { InjuryPostContent, InjurySeverity } from '../types.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_DELAY_MS = 2 * 60 * 1000;    // 2 minutes — let MCP clients settle
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let timer: NodeJS.Timeout | null = null;
let stopped = false;

// Tracks post IDs published this process lifetime to prevent double-publishing
// when social-hash writeback hasn't landed yet on a subsequent poll cycle.
const processedIds = new Set<string>();

interface ApprovedPost {
  post_id?: string;
  id?: string;
  status?: string;
  content_type?: string;
  farcaster_hash?: string | null;
  twitter_id?: string | null;
  created_at?: string;
  athlete_name?: string;
  sport?: string;
  team?: string;
  injury_type?: string;
  injury_severity?: string;
  headline?: string;
  clinical_summary?: string;
  confidence?: number;
  slug?: string;
  conflict_reason?: string;
  team_timeline_weeks?: number;
  parent_post_id?: string;
  // Flat RTP columns (from web_approve_injury_post / web_list_posts)
  return_to_play_min_weeks?: number;
  return_to_play_max_weeks?: number;
  return_to_play_probability_week_2?: number;
  return_to_play_probability_week_4?: number;
  return_to_play_probability_week_8?: number;
  return_to_play_confidence?: number;
  // Nested RTP (from web_create_injury_post shape)
  return_to_play_estimate?: {
    min_weeks?: number;
    max_weeks?: number;
    probability_week_2?: number;
    probability_week_4?: number;
    probability_week_8?: number;
    confidence?: number;
  };
}

function parseListPostsResponse(raw: unknown): ApprovedPost[] {
  try {
    if (Array.isArray(raw)) return raw as ApprovedPost[];
    const wrapped = raw as { content?: Array<{ text?: string }>; isError?: boolean };
    if (wrapped?.isError === true) return [];
    const text = wrapped?.content?.[0]?.text;
    if (!text) return [];
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed as ApprovedPost[];
    const withPosts = parsed as { posts?: unknown[] };
    if (Array.isArray(withPosts?.posts)) return withPosts.posts as ApprovedPost[];
    return [];
  } catch {
    return [];
  }
}

function reconstructContent(post: ApprovedPost): InjuryPostContent | null {
  const rtpNested = post.return_to_play_estimate;
  const minWeeks = rtpNested?.min_weeks ?? post.return_to_play_min_weeks;

  if (minWeeks === undefined || minWeeks === null) return null;

  return {
    athlete_name: String(post.athlete_name ?? ''),
    sport: String(post.sport ?? ''),
    team: String(post.team ?? ''),
    injury_type: String(post.injury_type ?? ''),
    injury_severity: (post.injury_severity as InjurySeverity) ?? 'UNKNOWN',
    content_type: 'DEEP_DIVE',
    headline: String(post.headline ?? ''),
    clinical_summary: String(post.clinical_summary ?? ''),
    return_to_play: {
      min_weeks: Number(minWeeks),
      max_weeks: Number(rtpNested?.max_weeks ?? post.return_to_play_max_weeks ?? 0),
      probability_week_2: Number(rtpNested?.probability_week_2 ?? post.return_to_play_probability_week_2 ?? 0),
      probability_week_4: Number(rtpNested?.probability_week_4 ?? post.return_to_play_probability_week_4 ?? 0),
      probability_week_8: Number(rtpNested?.probability_week_8 ?? post.return_to_play_probability_week_8 ?? 0),
      confidence: Number(rtpNested?.confidence ?? post.return_to_play_confidence ?? post.confidence ?? 0),
    },
    confidence: Number(post.confidence ?? 0),
    ...(post.conflict_reason ? { conflict_reason: String(post.conflict_reason) } : {}),
    ...(post.team_timeline_weeks !== undefined ? { team_timeline_weeks: Number(post.team_timeline_weeks) } : {}),
    ...(post.parent_post_id ? { parent_post_id: String(post.parent_post_id) } : {}),
  };
}

function getIntervalMs(): number {
  const raw = process.env.APPROVAL_SYNC_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

async function runApprovalSyncCycle(): Promise<void> {
  if (!isServerAvailable('web')) {
    console.warn('[ApprovalSync] Web MCP unavailable — skipping cycle');
    return;
  }

  let raw: unknown;
  try {
    raw = await callTool('web', 'web_list_posts', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ApprovalSync] web_list_posts failed: ${message}`);
    return;
  }

  const posts = parseListPostsResponse(raw);
  const now = Date.now();

  const pending = posts.filter((p) => {
    const postId = String(p.post_id ?? p.id ?? '');
    if (!postId || processedIds.has(postId)) return false;

    const status = (p.status ?? '').toUpperCase();
    if (status !== 'PUBLISHED') return false;
    if ((p.content_type ?? '').toUpperCase() !== 'DEEP_DIVE') return false;
    if (p.farcaster_hash || p.twitter_id) return false;
    if (!p.created_at) return false;

    return now - new Date(p.created_at).getTime() < LOOKBACK_MS;
  });

  if (pending.length === 0) return;

  console.log(`[ApprovalSync] Found ${pending.length} approved DEEP_DIVE post(s) not yet on socials`);

  const siteUrl = (process.env.SITE_URL ?? 'https://sidelineiq.vercel.app').replace(/\/$/, '');

  for (const post of pending) {
    const webPostId = String(post.post_id ?? post.id ?? '');
    const content = reconstructContent(post);

    if (!content) {
      console.warn(`[ApprovalSync] Skipping post ${webPostId} — missing RTP data`);
      continue;
    }

    const slug = String(post.slug ?? '');
    const postUrl = slug ? `${siteUrl}/post/${slug}` : '';

    // Mark before publishing so a slow publish doesn't cause a duplicate on the
    // next cycle if the loop fires again before hashes are written back.
    processedIds.add(webPostId);

    console.log(`[ApprovalSync] Publishing to socials: ${webPostId} (${content.athlete_name})`);
    try {
      await publishApprovedDeepDive(content, postUrl, webPostId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ApprovalSync] Failed for post ${webPostId}: ${message}`);
      // Remove from processed set so a future cycle can retry
      processedIds.delete(webPostId);
    }
  }
}

function scheduleNext(intervalMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, intervalMs);
}

async function runAndReschedule(intervalMs: number): Promise<void> {
  try {
    await runApprovalSyncCycle();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ApprovalSync] Cycle crashed: ${message}`);
  } finally {
    scheduleNext(intervalMs);
  }
}

export function startApprovalSync(): void {
  stopped = false;
  const intervalMs = getIntervalMs();
  console.log(`[ApprovalSync] Starting — interval=${intervalMs / 1000}s, startup delay=${STARTUP_DELAY_MS / 1000}s`);
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, STARTUP_DELAY_MS);
}

export function stopApprovalSync(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log('[ApprovalSync] Stopped');
}
