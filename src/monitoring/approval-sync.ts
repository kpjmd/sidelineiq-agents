import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { publishApprovedDeepDive } from '../utils/publishing-pipeline.js';
import type { InjuryPostContent, InjurySeverity } from '../types.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_DELAY_MS = 2 * 60 * 1000;    // 2 minutes — let MCP clients settle
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Social-reach audit: this loop already lists every post every cycle, so the
// same result answers "did anything published recently reach an audience at
// all" for free — including the content types this loop never republishes.
const AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
// A post is PUBLISHED to web before the social calls fire, so a row seconds old
// with no hash is mid-flight, not failed. Only count posts past that window.
const AUDIT_GRACE_MS = 10 * 60 * 1000;       // 10 minutes
const LOG_THROTTLE_MS = 60 * 60 * 1000;      // 1 hour — cycles run every 5 min

let timer: NodeJS.Timeout | null = null;
let stopped = false;
let lastAuditLogAt = 0;
let lastSuppressionLogAt = 0;

// Tracks post IDs published this process lifetime to prevent double-publishing
// when social-hash writeback hasn't landed yet on a subsequent poll cycle.
const processedIds = new Set<string>();

export interface ApprovedPost {
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

/**
 * Posts created before this cutoff are never auto-republished by this loop.
 *
 * The loop's `processedIds` guard is in-memory and resets on every deploy, so
 * without a cutoff a backlog of hashless posts is re-cast wholesale the moment
 * a broken publish path starts working again — the deploy makes the backfill
 * decision for you. Read at cycle time so the cutoff can be set or cleared from
 * Railway without a deploy. Unset (the default) keeps the original behaviour.
 */
function getNotBeforeMs(): number | null {
  const raw = process.env.APPROVAL_SYNC_NOT_BEFORE;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    console.warn(
      `[ApprovalSync] APPROVAL_SYNC_NOT_BEFORE is not a valid date: "${raw}" — ignoring, all posts in the lookback window are eligible`
    );
    return null;
  }
  return parsed;
}

/**
 * Reports PUBLISHED posts that never reached a social platform.
 *
 * Deliberately broader than the republish filter above: every content type, not
 * just DEEP_DIVE, because the failure this catches is "the audience-facing half
 * of the pipeline is dead" and that is not content-type specific. Reporting
 * only — it never publishes anything.
 */
function auditSocialReach(posts: ApprovedPost[], now: number): void {
  const unreached = posts.filter((p) => {
    if ((p.status ?? '').toUpperCase() !== 'PUBLISHED') return false;
    if (p.farcaster_hash || p.twitter_id) return false;
    if (!p.created_at) return false;
    const age = now - new Date(p.created_at).getTime();
    return age > AUDIT_GRACE_MS && age < AUDIT_WINDOW_MS;
  });

  if (unreached.length === 0) return;
  if (now - lastAuditLogAt < LOG_THROTTLE_MS) return;
  lastAuditLogAt = now;

  const sample = unreached
    .slice(0, 5)
    .map((p) => `${p.athlete_name ?? 'unknown'} (${p.content_type ?? '?'}, ${String(p.post_id ?? p.id ?? '?')})`)
    .join('; ');
  console.error(
    `[Audit] ${unreached.length} PUBLISHED post(s) in the last 24h reached no social platform — ${sample}`
  );
}

export interface RepublishSelection {
  pending: ApprovedPost[];
  suppressed: number;
}

/**
 * Decides which posts this loop may re-cast. Pure and exported because it is
 * the highest-consequence logic in the file: get it wrong and a backlog of
 * stale injury news goes out to the real accounts all at once.
 */
export function selectPostsToRepublish(
  posts: ApprovedPost[],
  now: number,
  notBeforeMs: number | null,
  alreadyProcessed: ReadonlySet<string> = new Set()
): RepublishSelection {
  let suppressed = 0;

  const pending = posts.filter((p) => {
    const postId = String(p.post_id ?? p.id ?? '');
    if (!postId || alreadyProcessed.has(postId)) return false;

    const status = (p.status ?? '').toUpperCase();
    if (status !== 'PUBLISHED') return false;
    if ((p.content_type ?? '').toUpperCase() !== 'DEEP_DIVE') return false;
    if (p.farcaster_hash || p.twitter_id) return false;
    if (!p.created_at) return false;

    const createdAt = new Date(p.created_at).getTime();
    if (now - createdAt >= LOOKBACK_MS) return false;

    if (notBeforeMs !== null && createdAt < notBeforeMs) {
      suppressed++;
      return false;
    }

    return true;
  });

  return { pending, suppressed };
}

export interface SocialReachReport {
  window_hours: number;
  published: number;
  missing_social: number;
  oldest_missing: string | null;
  sample: Array<{
    post_id: string;
    athlete_name: string;
    content_type: string;
    created_at: string;
  }>;
}

/**
 * On-demand version of the audit above, for GET /admin/social-health.
 *
 * Unlike the loop, this THROWS when the web server can't answer. A health check
 * that reports "0 missing" because the query failed is the same class of bug it
 * exists to catch.
 */
export async function getSocialReachReport(windowHours = 24): Promise<SocialReachReport> {
  if (!isServerAvailable('web')) {
    throw new Error('Web MCP server unavailable');
  }

  const raw = await callTool('web', 'web_list_posts', {});
  const wrapped = raw as { isError?: boolean; content?: Array<{ text?: string }> };
  if (wrapped?.isError === true) {
    throw new Error(`web_list_posts failed: ${wrapped.content?.[0]?.text ?? 'unknown MCP error'}`);
  }

  const posts = parseListPostsResponse(raw);
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;

  const inWindow = posts.filter((p) => {
    if ((p.status ?? '').toUpperCase() !== 'PUBLISHED') return false;
    if (!p.created_at) return false;
    const age = now - new Date(p.created_at).getTime();
    // Same grace period as the loop, so the endpoint and the log line agree.
    return age > AUDIT_GRACE_MS && age < windowMs;
  });

  const missing = inWindow
    .filter((p) => !p.farcaster_hash && !p.twitter_id)
    .sort((a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime());

  return {
    window_hours: windowHours,
    published: inWindow.length,
    missing_social: missing.length,
    oldest_missing: missing[0]?.created_at ?? null,
    sample: missing.slice(0, 20).map((p) => ({
      post_id: String(p.post_id ?? p.id ?? ''),
      athlete_name: String(p.athlete_name ?? ''),
      content_type: String(p.content_type ?? ''),
      created_at: String(p.created_at ?? ''),
    })),
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

  auditSocialReach(posts, now);

  const { pending, suppressed } = selectPostsToRepublish(
    posts,
    now,
    getNotBeforeMs(),
    processedIds
  );

  if (suppressed > 0 && now - lastSuppressionLogAt >= LOG_THROTTLE_MS) {
    lastSuppressionLogAt = now;
    console.log(
      `[ApprovalSync] ${suppressed} post(s) below the APPROVAL_SYNC_NOT_BEFORE cutoff (${process.env.APPROVAL_SYNC_NOT_BEFORE}) — not auto-republishing`
    );
  }

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
