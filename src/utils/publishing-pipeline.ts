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
export function getMDReviewThreshold(): number {
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

export interface ExistingPost {
  id?: string;
  athlete_name?: string;
  sport?: string;
  created_at?: string;
  headline?: string;
  content_type?: string;
  team_timeline_weeks?: number;
  status?: string;
  parent_post_id?: string | null;
  /** Present on every real row; declared here so isSameReviewQuestion can
   *  let an escalation (MODERATE → SEVERE) reach the queue as a fresh item. */
  injury_severity?: string;
  /** Set on REJECTED and SUPERSEDED rows only (mcp migration 021). */
  retired_at?: string | null;
}

/**
 * Coerce an untyped MCP column to a number-or-null for comparison.
 *
 * The prior post's value arrives as untyped MCP data — a numeric column
 * arriving as "2" would make `'2' !== 2` true for every comparison and turn
 * whichever check uses it into a no-op. Shared by the cadence throttle and the
 * pending-review check so the two cannot drift.
 */
function weeksValue(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The same value read as "did a team actually disclose a timeline", collapsing
 * a non-positive week count to "no".
 *
 * The tool schema asks for `team_timeline_weeks` only "if a team-reported
 * timeline is present", so the honest answer to "no timeline" is to omit the
 * field. The model does not always oblige: the three duplicate Tyler Biadasz
 * review rows filed on 2026-08-20 alternate null, 0, null for one ACL tear
 * nobody put a number on, and a 0-week return from an ACL tear is not a
 * disclosure in any case. Read strictly, that flap reads as two material
 * changes and every one of those rows files again.
 *
 * checkFollowUpCadence keeps the strict weeksValue reading on purpose. Both
 * functions err toward "let it through", but that means opposite things: there
 * it publishes an update, which is safe, and here it files another review item,
 * which is the failure being fixed. Same column, two questions.
 */
function disclosedWeeks(v: unknown): number | null {
  const n = weeksValue(v);
  return n === null || n <= 0 ? null : n;
}

/**
 * The FALLBACK duplicate check: a flat 24h (athlete, sport) match, for when
 * there is no thread context to reason with.
 *
 * Two things it must not do, both of which it did until 2026-08-19:
 *
 * 1. **Count posts nobody saw.** web_list_posts returns every status, so an
 *    unapproved post sitting in the MD queue silenced every later report about
 *    that athlete for 24h. With almost everything routing to review, the queue
 *    was suppressing its own follow-ups. checkFollowUpCadence below already
 *    filters to PUBLISHED for exactly this reason; this never got the same
 *    filter.
 *
 * 2. **Outrank the entity-aware dedup.** When `parent_post_id` is set, the
 *    poller has already matched an entity and decided this is a legitimate
 *    follow-up on a known thread. checkFollowUpCadence is what governs those,
 *    and it has the domain rules — a 5-day per-thread window, bypassed by a
 *    materially new team-disclosed timeline. A blanket 24h name match running
 *    FIRST just vetoed that decision: Jayden Higgins cleared entity dedup as
 *    `entity_match_pass_through`, reached the thread manager, resolved his
 *    dates, and then died here.
 *
 * The exemption is deliberately narrow — only the content types
 * checkFollowUpCadence actually governs — so nothing becomes ungoverned.
 */
function isDuplicate(content: InjuryPostContent, existingPosts: ExistingPost[]): boolean {
  const governedByCadence =
    Boolean(content.parent_post_id) &&
    (content.content_type === 'TRACKING' || content.content_type === 'CONFLICT_FLAG');
  if (governedByCadence) return false;

  const now = Date.now();
  return existingPosts.some((post) => {
    // Only a post that actually reached an audience is evidence we covered
    // this. PENDING_REVIEW, DRAFT, rejected or status-less rows are not.
    if (post.status !== 'PUBLISHED') return false;
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

  const threadId = content.parent_post_id;

  const lastFollowUp = existingPosts
    .filter((p) => p.athlete_name === content.athlete_name && p.sport === content.sport)
    // Only a post that actually reached the public can justify staying quiet.
    // web_list_posts returns every status, so without this a PENDING_REVIEW post
    // — including one an MD rejected — starts a cooldown that suppresses the
    // next 5 days of updates for an athlete nobody ever heard about.
    .filter((p) => p.status === 'PUBLISHED')
    // Same thread only. Scoping by athlete meant an unrelated older injury
    // throttled a brand-new one: a hamstring follow-up in March could silence
    // the first update on an ACL tear in October.
    .filter((p) => p.id === threadId || p.parent_post_id === threadId)
    // Same type only. Pooling the two and taking the newest let a CONFLICT_FLAG
    // anchor a TRACKING cooldown and vice versa, so the 14-day conflict window
    // silently governed routine 5-day updates.
    .filter((p) => p.content_type === content.content_type)
    .filter((p): p is ExistingPost & { created_at: string } => !!p.created_at)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  if (!lastFollowUp) return { throttled: false };

  // Material-change override: any change in the team-disclosed timeline
  // (including a first-time disclosure) always publishes regardless of cooldown.
  // See weeksValue for why the comparison is coerced.
  if (
    weeksValue(content.team_timeline_weeks) !== weeksValue(lastFollowUp.team_timeline_weeks)
  ) {
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

/**
 * Do these two rows ask the MD the same question?
 *
 * Identity, content type, thread, disclosed timeline, severity — and nothing
 * else. Reads neither `status` nor time: three callers need this predicate and
 * each answers a DIFFERENT question with it, so each owns its own status filter
 * and its own window. Folding either in here would make one function answer two
 * questions, which is the shape CLAUDE.md's "Publishing and re-routing are
 * different questions" exists to forbid.
 *
 * Deliberately narrow — every one of these differences is a fresh question:
 *  • a different content_type. A CONFLICT_FLAG exists to say the sources
 *    disagree, and a reviewer should see that next to the BREAKING it
 *    contradicts rather than behind it. (Danny Pinter filed a BREAKING and a
 *    CONFLICT_FLAG 25s apart for one patellar tendon tear; both belong in the
 *    queue.)
 *  • a different thread, when thread identity exists.
 *  • a materially new team-disclosed timeline — the same override the cadence
 *    throttle honours, read through disclosedWeeks rather than weeksValue.
 *    See disclosedWeeks for why the two differ.
 *  • an escalation in severity. MODERATE → SEVERE is exactly what a reviewer
 *    needs to see, and severity independently forces review anyway.
 */
export function isSameReviewQuestion(content: InjuryPostContent, post: ExistingPost): boolean {
  const threadId = content.parent_post_id;

  if (post.athlete_name !== content.athlete_name || post.sport !== content.sport) {
    return false;
  }
  if (post.content_type !== content.content_type) return false;
  // Deliberately NOT compared: injury_type, headline, clinical_summary.
  // All are free model prose and vary on every generation — the three live
  // Biadasz rows say "ACL tear, left knee (with additional injuries)",
  // "ACL tear with additional left knee injuries (multi-structure)" and
  // "ACL tear (left knee) with additional left knee injury — Grade 3
  // LIG/LE". Comparing any of them would never match and the check would
  // suppress nothing.
  // Same thread only, when this post knows its thread. A BREAKING with no
  // parent matches at athlete level, which is all the identity it has.
  if (threadId && !(post.id === threadId || post.parent_post_id === threadId)) {
    return false;
  }
  if (disclosedWeeks(post.team_timeline_weeks) !== disclosedWeeks(content.team_timeline_weeks)) {
    return false;
  }
  // A row with no severity at all is malformed — every real row carries
  // one — and a malformed row must not silence a review item. Same reason
  // isDuplicate refuses to let a status-less row count as coverage.
  if (post.injury_severity !== content.injury_severity) return false;
  return true;
}

/**
 * The review item already sitting unresolved in the MD queue that asks the same
 * question this post would ask — or null.
 *
 * "Should this follow-up publish?" and "should this event re-route to review?"
 * are different questions, and until 2026-08-21 nothing asked the second one.
 * PR #37 correctly stopped an unapproved post from counting as evidence we
 * COVERED a story — isDuplicate and checkFollowUpCadence both filter to
 * PUBLISHED. The cost was that a PENDING_REVIEW post then had no memory
 * anywhere: ESPN re-serves the same status row every POLL_INTERVAL_MS, the
 * classifier keeps answering is_new, entity dedup passes it through as a
 * legitimate follow-up, and the pipeline filed another identical review item
 * every cycle. Observed in the live queue: Tyler Biadasz ×3 and Alvin Kamara ×2
 * byte-identical TRACKING rows, one per cycle, same md_review_reason each time.
 *
 * A pending post is not evidence we covered the story. It IS evidence we
 * already asked the MD this exact question, and asking again while they have
 * not answered adds nothing a reviewer can act on.
 *
 * No time window, and that is the difference from findRecentRejection: while
 * the row is PENDING the queue still holds the question, however old it is.
 * Approval turns it PUBLISHED and the cadence throttle takes over.
 */
function findEquivalentPendingReview(
  content: InjuryPostContent,
  existingPosts: ExistingPost[],
): ExistingPost | null {
  return (
    existingPosts.find(
      (post) => post.status === 'PENDING_REVIEW' && isSameReviewQuestion(content, post),
    ) ?? null
  );
}

/**
 * How long a rejection is remembered.
 *
 * 21 days, matching web_find_matching_entity's recency_days: a rejection stops
 * mattering when the entity that anchored it ages out of the window, because
 * after that the next report opens a new thread and is a genuinely new
 * question rather than the same one re-asked.
 */
export const REJECTION_MEMORY_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * A rejection the MD made recently that already answered this exact question —
 * or null.
 *
 * The Reject button used to hard-DELETE the post row, so the queue's only
 * memory (findEquivalentPendingReview, which anchors on PENDING_REVIEW) was
 * destroyed by the one action that most needed to be remembered: the story
 * re-filed on the next 6h poll, and every poll after that. mcp migration 021
 * keeps the row as REJECTED instead, and this is what reads it.
 *
 * A sibling of findEquivalentPendingReview rather than a branch inside it. They
 * share isSameReviewQuestion and nothing else: that one has no time window
 * because a pending row holds the question open indefinitely, and this one must
 * have one because a rejection is a judgement about a moment. One function with
 * a status-conditional window would be two questions wearing one name.
 *
 * FAILS OPEN on an unreadable retired_at. A REJECTED row with no parseable
 * timestamp is malformed, and a malformed row must not silence a review item —
 * the same rule isSameReviewQuestion applies to a missing severity. The log
 * line makes that case greppable rather than invisible.
 */
export function findRecentRejection(
  content: InjuryPostContent,
  existingPosts: ExistingPost[],
  now: number = Date.now(),
): ExistingPost | null {
  return (
    existingPosts.find((post) => {
      if (post.status !== 'REJECTED') return false;
      if (!isSameReviewQuestion(content, post)) return false;
      const retiredAt = post.retired_at ? new Date(post.retired_at).getTime() : NaN;
      if (!Number.isFinite(retiredAt)) {
        console.warn(
          `[Pipeline] REJECTED row ${post.id} has no readable retired_at — not suppressing`,
        );
        return false;
      }
      return now - retiredAt < REJECTION_MEMORY_MS;
    }) ?? null
  );
}

/**
 * Pending review items this publish has just overtaken.
 *
 * A third question again, and the one nothing asked before. #38 stopped the
 * pipeline re-FILING a review item while an equivalent one was pending, but it
 * runs inside the `review.needed` branch — so when the next cycle's post
 * PUBLISHES instead, it never enters that branch and the pending sibling is
 * left sitting there, approvable.
 *
 * Alvin Kamara, 2026-08-21: TRACKING c59cba69 filed to PENDING_REVIEW at 12:26
 * on thread b8d94a3f with a 4-week timeline; TRACKING caf3fee4 PUBLISHED at
 * 12:41 on the same thread with the same timeline. Approving the pending one
 * would have posted him to Farcaster and X a second time. It was rejected by
 * hand instead.
 *
 * REQUIRES thread identity, unlike findRecentRejection. Retiring a queue item
 * is a write against the MD's work, and athlete-level identity — all a
 * parentless BREAKING has — is too weak to authorise it. The two functions err
 * in opposite directions on purpose: there, a false match delays a question,
 * which is cheap; here, a false match silently removes one.
 */
export function findSupersededPending(
  content: InjuryPostContent,
  existingPosts: ExistingPost[],
  publishedPostId: string | undefined,
): ExistingPost[] {
  if (!content.parent_post_id) return [];
  return existingPosts.filter(
    (post) =>
      post.status === 'PENDING_REVIEW' &&
      post.id !== undefined &&
      post.id !== publishedPostId &&
      isSameReviewQuestion(content, post),
  );
}

/**
 * Retire the pending items this publish covered. Never fatal.
 *
 * Runs AFTER the social calls: queue hygiene must not delay or endanger the
 * cast and the tweet. The post is already live by the time this runs, so
 * nothing it does can un-publish anything, and a failure must not turn a
 * successful publish into a reported failure.
 *
 * The cost of that choice, stated plainly because it is not recoverable: there
 * is no second chance. The next cycle's equivalent post dies at
 * checkFollowUpCadence and so never reaches this code, which leaves a
 * permanently approvable stale item. The log line is the only signal, and it
 * matches the SOCIAL PUBLISH FAILED grep pattern for that reason. A recovery
 * sweep in approval-sync.ts is the proper fix and is not built here.
 */
async function supersedePendingSiblings(
  content: InjuryPostContent,
  existingPosts: ExistingPost[],
  publishedPostId: string | undefined,
  context: string,
): Promise<string[]> {
  const stale = findSupersededPending(content, existingPosts, publishedPostId);
  if (stale.length === 0 || !publishedPostId) return [];

  const ids = stale.map((p) => p.id!).filter(Boolean);
  try {
    const res = await callTool('web', 'web_supersede_injury_post', {
      post_ids: ids,
      superseded_by: publishedPostId,
      reason: `Superseded by ${publishedPostId}, published on the same thread`,
    });
    // Tool-level failures resolve as a VALUE carrying isError, not a throw —
    // the try/catch below would never see one.
    if (isMCPError(res)) {
      console.error(
        `[Pipeline] SUPERSEDE FAILED for ${context}: ${extractMCPErrorMessage(res)} ` +
          `(${ids.length} pending item(s) left approvable: ${ids.join(', ')})`,
      );
      return [];
    }
    console.log(
      `[Pipeline] Superseded ${ids.length} pending review item(s) for ${context}: ${ids.join(', ')}`,
    );
    return ids;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[Pipeline] SUPERSEDE FAILED for ${context}: ${message} ` +
        `(${ids.length} pending item(s) left approvable: ${ids.join(', ')})`,
    );
    return [];
  }
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
 * Reports whether a publish actually reached an audience.
 *
 * Three outcomes used to be indistinguishable in the logs, and the most
 * dangerous one was completely silent: when both extractors returned null the
 * writeback guard simply skipped with no line at all. They have entirely
 * different fixes — a failed publish is a transport or credential problem, an
 * unparseable hash means the post IS live and only the DB link is missing — so
 * they get distinct, greppable lines.
 */
function reportSocialReach(
  context: string,
  webPostId: string | null,
  farcasterResult: PlatformResult | undefined,
  twitterResult: PlatformResult | undefined,
  farcasterHash: string | null,
  twitterId: string | null
): void {
  const postRef = webPostId ?? 'unknown';

  if (!farcasterResult?.success && !twitterResult?.success) {
    console.error(
      `[Pipeline] SOCIAL PUBLISH FAILED — ${context} (post ${postRef}) reached 0 social platforms: ` +
        `farcaster=${farcasterResult?.error ?? 'not attempted'}; ` +
        `twitter=${twitterResult?.error ?? 'not attempted'}`
    );
    return;
  }

  if (farcasterResult?.success && !farcasterHash) {
    console.error(
      `[Pipeline] SOCIAL HASH UNPARSEABLE — ${context} (post ${postRef}): the cast published but no hash could be read from the response. The cast is live; the DB link will be missing.`
    );
  }
  if (twitterResult?.success && !twitterId) {
    console.error(
      `[Pipeline] SOCIAL HASH UNPARSEABLE — ${context} (post ${postRef}): the tweet published but no id could be read from the response. The tweet is live; the DB link will be missing.`
    );
  }
}

/**
 * Writes the social hashes back to the web post.
 *
 * callTool resolves tool-level failures as a normal value ({isError:true})
 * rather than throwing, so the isMCPError check is what stops a rejected write
 * from logging as a success — which is exactly how a broken writeback could
 * stay invisible.
 */
async function writeSocialHashesBack(
  webPostId: string,
  farcasterHash: string | null,
  twitterId: string | null,
  updateReason: string
): Promise<void> {
  if (!farcasterHash && !twitterId) return;

  try {
    const data = await callTool('web', 'web_update_injury_post', {
      post_id: webPostId,
      updates: {
        ...(farcasterHash && { farcaster_hash: farcasterHash }),
        ...(twitterId && { twitter_id: twitterId }),
      },
      update_reason: updateReason,
    });
    if (isMCPError(data)) throw new Error(extractMCPErrorMessage(data));
    console.log(
      `[Pipeline] Wrote social hashes back to post ${webPostId} (farcaster: ${!!farcasterHash}, twitter: ${!!twitterId})`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[Pipeline] Failed to write social hashes to post ${webPostId}: ${message} — the post is live on socials but the DB link is missing`
    );
  }
}

/**
 * Publishes an already-approved post to Farcaster and X/Twitter.
 * Called by the /admin/approve/:post_id endpoint after the frontend has
 * already called web_approve_injury_post (which flips the DB status to PUBLISHED),
 * and by ApprovalSync when a publish failed and needs re-casting.
 *
 * Works for every content type — the formatters dispatch on content.content_type.
 * It was named publishApprovedDeepDive and said "DEEP_DIVE" in every log line it
 * emitted, so a BREAKING post approved by an MD logged as an approved DEEP_DIVE.
 * That was misleading in precisely the logs relied on to tell whether a publish
 * reached anyone.
 *
 * @param content   - Reconstructed InjuryPostContent from the approved post row
 * @param postUrl   - Full web URL of the published post (included in final social cast)
 * @param webPostId - Post ID for hash write-back to the web DB
 */
export async function publishApprovedPost(
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
      console.error(`[Pipeline] Approved ${content.content_type} Farcaster publish failed for ${context}: ${message}`);
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
      console.error(`[Pipeline] Approved ${content.content_type} Twitter publish failed for ${context}: ${message}`);
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

  reportSocialReach(context, webPostId, farcasterResult, twitterResult, farcasterHash, twitterId);

  if (webPostId) {
    await writeSocialHashesBack(
      webPostId,
      farcasterHash,
      twitterId,
      `Approved ${content.content_type} social hash writeback`
    );
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
  console.log(`[Pipeline] Approved ${content.content_type} social publish for ${context}: ${successCount}/${platformResults.length} platforms`);

  return { status: 'published', post_id: webPostId, platform_results: platformResults };
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

  // Every existing post for this athlete, as fetched in Step 1. Hoisted because
  // the MD-review check in Step 2 asks a different question of the same rows and
  // must not spend a second call to do it. Stays [] when the lookup fails, which
  // fails OPEN in both directions: a report publishes, and a review item files.
  let existingPosts: ExistingPost[] = [];

  // Step 1: Deduplication + follow-up cadence check
  try {
    if (isServerAvailable('web')) {
      const result = await callTool('web', 'web_list_posts', {
        athlete_name: content.athlete_name,
        sport: content.sport,
        // Explicit: the tool defaults to 20, which would silently shorten the
        // history the cadence throttle below reasons over on a long thread.
        limit: 50,
      });

      // web_list_posts comes back as an MCP envelope ({content:[{text}]}), not a
      // bare array — parseListPostsResponse unwraps both shapes. A plain
      // Array.isArray check here silently yielded [] in production, disabling
      // this fallback dedup entirely.
      existingPosts = parseListPostsResponse(result) as ExistingPost[];
      if (isDuplicate(content, existingPosts)) {
        console.log(`[Pipeline] Duplicate detected for ${context}, skipping`);
        return { status: 'skipped', reason: 'duplicate', platform_results: [] };
      }

      const cadence = checkFollowUpCadence(content, existingPosts);
      if (cadence.throttled) {
        console.log(`[Pipeline] ${cadence.reason} for ${context}, skipping`);
        return { status: 'skipped', reason: cadence.reason, platform_results: [] };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Pipeline] Dedup/cadence check failed for ${context}, proceeding: ${message}`);
  }

  // Step 2: MD review check. The force flag makes review unconditional, but it
  // does NOT replace what needsMDReview would have said — both reasons are
  // recorded. Short-circuiting dropped the second half on every forced post, so
  // a SEVERE injury flagged for e.g. athlete_name_drift reached the queue with
  // no indication it was also SEVERE, and the reviewer had to infer it.
  const intrinsic = needsMDReview(content);
  const reasons = [opts.forceMDReviewReason, intrinsic.reason].filter(Boolean);
  const review = opts.forceMDReviewReason
    ? { needed: true, reason: reasons.join('; ') }
    : intrinsic;
  if (review.needed) {
    // Only asked on the review path. A post that would publish normally must
    // never be skipped for having a stale pending sibling — that is the publish
    // question, and isDuplicate/checkFollowUpCadence already answered it.
    const pending = findEquivalentPendingReview(content, existingPosts);
    if (pending) {
      const ageH = pending.created_at
        ? Math.round((Date.now() - new Date(pending.created_at).getTime()) / 3600_000)
        : null;
      console.log(
        `[Pipeline] Review already pending for ${context} (post ${pending.id}` +
          `${ageH === null ? '' : `, filed ${ageH}h ago`}) — not re-filing: ${review.reason}`,
      );
      return {
        status: 'skipped',
        reason: 'already_pending_review',
        platform_results: [],
      };
    }

    // Same branch, and the same reasoning one step further on: the MD has
    // already answered this question, and re-asking is what rejection used to
    // guarantee. Runs after the pending check because a pending sibling is the
    // cheaper and more current answer of the two.
    const rejected = findRecentRejection(content, existingPosts);
    if (rejected) {
      const ageD = rejected.retired_at
        ? Math.round((Date.now() - new Date(rejected.retired_at).getTime()) / 86_400_000)
        : null;
      console.log(
        `[Pipeline] Rejected${ageD === null ? '' : ` ${ageD}d ago`} for ${context} ` +
          `(post ${rejected.id}) — not re-filing: ${review.reason}`,
      );
      return {
        status: 'skipped',
        reason: 'rejected_recently',
        platform_results: [],
      };
    }

    console.log(`[Pipeline] Routing to MD review: ${context} — ${review.reason}`);

    const webResult = await publishToWeb(content, 'PENDING_REVIEW');
    const platformResults = [webResult];

    // Flag for MD review if web post succeeded
    const reviewPostId = webResult.success ? extractWebPostId(webResult.data) : null;
    if (reviewPostId) {
      try {
        const flagged = await callTool('web', 'web_flag_for_md_review', {
          post_id: reviewPostId,
          reason: review.reason,
          confidence_score: content.confidence,
          flagged_by: 'injury-intelligence-agent',
        });
        // Tool-level failures resolve as a value, not a throw — without this the
        // post sits in PENDING_REVIEW with no review row and nothing says so.
        if (isMCPError(flagged)) throw new Error(extractMCPErrorMessage(flagged));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Pipeline] Failed to flag for MD review: ${message}`);
      }
    }

    return {
      status: 'pending_review',
      reason: review.reason,
      // The poller needs this to run entity maintenance — a PENDING_REVIEW post
      // is a real row in the web DB, so it anchors a thread just like a published one.
      ...(reviewPostId && { post_id: reviewPostId }),
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
  const farcasterHash = farcasterResult.success ? extractFarcasterHash(farcasterResult.data) : null;
  const twitterId = twitterResult.success ? extractTwitterId(twitterResult.data) : null;

  reportSocialReach(context, webPostId, farcasterResult, twitterResult, farcasterHash, twitterId);

  if (webPostId) {
    await writeSocialHashesBack(webPostId, farcasterHash, twitterId, 'Social platform hash writeback');
  }

  // IndexNow ping — best-effort, independent of hash writeback
  if (webPostSlug) {
    void pingIndexNow(webPostSlug);
  } else {
    console.log(`[Pipeline] IndexNow skipped for ${context}: no slug in web response`);
  }

  // Step 3d — retire any pending review item this publish just answered.
  const supersededIds = await supersedePendingSiblings(
    content,
    existingPosts,
    webPostId ?? undefined,
    context,
  );

  const platformResults = [webResult, farcasterResult, twitterResult];
  const successCount = platformResults.filter((r) => r.success).length;
  console.log(
    `[Pipeline] Published ${context}: ${successCount}/${platformResults.length} platforms at ${timestamp} (confidence: ${content.confidence})`
  );

  return {
    status: 'published',
    ...(webPostId && { post_id: webPostId }),
    platform_results: platformResults,
    ...(supersededIds.length > 0 && { superseded_post_ids: supersededIds }),
  };
}
