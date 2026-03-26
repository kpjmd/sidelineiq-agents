import { callTool, isServerAvailable } from './mcp-client-manager.js';
import { formatForFarcaster, formatForTwitter, formatForWeb } from './content-formatter.js';
import type { InjuryPostContent, PlatformResult, PublishResult } from '../types.js';

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function getMDReviewThreshold(): number {
  const val = parseFloat(process.env.MD_REVIEW_CONFIDENCE_THRESHOLD || '0.75');
  return isNaN(val) ? 0.75 : val;
}

function needsMDReview(content: InjuryPostContent): { needed: boolean; reason?: string } {
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
    return { platform: 'web', success: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Pipeline] Web publish failed for ${content.athlete_name}: ${message}`);
    return { platform: 'web', success: false, error: message };
  }
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
      try {
        await callTool('web', 'web_flag_for_md_review', {
          athlete_name: content.athlete_name,
          sport: content.sport,
          reason: review.reason,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Pipeline] Failed to flag for MD review: ${message}`);
      }
    }

    return {
      status: 'pending_review',
      reason: review.reason,
      platform_results: platformResults,
    };
  }

  // Step 3: Publish to all platforms in parallel
  const results = await Promise.allSettled([
    publishToFarcaster(content),
    publishToTwitter(content),
    publishToWeb(content, 'PUBLISHED'),
  ]);

  const platformResults: PlatformResult[] = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { platform: 'web' as const, success: false, error: String(r.reason) }
  );

  const successCount = platformResults.filter((r) => r.success).length;
  console.log(
    `[Pipeline] Published ${context}: ${successCount}/${platformResults.length} platforms at ${timestamp} (confidence: ${content.confidence})`
  );

  return {
    status: 'published',
    platform_results: platformResults,
  };
}
