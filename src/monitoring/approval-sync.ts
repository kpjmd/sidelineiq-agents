import { isServerAvailable } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import { reconstructPostContent } from '../utils/post-content.js';
import { publishApprovedPost } from '../utils/publishing-pipeline.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_DELAY_MS = 2 * 60 * 1000;    // 2 minutes — let MCP clients settle
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Ceiling on how much of a backlog one cycle may fire at the live accounts.
const MAX_REPUBLISH_PER_CYCLE = 2;
const REPUBLISH_SPACING_MS = 45 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * How stale a failed publish may be before this loop stops owning it.
 *
 * The loop's job is recovering a publish that failed minutes-to-hours ago.
 * Anything older is an editorial decision — whether a days-old injury report is
 * still worth posting is a judgement call, and it belongs to a human running
 * scripts/republish-social-orphans.ts, not to a cron. BREAKING ages fastest:
 * a "breaking" headline cast two days late is false on its face.
 */
const MAX_AGE_BY_TYPE: Record<string, number> = {
  BREAKING: 6 * 60 * 60 * 1000,       // 6 hours
  TRACKING: 48 * 60 * 60 * 1000,      // 2 days
  CONFLICT_FLAG: LOOKBACK_MS,         // 7 days — a disagreement persists
  DEEP_DIVE: LOOKBACK_MS,             // 7 days — evergreen
};

/**
 * Which content types this loop may re-cast.
 *
 * Defaults to DEEP_DIVE only, which is the behaviour that shipped — so the
 * widening below is inert until someone turns it on deliberately. It needs to
 * exist because the Aug 2026 outage orphaned 6 BREAKING and 3 CONFLICT_FLAG
 * posts and not one DEEP_DIVE: the safety net could not have caught the very
 * failure it was built for.
 */
function getAllowedContentTypes(): Set<string> {
  const raw = process.env.APPROVAL_SYNC_CONTENT_TYPES;
  if (!raw) return new Set(['DEEP_DIVE']);
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? new Set(parsed) : new Set(['DEEP_DIVE']);
}

/** Posts on one injury thread share a canonical root. */
function threadKey(p: ApprovedPost): string {
  return String(p.parent_post_id ?? p.post_id ?? p.id ?? '');
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
  const allowedTypes = getAllowedContentTypes();

  const eligible = posts.filter((p) => {
    const postId = String(p.post_id ?? p.id ?? '');
    if (!postId || alreadyProcessed.has(postId)) return false;

    const status = (p.status ?? '').toUpperCase();
    if (status !== 'PUBLISHED') return false;

    const contentType = (p.content_type ?? '').toUpperCase();
    if (!allowedTypes.has(contentType)) return false;
    if (p.farcaster_hash || p.twitter_id) return false;
    if (!p.created_at) return false;

    const createdAt = new Date(p.created_at).getTime();
    // Unknown types never reach here, so the fallback only guards a type added
    // to the allowlist before it gets an age budget — treat it as the strictest.
    const maxAge = MAX_AGE_BY_TYPE[contentType] ?? MAX_AGE_BY_TYPE.BREAKING;
    if (now - createdAt >= maxAge) return false;

    if (notBeforeMs !== null && createdAt < notBeforeMs) {
      suppressed++;
      return false;
    }

    return true;
  });

  // One per thread, newest wins. This loop calls publishApprovedPost, which
  // skips the dedup and cadence checks publishInjuryPost performs — so without
  // this, three hashless CONFLICT_FLAGs on one injury go out back to back,
  // and the two older ones carry a superseded team timeline.
  const newestPerThread = new Map<string, ApprovedPost>();
  for (const p of eligible) {
    const key = threadKey(p);
    const existing = newestPerThread.get(key);
    if (
      !existing ||
      new Date(p.created_at ?? 0).getTime() > new Date(existing.created_at ?? 0).getTime()
    ) {
      newestPerThread.set(key, p);
    }
  }

  const pending = [...newestPerThread.values()].sort(
    (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime()
  );

  return { pending, suppressed };
}

export interface SocialReachReport {
  window_hours: number;
  published: number;
  missing_social: number;
  oldest_missing: string | null;
  /** Rows actually read. Without it, a scan that saw 20 rows and one that saw
   *  400 report identically — which is exactly how the 20-row cap hid. */
  scanned: number;
  /** True when the page cap ended the scan early, so the counts are a floor. */
  truncated: boolean;
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

  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;

  // Filter by status server-side and stop at the window edge: the scan costs
  // one page in the common case and still sees every PUBLISHED row in a 30-day
  // window, which the old unpaged call could not do at any window size.
  const { posts, truncated } = await listAllPosts<ApprovedPost>(
    { status: 'PUBLISHED' },
    { stopWhenOlderThan: now - windowMs },
  );

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
    scanned: posts.length,
    truncated,
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

  const now = Date.now();

  // One scan feeds both consumers below: the 7-day republish lookback is the
  // wider of the two windows, so it contains the 24h audit window as well.
  let posts: ApprovedPost[];
  try {
    ({ posts } = await listAllPosts<ApprovedPost>(
      { status: 'PUBLISHED' },
      { stopWhenOlderThan: now - LOOKBACK_MS },
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ApprovalSync] web_list_posts failed: ${message}`);
    return;
  }

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

  const types = pending.map((p) => String(p.content_type ?? '?')).join(', ');
  console.log(
    `[ApprovalSync] Found ${pending.length} approved post(s) not yet on socials (${types})`
  );

  // A backlog drips, it does not flood. Even inside the cutoff, a recovered
  // publish path should not fire everything it finds in one cycle.
  const batch = pending.slice(0, MAX_REPUBLISH_PER_CYCLE);
  if (pending.length > batch.length) {
    console.log(
      `[ApprovalSync] Publishing ${batch.length} this cycle; ${pending.length - batch.length} deferred to the next`
    );
  }

  const siteUrl = (process.env.SITE_URL ?? 'https://sidelineiq.vercel.app').replace(/\/$/, '');

  for (const [index, post] of batch.entries()) {
    const webPostId = String(post.post_id ?? post.id ?? '');
    const { content, reason } = reconstructPostContent(post);

    if (!content) {
      console.warn(
        `[ApprovalSync] Skipping post ${webPostId} — ${
          reason === 'unknown_content_type'
            ? `unrecognized content_type "${post.content_type ?? ''}"`
            : 'missing RTP data'
        }`
      );
      continue;
    }

    const slug = String(post.slug ?? '');
    const postUrl = slug ? `${siteUrl}/post/${slug}` : '';

    if (index > 0) await sleep(REPUBLISH_SPACING_MS);

    // Mark before publishing so a slow publish doesn't cause a duplicate on the
    // next cycle if the loop fires again before hashes are written back.
    processedIds.add(webPostId);

    console.log(
      `[ApprovalSync] Publishing to socials: ${webPostId} (${content.content_type}: ${content.athlete_name})`
    );
    try {
      await publishApprovedPost(content, postUrl, webPostId);
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
