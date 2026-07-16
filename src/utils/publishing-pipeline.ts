import { callTool, isServerAvailable } from './mcp-client-manager.js';
import { formatForFarcaster, formatForTwitter, formatForWeb, buildLaunchAnnouncement } from './content-formatter.js';
import { parseListPostsResponse } from '../monitoring/deduplicator.js';
import type { InjuryPostContent, PlatformResult, PublishResult } from '../types.js';

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MD_REVIEW_THRESHOLD = 0.75;

// Follow-up cadence cooldowns — how long to wait between TRACKING/CONFLICT_FLAG
// posts for the same entity when nothing materially new has been reported.
// CONFLICT_FLAG is longer since, by definition, the underlying disagreement
// (team timeline vs. OTM estimate) typically doesn't resolve for weeks.
const DEFAULT_CONFLICT_FLAG_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_TRACKING_COOLDOWN_MS = 5 * 24 * 60 * 60 * 1000;

function getCooldownMs(envVar: string, defaultMs: number): number {
  const raw = process.env[envVar];
  if (!raw) return defaultMs;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

// A confidence threshold is only meaningful in (0, 1]. parseFloat silently
// mangles common misconfigurations — "0,75" (comma decimal) → 0 (gate disabled),
// "75" (percent) → 75 (everything flagged), negatives (gate disabled) — so we
// reject anything out of range and fall back to the default with a warning
// rather than letting a typo quietly turn the MD gate off.
function getMDReviewThreshold(): number {
  const rawEnv = process.env.MD_REVIEW_CONFIDENCE_THRESHOLD;
  if (rawEnv === undefined || rawEnv === '') return DEFAULT_MD_REVIEW_THRESHOLD;
  const val = parseFloat(rawEnv);
  if (!Number.isFinite(val) || val <= 0 || val > 1) {
    console.warn(
      `[Pipeline] MD_REVIEW_CONFIDENCE_THRESHOLD="${rawEnv}" is not a valid probability in (0, 1] — falling back to ${DEFAULT_MD_REVIEW_THRESHOLD}`
    );
    return DEFAULT_MD_REVIEW_THRESHOLD;
  }
  return val;
}

function needsMDReview(content: InjuryPostContent): { needed: boolean; reason?: string } {
  if (content.content_type === 'DEEP_DIVE') {
    return { needed: true, reason: 'DEEP_DIVE content always requires MD review' };
  }
  // Internal review triggers raised upstream (e.g. RTP monotonicity violation).
  if (content.md_review_flags && content.md_review_flags.length > 0) {
    return { needed: true, reason: `internal review flags: ${content.md_review_flags.join(',')}` };
  }
  // Fail closed: a non-finite confidence must not slip past the `<` comparison
  // (NaN < threshold is false), so treat it as needing review outright.
  if (!Number.isFinite(content.confidence)) {
    return { needed: true, reason: `confidence is not a finite number (${content.confidence})` };
  }
  const threshold = getMDReviewThreshold();
  if (content.confidence < threshold) {
    return { needed: true, reason: `confidence ${content.confidence} below threshold ${threshold}` };
  }
  if (content.injury_severity === 'SEVERE') {
    return { needed: true, reason: 'severity is SEVERE' };
  }
  return { needed: false };
}

interface ExistingPost {
  athlete_name?: string;
  sport?: string;
  created_at?: string;
  headline?: string;
  content_type?: string;
  team_timeline_weeks?: number;
}

function isDuplicate(content: InjuryPostContent, existingPosts: ExistingPost[]): boolean {
  const now = Date.now();
  return existingPosts.some((post) => {
    if (post.athlete_name !== content.athlete_name || post.sport !== content.sport) {
      return false;
    }
    if (!post.created_at) return false;
    const postTime = new Date(post.created_at).getTime();
    return now - postTime < DEDUP_WINDOW_MS;
  });
}

// Throttles TRACKING/CONFLICT_FLAG follow-ups for the same entity when nothing
// materially new has been reported since the last one — e.g. ESPN refreshing a
// "day-to-day"/"questionable" status row with no new team-disclosed timeline.
// A genuine new disclosure (team_timeline_weeks changes) always bypasses the
// cooldown; only the original/first post for a thread (no parent_post_id) is
// exempt entirely, since that's never a "follow-up."
function checkFollowUpCadence(
  content: InjuryPostContent,
  existingPosts: ExistingPost[],
): { throttled: boolean; reason?: string } {
  if (content.content_type !== 'TRACKING' && content.content_type !== 'CONFLICT_FLAG') {
    return { throttled: false };
  }
  if (!content.parent_post_id) {
    return { throttled: false };
  }

  const lastFollowUp = existingPosts
    .filter((p) => p.athlete_name === content.athlete_name && p.sport === content.sport)
    .filter((p) => p.content_type === 'TRACKING' || p.content_type === 'CONFLICT_FLAG')
    .filter((p): p is ExistingPost & { created_at: string } => !!p.created_at)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  if (!lastFollowUp) return { throttled: false };

  // Material-change override: any change in the team-disclosed timeline
  // (including a first-time disclosure) always publishes regardless of cooldown.
  const currentWeeks = content.team_timeline_weeks ?? null;
  const lastWeeks = lastFollowUp.team_timeline_weeks ?? null;
  if (currentWeeks !== lastWeeks) {
    return { throttled: false };
  }

  const cooldownMs =
    content.content_type === 'CONFLICT_FLAG'
      ? getCooldownMs('CONFLICT_FLAG_COOLDOWN_MS', DEFAULT_CONFLICT_FLAG_COOLDOWN_MS)
      : getCooldownMs('TRACKING_COOLDOWN_MS', DEFAULT_TRACKING_COOLDOWN_MS);

  const age = Date.now() - new Date(lastFollowUp.created_at).getTime();
  if (age < cooldownMs) {
    const ageDays = Math.round(age / 86_400_000);
    const cooldownDays = Math.round(cooldownMs / 86_400_000);
    return {
      throttled: true,
      reason: `follow_up_cooldown: last ${content.content_type} post ${ageDays}d ago (cooldown ${cooldownDays}d), no material change`,
    };
  }
  return { throttled: false };
}

async function publishToFarcaster(content: InjuryPostContent): Promise<PlatformResult> {
  if (!isServerAvailable('farcaster')) {
    return { platform: 'farcaster', success: false, error: 'Farcaster MCP server unavailable' };
  }

  try {
    const casts = formatForFarcaster(content);
    let data: unknown;
    if (casts.length === 1) {
      data = await callTool('farcaster', 'farcaster_publish_cast', { text: casts[0] });
    } else {
      data = await callTool('farcaster', 'farcaster_publish_thread', { casts });
    }
    if (isMCPError(data)) {
      throw new Error(extractMCPErrorMessage(data));
    }
    return { platform: 'farcaster', success: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Pipeline] Farcaster publish failed for ${content.athlete_name}: ${message}`);
    return { platform: 'farcaster', success: false, error: message };
  }
}

async function publishToTwitter(content: InjuryPostContent): Promise<PlatformResult> {
  if (!isServerAvailable('twitter')) {
    return { platform: 'twitter', success: false, error: 'Twitter MCP server unavailable' };
  }

  try {
    const tweets = formatForTwitter(content);
    let data: unknown;
    if (tweets.length === 1) {
      data = await callTool('twitter', 'twitter_publish_tweet', { text: tweets[0] });
    } else {
      data = await callTool('twitter', 'twitter_publish_thread', { tweets });
    }
    if (isMCPError(data)) {
      throw new Error(extractMCPErrorMessage(data));
    }
    return { platform: 'twitter', success: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Pipeline] Twitter publish failed for ${content.athlete_name}: ${message}`);
    return { platform: 'twitter', success: false, error: message };
  }
}

