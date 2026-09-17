import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import { reconstructPostContent, describeReconstructFailure, type StoredPostRow } from '../utils/post-content.js';
import { publishApprovedPost, isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { siteOrigin } from '../config/brand.js';

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
// with no hash is mid-flight, not failed. Both the audit and the republish
// selector below need this: one to avoid reporting a false outage, the other to
// avoid casting a post twice. Matches republish-social-orphans.ts's GRACE_MS.
const IN_FLIGHT_GRACE_MS = 10 * 60 * 1000;   // 10 minutes
const LOG_THROTTLE_MS = 60 * 60 * 1000;      // 1 hour — cycles run every 5 min

let timer: NodeJS.Timeout | null = null;
let stopped = false;
let lastAuditLogAt = 0;
let lastSuppressionLogAt = 0;
let lastWithheldLogAt = 0;

// Tracks post IDs published this process lifetime to prevent double-publishing
// when social-hash writeback hasn't landed yet on a subsequent poll cycle.
const processedIds = new Set<string>();

/**
 * A row as returned by web_list_posts / web_approve_injury_post.
 *
 * Extends StoredPostRow rather than restating the column names. The duplicated
 * copy that used to live here had drifted to a set of names injury_posts does
 * not have, and because reconstructPostContent had drifted the same way, the
 * two agreed with each other and not with the database. One definition now.
 */
export interface ApprovedPost extends StoredPostRow {
  post_id?: string;
  id?: string;
  status?: string;
  /** Narrowed from StoredPostRow's `unknown` — the selection filters read it as a string. */
  content_type?: string;
  farcaster_hash?: string | null;
  twitter_id?: string | null;
  created_at?: string;
  /** Bumped by every transition into the hashless-PUBLISHED state — see
   *  lastTouchedMs. Present on the wire (web_list_posts is SELECT *) but was
   *  never declared here, so nothing could read it. */
  updated_at?: string;
  slug?: string;
  md_review_required?: unknown;
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
 * When this row last changed state, as the best available stand-in for "when it
 * became a hashless PUBLISHED row".
 *
 * There is no `published_at` column on injury_posts — the only timestamps are
 * created_at, updated_at, retired_at, corrected_at and injury_date. The two
 * candidates fail differently:
 *
 * `created_at` is when the post was FILED. A review-routed post is filed
 * PENDING_REVIEW and may be approved hours or days later, so a created_at floor
 * does not protect the approve path at all — which is the path with the LONGER
 * in-flight window, since the frontend flips the status and only then calls
 * agents.
 *
 * `updated_at` is set explicitly in SQL by every writer (there is no trigger),
 * including both transitions into PUBLISHED: web_approve_injury_post and
 * web_update_md_review. On the rows this loop targets it therefore reads as
 * "the last time this row changed state". Measured live on 2026-09-11 over 35
 * approved-and-hashed rows, updated_at was at or after md_reviews.reviewed_at
 * in 35 of 35.
 *
 * So: prefer updated_at, fall back to created_at, and take the later of the two
 * so a malformed or absent updated_at can only make the gate MORE cautious.
 */
function lastTouchedMs(p: ApprovedPost): number {
  const created = p.created_at ? new Date(p.created_at).getTime() : NaN;
  const updated = p.updated_at ? new Date(p.updated_at).getTime() : NaN;
  if (Number.isFinite(updated) && Number.isFinite(created)) return Math.max(updated, created);
  if (Number.isFinite(updated)) return updated;
  return created;
}

/**
 * True while the row is young enough that its social calls may still be running.
 *
 * The web post is created BEFORE the social calls and the hashes are written
 * back AFTER, so "PUBLISHED with no hash" is ambiguous for the length of that
 * window: it means either "the publish failed" or "the publish is in progress".
 * Casting on the second reading posts to the live accounts twice.
 *
 * Measured live, the window is sub-second — median 0.4s on the auto path
 * (updated_at - created_at) and 0.8s on the approve path (updated_at -
 * reviewed_at), max 1.1s across 54 rows. The 10-minute floor is not calibration,
 * it is headroom: callTool has no timeout and no retry, so a hung MCP call has
 * no upper bound at all.
 *
 * A row with no usable timestamp is treated as in-flight. It cannot be aged, and
 * the safe failure here is declining to cast.
 */
function isInFlight(p: ApprovedPost, now: number): boolean {
  const touched = lastTouchedMs(p);
  if (!Number.isFinite(touched)) return true;
  return now - touched < IN_FLIGHT_GRACE_MS;
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
    // Grace keys on the last state change; the window keys on filing time, which
    // is what "published in the last 24h" means to a reader of the log line.
    if (isInFlight(p, now)) return false;
    return now - new Date(p.created_at).getTime() < AUDIT_WINDOW_MS;
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
  /** Rows held back because their social calls may still be running. Counted
   *  separately from `suppressed`, which is the editorial backlog cutoff — these
   *  are not suppressed, they are simply not decidable yet. */
  inFlight: number;
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
 *
 * Note the two age bounds, which answer different questions. The per-type
 * ceiling (MAX_AGE_BY_TYPE) asks "is this still worth posting?" and is
 * editorial. The in-flight floor asks "has this finished publishing?" and is a
 * correctness guard — without it a cycle landing inside the publish window
 * casts a post that is in the middle of casting itself.
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

  // The in-flight check runs AFTER the newest-per-thread choice, for the same
  // reason withholdUnapproved does: holding back the newest post must not
  // promote an older hashless sibling in its place. That sibling is on the same
  // thread and therefore carries a superseded timeline — casting it because the
  // current post is still publishing would be worse than the duplicate this
  // guard exists to prevent.
  const settled = [...newestPerThread.values()].filter((p) => !isInFlight(p, now));
  const inFlight = newestPerThread.size - settled.length;

  const pending = settled.sort(
    (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime()
  );

  return { pending, suppressed, inFlight };
}

/**
 * PUBLISHED is not proof of approval, so a row routed to review needs an
 * APPROVED review before this loop may cast it.
 *
 * This loop treats "PUBLISHED with no social hash" as "approved, and its
 * social publish failed". Until 2026-09-11 a post routed to physician review
 * was CREATED PUBLISHED — web_create_injury_post stripped `status` — and only a
 * second call flipped it to PENDING_REVIEW. Had that call failed, the row
 * would have met every condition above, and the default allowlist is DEEP_DIVE:
 * the one type that always routes to review. It would have gone to Farcaster
 * and X inside five minutes with no MD ever seeing it.
 *
 * The create now lands the row PENDING_REVIEW atomically, so this should never
 * withhold anything. It keys on `md_review_required`, which the server has
 * always accepted, so it still holds against an mcp that strips `status` again.
 * Both approval paths (web_approve_injury_post, web_update_md_review) mark the
 * md_reviews row APPROVED; live on 2026-09-11 every one of the 233
 * required-and-PUBLISHED rows had one, so this withholds 0 of them.
 *
 * Runs after the newest-per-thread choice on purpose: withholding the newest
 * post must not promote an older sibling carrying a superseded timeline.
 */
export function withholdUnapproved(
  posts: ApprovedPost[],
  approvedPostIds: ReadonlySet<string>,
): { allowed: ApprovedPost[]; withheld: ApprovedPost[] } {
  const allowed: ApprovedPost[] = [];
  const withheld: ApprovedPost[] = [];
  for (const p of posts) {
    const id = String(p.post_id ?? p.id ?? '');
    if (p.md_review_required === true && !approvedPostIds.has(id)) withheld.push(p);
    else allowed.push(p);
  }
  return { allowed, withheld };
}

/** Post ids with an APPROVED md_reviews row; null when that cannot be read. */
async function fetchApprovedReviewPostIds(): Promise<Set<string> | null> {
  try {
    const result = await callTool('web', 'web_list_md_reviews', { status: 'APPROVED' });
    if (isMCPError(result)) throw new Error(extractMCPErrorMessage(result));
    const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    const reviews = text ? (JSON.parse(text) as { reviews?: Array<{ post_id?: unknown }> }).reviews : undefined;
    if (!Array.isArray(reviews)) throw new Error('web_list_md_reviews returned no reviews array');
    return new Set(reviews.map((r) => String(r.post_id ?? '')).filter(Boolean));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ApprovalSync] web_list_md_reviews failed: ${message}`);
    return null;
  }
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
    // Same grace as the loop, so the endpoint and the log line agree.
    if (isInFlight(p, now)) return false;
    return now - new Date(p.created_at).getTime() < windowMs;
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

  const { pending: selected, suppressed, inFlight } = selectPostsToRepublish(
    posts,
    now,
    getNotBeforeMs(),
    processedIds
  );

  // Unthrottled: this is rare (the publish window is sub-second in practice) and
  // it is the one line that explains why a post you just approved was not cast
  // this cycle. It will be on the next one.
  if (inFlight > 0) {
    console.log(
      `[ApprovalSync] ${inFlight} post(s) changed state inside the ${IN_FLIGHT_GRACE_MS / 60000}-minute in-flight grace — still publishing, not re-casting this cycle`
    );
  }

  if (suppressed > 0 && now - lastSuppressionLogAt >= LOG_THROTTLE_MS) {
    lastSuppressionLogAt = now;
    console.log(
      `[ApprovalSync] ${suppressed} post(s) below the APPROVAL_SYNC_NOT_BEFORE cutoff (${process.env.APPROVAL_SYNC_NOT_BEFORE}) — not auto-republishing`
    );
  }

  if (selected.length === 0) return;

  // Only rows routed to review need the lookup, so the common cycle (nothing
  // review-routed pending) makes no extra call.
  let pending = selected;
  if (selected.some((p) => p.md_review_required === true)) {
    const approvedIds = await fetchApprovedReviewPostIds();
    if (!approvedIds) {
      // Fail closed: an unreadable review table is not permission to cast.
      console.warn('[ApprovalSync] Cannot verify MD approval — not republishing this cycle');
      return;
    }
    const { allowed, withheld } = withholdUnapproved(selected, approvedIds);
    if (withheld.length > 0 && now - lastWithheldLogAt >= LOG_THROTTLE_MS) {
      lastWithheldLogAt = now;
      console.error(
        `[ApprovalSync] WITHHELD ${withheld.length} PUBLISHED post(s) routed to MD review with no APPROVED review — not casting: ` +
          withheld
            .slice(0, 5)
            .map((p) => `${p.athlete_name ?? 'unknown'} (${p.content_type ?? '?'}, ${String(p.post_id ?? p.id ?? '?')})`)
            .join('; ')
      );
    }
    pending = allowed;
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

  const siteUrl = siteOrigin();

  for (const [index, post] of batch.entries()) {
    const webPostId = String(post.post_id ?? post.id ?? '');
    const { content, reason } = reconstructPostContent(post);

    if (!content) {
      console.warn(
        `[ApprovalSync] Skipping post ${webPostId} — ${
          reason === 'unknown_content_type'
            ? `unrecognized content_type "${post.content_type ?? ''}"`
            : describeReconstructFailure(reason)
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
