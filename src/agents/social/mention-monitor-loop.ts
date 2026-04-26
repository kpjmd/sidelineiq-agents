import { callTool, isServerAvailable } from '../../utils/mcp-client-manager.js';
import { processMention } from './reply-agent.js';
import type { SocialMention } from '../../types.js';

// 20-minute interval, offset 10 minutes from injury poller startup
const DEFAULT_INTERVAL_MS = 20 * 60 * 1000;
const STARTUP_DELAY_MS = 10 * 60 * 1000;
const MAX_REPLIES_PER_RUN = 10;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

function getIntervalMs(): number {
  const raw = process.env.SOCIAL_MONITOR_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

function getMinFollowers(): number {
  const raw = process.env.MIN_MENTION_FOLLOWER_COUNT;
  if (!raw) return 50;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

function getOtmTwitterUserId(): string {
  return process.env.OTM_TWITTER_USER_ID ?? '';
}

function getOtmFarcasterFid(): number {
  const raw = process.env.OTM_FARCASTER_FID;
  return raw ? parseInt(raw, 10) : 0;
}

// ── State helpers (cursor persistence via web MCP) ───────────────────

function parseSocialStateValue(raw: unknown): string | null {
  try {
    const wrapped = raw as { content?: Array<{ text?: string }>; isError?: boolean };
    if (wrapped?.isError === true) return null;
    const text = wrapped?.content?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as { value?: string | null };
    return parsed.value ?? null;
  } catch {
    return null;
  }
}

async function getSocialState(key: string): Promise<string | null> {
  if (!isServerAvailable('web')) return null;
  try {
    const raw = await callTool('web', 'web_get_social_state', { key });
    return parseSocialStateValue(raw);
  } catch {
    return null;
  }
}

async function setSocialState(key: string, value: string): Promise<void> {
  if (!isServerAvailable('web')) return;
  try {
    await callTool('web', 'web_set_social_state', { key, value });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[MentionMonitor] Failed to persist ${key}: ${message}`);
  }
}

// ── Deduplication check ───────────────────────────────────────────────

async function isMentionProcessed(platform: string, mentionId: string): Promise<boolean> {
  if (!isServerAvailable('web')) return false;
  try {
    const raw = await callTool('web', 'web_check_mention_processed', { platform, mention_id: mentionId });
    const wrapped = raw as { content?: Array<{ text?: string }>; isError?: boolean };
    if (wrapped?.isError === true) return false;
    const text = wrapped?.content?.[0]?.text;
    if (!text) return false;
    const parsed = JSON.parse(text) as { processed?: boolean };
    return parsed.processed === true;
  } catch {
    return false;
  }
}

// ── Twitter fetching ─────────────────────────────────────────────────

interface TwitterMentionRaw {
  id: string;
  text: string;
  authorId: string;
  authorUsername: string;
  authorFollowerCount?: number;
  conversationId: string;
  inReplyToUserId?: string;
  createdAt: string;
}

interface GetMentionsRawResult {
  mentions?: TwitterMentionRaw[];
  newestId?: string;
}

function parseGetMentionsResult(raw: unknown): GetMentionsRawResult {
  try {
    const wrapped = raw as { content?: Array<{ text?: string }>; isError?: boolean };
    if (wrapped?.isError === true) return { mentions: [] };
    const text = wrapped?.content?.[0]?.text;
    if (!text) return { mentions: [] };
    return JSON.parse(text) as GetMentionsRawResult;
  } catch {
    return { mentions: [] };
  }
}

async function fetchTwitterMentions(): Promise<SocialMention[]> {
  const userId = getOtmTwitterUserId();
  if (!userId) {
    console.warn('[MentionMonitor] OTM_TWITTER_USER_ID not set — skipping Twitter mentions');
    return [];
  }
  if (!isServerAvailable('twitter')) {
    console.warn('[MentionMonitor] Twitter MCP unavailable — skipping');
    return [];
  }

  try {
    const sinceId = await getSocialState('twitter_mentions_since_id');
    const raw = await callTool('twitter', 'twitter_get_mentions', {
      user_id: userId,
      ...(sinceId ? { since_id: sinceId } : {}),
      max_results: 20,
    });

    const result = parseGetMentionsResult(raw);
    const mentions: SocialMention[] = (result.mentions ?? []).map((m) => ({
      platform: 'twitter' as const,
      mentionId: m.id,
      text: m.text,
      authorHandle: m.authorUsername,
      authorFollowerCount: m.authorFollowerCount,
      conversationId: m.conversationId,
      parentPostId: m.inReplyToUserId,
      createdAt: m.createdAt,
      rawPayload: m as unknown as Record<string, unknown>,
    }));

    if (result.newestId) {
      await setSocialState('twitter_mentions_since_id', result.newestId);
      console.log(`[MentionMonitor] Twitter: fetched ${mentions.length} mentions, cursor updated to ${result.newestId}`);
    } else {
      console.log(`[MentionMonitor] Twitter: fetched ${mentions.length} mentions, no new cursor`);
    }

    return mentions;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[MentionMonitor] Twitter fetch failed: ${message}`);
    return [];
  }
}

// ── Farcaster fetching ───────────────────────────────────────────────

interface FarcasterNotificationRaw {
  hash: string;
  text: string;
  authorFid: number;
  authorUsername: string;
  authorFollowerCount?: number;
  parentHash?: string;
  timestamp: string;
  type: string;
}

interface GetNotificationsRawResult {
  notifications?: FarcasterNotificationRaw[];
  nextCursor?: string;
}

function parseGetNotificationsResult(raw: unknown): GetNotificationsRawResult {
  try {
    const wrapped = raw as { content?: Array<{ text?: string }>; isError?: boolean };
    if (wrapped?.isError === true) return { notifications: [] };
    const text = wrapped?.content?.[0]?.text;
    if (!text) return { notifications: [] };
    return JSON.parse(text) as GetNotificationsRawResult;
  } catch {
    return { notifications: [] };
  }
}

async function fetchFarcasterMentions(): Promise<SocialMention[]> {
  const fid = getOtmFarcasterFid();
  if (!fid) {
    console.warn('[MentionMonitor] OTM_FARCASTER_FID not set — skipping Farcaster mentions');
    return [];
  }
  if (!isServerAvailable('farcaster')) {
    console.warn('[MentionMonitor] Farcaster MCP unavailable — skipping');
    return [];
  }

  try {
    const cursor = await getSocialState('farcaster_notifications_cursor');
    const raw = await callTool('farcaster', 'farcaster_get_notifications', {
      fid,
      ...(cursor ? { cursor } : {}),
      limit: 25,
    });

    const result = parseGetNotificationsResult(raw);
    const notifications = result.notifications ?? [];

    const mentions: SocialMention[] = notifications
      .filter((n) => n.type === 'mention' || n.type === 'reply')
      .map((n) => ({
        platform: 'farcaster' as const,
        mentionId: n.hash,
        text: n.text,
        authorHandle: n.authorUsername,
        authorFollowerCount: n.authorFollowerCount,
        conversationId: n.hash,
        parentPostId: n.parentHash,
        createdAt: n.timestamp,
        rawPayload: n as unknown as Record<string, unknown>,
      }));

    if (result.nextCursor) {
      await setSocialState('farcaster_notifications_cursor', result.nextCursor);
    }

    console.log(`[MentionMonitor] Farcaster: fetched ${mentions.length} mentions`);
    return mentions;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[MentionMonitor] Farcaster fetch failed: ${message}`);
    return [];
  }
}

// ── Guardrails ───────────────────────────────────────────────────────

async function applyGuardrails(
  mention: SocialMention,
  otmTwitterUserId: string,
  otmFarcasterFid: number,
  minFollowers: number,
): Promise<{ pass: boolean; reason?: string }> {
  // Guardrail 1: Dedup
  const alreadyProcessed = await isMentionProcessed(mention.platform, mention.mentionId);
  if (alreadyProcessed) {
    return { pass: false, reason: 'duplicate' };
  }

  // Guardrail 2: Minimum follower count
  const followerCount = mention.authorFollowerCount ?? 0;
  if (followerCount < minFollowers) {
    return { pass: false, reason: `follower_count:${followerCount}<${minFollowers}` };
  }

  // Guardrail 4: Self-reply prevention
  if (mention.platform === 'twitter') {
    // For Twitter we use author handle comparison since we have user_id in rawPayload
    const authorId = (mention.rawPayload as { authorId?: string }).authorId ?? '';
    if (otmTwitterUserId && authorId === otmTwitterUserId) {
      return { pass: false, reason: 'self_reply' };
    }
  } else if (mention.platform === 'farcaster') {
    const authorFid = (mention.rawPayload as { authorFid?: number }).authorFid ?? 0;
    if (otmFarcasterFid && authorFid === otmFarcasterFid) {
      return { pass: false, reason: 'self_reply' };
    }
  }

  return { pass: true };
}

// ── Main cycle ───────────────────────────────────────────────────────

async function runMentionCycle(): Promise<void> {
  console.log('[MentionMonitor] Starting mention cycle...');

  const otmTwitterUserId = getOtmTwitterUserId();
  const otmFarcasterFid = getOtmFarcasterFid();
  const minFollowers = getMinFollowers();

  // Fetch from both platforms independently
  const [twitterMentions, farcasterMentions] = await Promise.all([
    fetchTwitterMentions(),
    fetchFarcasterMentions(),
  ]);

  const allMentions = [...twitterMentions, ...farcasterMentions];

  // Sort oldest-first so we process in chronological order
  allMentions.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  console.log(`[MentionMonitor] Total mentions before guardrails: ${allMentions.length}`);

  const stats = { processed: 0, replied: 0, ignored: 0, queued_correction: 0, filtered: 0 };

  for (const mention of allMentions) {
    // Guardrail 3: Max replies per run
    if (stats.processed >= MAX_REPLIES_PER_RUN) {
      console.log(`[MentionMonitor] Max ${MAX_REPLIES_PER_RUN} mentions/run reached — deferring remainder to next cycle`);
      break;
    }

    const { pass, reason } = await applyGuardrails(mention, otmTwitterUserId, otmFarcasterFid, minFollowers);
    if (!pass) {
      if (reason !== 'duplicate') {
        // Log non-duplicate filtered mentions as IGNORED so they don't retry
        try {
          await callTool('web', 'web_insert_processed_mention', {
            platform: mention.platform,
            mention_id: mention.mentionId,
            author_handle: mention.authorHandle,
            ...(mention.authorFollowerCount !== undefined ? { author_follower_count: mention.authorFollowerCount } : {}),
            mention_text: mention.text,
            intent: 'IGNORE',
            intent_confidence: 1.0,
            action_taken: 'IGNORED',
            raw_payload: mention.rawPayload,
          });
        } catch {
          // Non-fatal
        }
      }
      stats.filtered++;
      continue;
    }

    stats.processed++;
    try {
      const result = await processMention(mention);
      if (result.action === 'replied') stats.replied++;
      else if (result.action === 'queued_correction') stats.queued_correction++;
      else stats.ignored++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[MentionMonitor] Error processing mention ${mention.mentionId}: ${message}`);
      stats.ignored++;
    }
  }

  console.log(
    `[MentionMonitor] Cycle complete — filtered=${stats.filtered} processed=${stats.processed} replied=${stats.replied} queued_correction=${stats.queued_correction} ignored=${stats.ignored}`
  );
}