async function publishToWeb(
  content: InjuryPostContent,
  status: 'PUBLISHED' | 'PENDING_REVIEW'
): Promise<PlatformResult> {
  if (!isServerAvailable('web')) {
    return { platform: 'web', success: false, error: 'Web MCP server unavailable' };
  }

  try {
    const webContent = formatForWeb(content, status);
    const data = await callTool('web', 'web_create_injury_post', webContent);
    if (isMCPError(data)) {
      throw new Error(extractMCPErrorMessage(data));
    }
    return { platform: 'web', success: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Pipeline] Web publish failed for ${content.athlete_name}: ${message}`);
    return { platform: 'web', success: false, error: message };
  }
}

interface MCPResponse {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function isMCPError(data: unknown): boolean {
  return (data as MCPResponse)?.isError === true;
}

function extractTextPayload(data: unknown): Record<string, unknown> | null {
  try {
    const result = data as MCPResponse;
    const text = result?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extracts a human-readable error message from an MCP error response.
 * MCP errors wrap the detail in content[0].text — usually JSON with an
 * `error`, `message`, or `detail` field, sometimes plain text.
 */
function extractMCPErrorMessage(data: unknown): string {
  try {
    const result = data as MCPResponse;
    const text = result?.content?.[0]?.text;
    if (!text) return 'MCP server returned an error with no detail';
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const msg = parsed.error ?? parsed.message ?? parsed.detail;
      return typeof msg === 'string' ? msg : text;
    } catch {
      return text;
    }
  } catch {
    return String(data);
  }
}

function extractWebPostId(data: unknown): string | null {
  const payload = extractTextPayload(data);
  const id = payload?.post_id ?? payload?.id;
  return typeof id === 'string' ? id : null;
}

function extractWebPostSlug(data: unknown): string | null {
  const payload = extractTextPayload(data);
  const slug = payload?.slug;
  return typeof slug === 'string' ? slug : null;
}

/**
 * Fires an IndexNow ping so Bing/Yandex index the new post URL within minutes.
 * Best-effort: errors are swallowed so they never affect the publish pipeline.
 */
async function pingIndexNow(slug: string): Promise<void> {
  const key = process.env.INDEXNOW_KEY;
  const siteUrl = (process.env.SITE_URL ?? 'https://sidelineiq.vercel.app').replace(/\/$/, '');
  if (!key) {
    console.log('[Pipeline] IndexNow skipped: INDEXNOW_KEY not set');
    return;
  }
  if (!slug) return;
  const url = `${siteUrl}/post/${slug}`;
  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: new URL(siteUrl).hostname, key, urlList: [url] }),
    });
    console.log(`[Pipeline] IndexNow ping: ${url} → ${res.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Pipeline] IndexNow ping failed (non-fatal): ${message}`);
  }
}

function extractFarcasterHash(data: unknown): string | null {
  const payload = extractTextPayload(data);
  // farcaster_publish_cast returns { hash } (string)
  // farcaster_publish_thread returns { hashes } (string[]) — use first cast hash
  const hash = payload?.hash ?? (Array.isArray(payload?.hashes) ? (payload.hashes as string[])[0] : undefined);
  return typeof hash === 'string' ? hash : null;
}

function extractTwitterId(data: unknown): string | null {
  const payload = extractTextPayload(data);
  // twitter_publish_tweet returns { id } (string)
  // twitter_publish_thread returns { ids } (string[]) — use first tweet id
  const id = payload?.id ?? payload?.tweet_id ?? (Array.isArray(payload?.ids) ? (payload.ids as string[])[0] : undefined);
  return typeof id === 'string' ? id : null;
}

/**
 * Publishes an already-approved DEEP_DIVE post to Farcaster and X/Twitter.
 * Called by the /admin/approve/:post_id endpoint after the frontend has
 * already called web_approve_injury_post (which flips the DB status to PUBLISHED).
 *
 * @param content   - Reconstructed InjuryPostContent from the approved post row
 * @param postUrl   - Full web URL of the published post (included in final social cast)
 * @param webPostId - Post ID for hash write-back to the web DB
 */
export async function publishApprovedDeepDive(
  content: InjuryPostContent,
  postUrl: string,
  webPostId: string
): Promise<PublishResult> {
  const context = `${content.athlete_name} (${content.sport}/${content.team})`;
  const platformResults: PlatformResult[] = [];

  // Publish to Farcaster
  if (isServerAvailable('farcaster')) {
    try {
      const casts = formatForFarcaster(content, postUrl);
      let data: unknown;
      if (casts.length === 1) {
        data = await callTool('farcaster', 'farcaster_publish_cast', { text: casts[0] });
      } else {
        data = await callTool('farcaster', 'farcaster_publish_thread', { casts });
      }
      if (isMCPError(data)) throw new Error(extractMCPErrorMessage(data));
      platformResults.push({ platform: 'farcaster', success: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Pipeline] Approved DEEP_DIVE Farcaster publish failed for ${context}: ${message}`);
      platformResults.push({ platform: 'farcaster', success: false, error: message });
    }
  } else {
    platformResults.push({ platform: 'farcaster', success: false, error: 'Farcaster MCP server unavailable' });
  }

  // Publish to X/Twitter
  if (isServerAvailable('twitter')) {
    try {
      const tweets = formatForTwitter(content, postUrl);
      let data: unknown;
      if (tweets.length === 1) {
        data = await callTool('twitter', 'twitter_publish_tweet', { text: tweets[0] });
      } else {
        data = await callTool('twitter', 'twitter_publish_thread', { tweets });
      }
      if (isMCPError(data)) throw new Error(extractMCPErrorMessage(data));
      platformResults.push({ platform: 'twitter', success: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Pipeline] Approved DEEP_DIVE Twitter publish failed for ${context}: ${message}`);
      platformResults.push({ platform: 'twitter', success: false, error: message });
    }
  } else {
    platformResults.push({ platform: 'twitter', success: false, error: 'Twitter MCP server unavailable' });
  }

  // Write social hashes back to the web post
  const farcasterResult = platformResults.find((r) => r.platform === 'farcaster');
  const twitterResult = platformResults.find((r) => r.platform === 'twitter');
  const farcasterHash = farcasterResult?.success ? extractFarcasterHash(farcasterResult.data) : null;
  const twitterId = twitterResult?.success ? extractTwitterId(twitterResult.data) : null;

  if (webPostId && (farcasterHash || twitterId)) {
    try {
      await callTool('web', 'web_update_injury_post', {
        post_id: webPostId,
        updates: {
          ...(farcasterHash && { farcaster_hash: farcasterHash }),
          ...(twitterId && { twitter_id: twitterId }),
        },
        update_reason: 'Approved DEEP_DIVE social hash writeback',
      });
      console.log(`[Pipeline] Wrote social hashes back to approved post ${webPostId} (farcaster: ${!!farcasterHash}, twitter: ${!!twitterId})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Pipeline] Failed to write social hashes to approved post ${webPostId}: ${message}`);
    }
  }

  // Launch announcement — fires once when LAUNCH_ANNOUNCEMENT=true.
  // Single cast + tweet introducing SidelineIQ. Non-fatal if either fails.
  if (process.env.LAUNCH_ANNOUNCEMENT === 'true' && postUrl) {
    const announcementText = buildLaunchAnnouncement(postUrl);
    await Promise.all([
      isServerAvailable('farcaster')
        ? callTool('farcaster', 'farcaster_publish_cast', { text: announcementText })
            .then((data) => {
              if (isMCPError(data)) throw new Error(extractMCPErrorMessage(data));
              console.log('[Pipeline] Launch announcement cast published to Farcaster');
            })
            .catch((err: unknown) => {
              console.warn(`[Pipeline] Launch announcement Farcaster failed: ${err instanceof Error ? err.message : String(err)}`);
            })
        : Promise.resolve(),
      isServerAvailable('twitter')
        ? callTool('twitter', 'twitter_publish_tweet', { text: announcementText })
            .then((data) => {
              if (isMCPError(data)) throw new Error(extractMCPErrorMessage(data));
              console.log('[Pipeline] Launch announcement tweet published to Twitter');
            })
            .catch((err: unknown) => {
              console.warn(`[Pipeline] Launch announcement Twitter failed: ${err instanceof Error ? err.message : String(err)}`);
            })
        : Promise.resolve(),
    ]);
  }

  // IndexNow ping — post was PENDING_REVIEW before, so this is the first ping
  const slug = postUrl ? postUrl.split('/post/').pop() ?? '' : '';
  if (slug) {
    void pingIndexNow(slug);
  }

  const successCount = platformResults.filter((r) => r.success).length;
  console.log(`[Pipeline] Approved DEEP_DIVE social publish for ${context}: ${successCount}/${platformResults.length} platforms`);

  return { status: 'published', platform_results: platformResults };
}

export interface PublishOptions {
  // When set, bypasses needsMDReview() and forces the post into PENDING_REVIEW
  // with this exact reason. Used by the poller when the fact-validator
  // soft-fails — the soft-fail signal lives in the poller, not in InjuryPostContent.
  forceMDReviewReason?: string;
}

export async function publishInjuryPost(
  content: InjuryPostContent,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  const timestamp = new Date().toISOString();
  const context = `${content.athlete_name} (${content.sport}/${content.team})`;

  // Step 1: Deduplication + follow-up cadence check
  try {
    if (isServerAvailable('web')) {
      const result = await callTool('web', 'web_list_posts', {
        athlete_name: content.athlete_name,
        sport: content.sport,
      });

      // web_list_posts comes back as an MCP envelope ({content:[{text}]}), not a
      // bare array — parseListPostsResponse unwraps both shapes. A plain
      // Array.isArray check here silently yielded [] in production, disabling
      // this fallback dedup entirely.
      const posts = parseListPostsResponse(result) as ExistingPost[];
      if (isDuplicate(content, posts)) {
        console.log(`[Pipeline] Duplicate detected for ${context}, skipping`);
        return { status: 'skipped', reason: 'duplicate', platform_results: [] };
      }

      const cadence = checkFollowUpCadence(content, posts);
      if (cadence.throttled) {
        console.log(`[Pipeline] ${cadence.reason} for ${context}, skipping`);
        return { status: 'skipped', reason: cadence.reason, platform_results: [] };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Pipeline] Dedup/cadence check failed for ${context}, proceeding: ${message}`);
  }

  // Step 2: MD review check (force flag wins over confidence/severity rules)
  const review = opts.forceMDReviewReason
    ? { needed: true, reason: opts.forceMDReviewReason }
    : needsMDReview(content);
  if (review.needed) {
    console.log(`[Pipeline] Routing to MD review: ${context} — ${review.reason}`);

    const webResult = await publishToWeb(content, 'PENDING_REVIEW');
    const platformResults = [webResult];

    // Flag for MD review if web post succeeded
    if (webResult.success) {
      const webPostId = extractWebPostId(webResult.data);
      if (webPostId) {
        try {
          await callTool('web', 'web_flag_for_md_review', {
            post_id: webPostId,
            reason: review.reason,
            confidence_score: content.confidence,
            flagged_by: 'injury-intelligence-agent',
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[Pipeline] Failed to flag for MD review: ${message}`);
        }
      }
    }

    return {
      status: 'pending_review',
      reason: review.reason,
      platform_results: platformResults,
    };
  }

  // Step 3a: Create web post first to get the post ID for hash write-back
  const webResult = await publishToWeb(content, 'PUBLISHED');
  const webPostId = webResult.success ? extractWebPostId(webResult.data) : null;
  const webPostSlug = webResult.success ? extractWebPostSlug(webResult.data) : null;

  // Step 3b: Publish to social platforms in parallel
  const [farcasterResult, twitterResult] = await Promise.all([
    publishToFarcaster(content),
    publishToTwitter(content),
  ]);

  // Step 3c: Write social hashes back to web post (best-effort, non-blocking)
  if (webPostId) {
    const farcasterHash = farcasterResult.success ? extractFarcasterHash(farcasterResult.data) : null;
    const twitterId = twitterResult.success ? extractTwitterId(twitterResult.data) : null;

    if (farcasterHash || twitterId) {
      try {
        await callTool('web', 'web_update_injury_post', {
          post_id: webPostId,
          updates: {
            ...(farcasterHash && { farcaster_hash: farcasterHash }),
            ...(twitterId && { twitter_id: twitterId }),
          },
          update_reason: 'Social platform hash writeback',
        });
        console.log(`[Pipeline] Wrote social hashes back to post ${webPostId} (farcaster: ${!!farcasterHash}, twitter: ${!!twitterId})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Pipeline] Failed to write social hashes to post ${webPostId}: ${message}`);
      }
    }

  }

  // IndexNow ping — best-effort, independent of hash writeback
  if (webPostSlug) {
    void pingIndexNow(webPostSlug);
  } else {
    console.log(`[Pipeline] IndexNow skipped for ${context}: no slug in web response`);
  }

  const platformResults = [webResult, farcasterResult, twitterResult];
  const successCount = platformResults.filter((r) => r.success).length;
  console.log(
    `[Pipeline] Published ${context}: ${successCount}/${platformResults.length} platforms at ${timestamp} (confidence: ${content.confidence})`
  );

  return {
    status: 'published',
    platform_results: platformResults,
  };
}
