import { callTool, isServerAvailable } from './mcp-client-manager.js';
import { formatForFarcaster, formatForTwitter, formatForWeb } from './content-formatter.js';
import type { InjuryPostContent, PlatformResult, PublishResult } from '../types.js';

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function getMDReviewThreshold(): number {
  const val = parseFloat(process.env.MD_REVIEW_CONFIDENCE_THRESHOLD || '0.75');
  return isNaN(val) ? 0.75 : val;
}

function needsMDReview(content: InjuryPostContent): { needed: boolean; reason?: string } {
  if (content.content_type === 'DEEP_DIVE') {
    return { needed: true, reason: 'DEEP_DIVE content always requires MD review' };
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

  // IndexNow ping — post was PENDING_REVIEW before, so this is the first ping
  const slug = postUrl ? postUrl.split('/post/').pop() ?? '' : '';
  if (slug) {
    void pingIndexNow(slug);
  }

  const successCount = platformResults.filter((r) => r.success).length;
  console.log(`[Pipeline] Approved DEEP_DIVE social publish for ${context}: ${successCount}/${platformResults.length} platforms`);

  return { status: 'published', platform_results: platformResults };
}

export async function publishInjuryPost(content: InjuryPostContent): Promise<PublishResult> {
  const timestamp = new Date().toISOString();
  const context = `${content.athlete_name} (${content.sport}/${content.team})`;

  // Step 1: Deduplication check
  try {
    if (isServerAvailable('web')) {
      const result = await callTool('web', 'web_list_posts', {
        athlete_name: content.athlete_name,
        sport: content.sport,
      });

      const posts = Array.isArray(result) ? result : [];
      if (isDuplicate(content, posts as ExistingPost[])) {
        console.log(`[Pipeline] Duplicate detected for ${context}, skipping`);
        return { status: 'skipped', reason: 'duplicate', platform_results: [] };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Pipeline] Dedup check failed for ${context}, proceeding: ${message}`);
  }

  // Step 2: MD review check
  const review = needsMDReview(content);
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