function scheduleNext(intervalMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, intervalMs);
}

async function runAndReschedule(intervalMs: number): Promise<void> {
  try {
    await runMentionCycle();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[MentionMonitor] Cycle crashed: ${message}`);
  } finally {
    scheduleNext(intervalMs);
  }
}

/**
 * Starts the social mention monitor loop.
 *
 * Env vars:
 *   SOCIAL_MONITOR_ENABLED         — set to 'false' to disable (default: enabled)
 *   SOCIAL_MONITOR_INTERVAL_MS     — interval between cycles (default: 1200000 = 20min)
 *   SOCIAL_MONITOR_DRY_RUN         — set to 'true' to skip publishing (default: false)
 *   MIN_MENTION_FOLLOWER_COUNT     — minimum follower count guardrail (default: 50)
 *   OTM_TWITTER_USER_ID            — OTM's numeric Twitter user ID
 *   OTM_FARCASTER_FID              — OTM's Farcaster FID (number)
 */
export function startMentionMonitor(): void {
  if (process.env.SOCIAL_MONITOR_ENABLED === 'false') {
    console.log('[MentionMonitor] SOCIAL_MONITOR_ENABLED=false — monitor not started');
    return;
  }

  stopped = false;
  const intervalMs = getIntervalMs();
  const isDryRun = process.env.SOCIAL_MONITOR_DRY_RUN === 'true';

  console.log(
    `[MentionMonitor] Starting — interval=${intervalMs}ms (${Math.round(intervalMs / 60000)}min), dry_run=${isDryRun}, min_followers=${getMinFollowers()}`
  );

  // Delay first run by 10 minutes to offset from injury poller and let MCP clients settle
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, STARTUP_DELAY_MS);
}

/**
 * Stops the mention monitor. Safe to call multiple times.
 */
export function stopMentionMonitor(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log('[MentionMonitor] Stopped');
}
