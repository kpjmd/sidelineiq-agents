import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { parseListPostsResponse as parseListPostsPageRows } from '../utils/web-posts.js';
import { maybeProposeReturnWatch } from './return-watch.js';
import { getMaxEventAgeMs } from './sports/text-extraction.js';
import type { RawInjuryEvent } from '../types.js';
import type {
  ExtractedInjuryMetadata,
  ResolvedPlayerInfo,
} from '../agents/injury-intelligence/fact-validator.js';

// Fallback window for the legacy (non-entity) dedup path used when there's
// no resolved player (unresolved or ambiguous athlete, web MCP unavailable).
// No longer the permanent state of any sport: UFC fighters now resolve through
// the athlete-list roster provider, so this is once again what it was designed
// to be — cover for a TRANSIENT resolution failure.
const FALLBACK_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long the same SOURCE ARTICLE stays suppressed.
 *
 * A news article stays in the ESPN feed for MAX_EVENT_AGE_DAYS and is re-emitted
 * as an event on every cycle for its whole life, so a 24-hour memory lets the
 * identical story publish again every single day — up to seven posts about one
 * injury. Anti-spam is a hard requirement, so the article has to stay suppressed
 * for at least as long as the source can keep re-serving it.
 *
 * Keyed on source_url rather than on the athlete, because widening the ATHLETE
 * window would suppress genuine follow-ups: "McGregor to undergo surgery" five
 * days after the ACL report is a different article and a real update. Only the
 * literal same article is blocked.
 */
function sameSourceWindowMs(): number {
  return Math.max(FALLBACK_DEDUP_WINDOW_MS, getMaxEventAgeMs());
}

/**
 * Whether this event's URL identifies one story, so it can be asked "have we
 * already published THIS?".
 *
 * Was `!hasRosterProvider(event.sport)` — the sport standing in for the
 * property that actually matters. It was a correct proxy while UFC was the only
 * rosterless sport AND the only article-sourced one, and it stopped being
 * correct the moment fighters gained player rows. The real condition was always
 * about the URL: a structured feed's source_url is the shared league endpoint
 * (every NFL event carries `.../football/nfl/injuries`), so asking this
 * question there would suppress every athlete after the first.
 */
function hasArticleIdentity(event: RawInjuryEvent): boolean {
  return event.source_kind === 'article' && Boolean(event.source_url);
}

/**
 * The most recent post for this athlete that came from the very same article,
 * within the re-serve window — or null.
 *
 * Shared by both dedup paths. The entity path needs it too: an entity match
 * that is allowed through as an update still gets re-served every cycle for the
 * article's whole life, and without this guard one story would burn a Sonnet
 * call and an entity timeline row every 15 minutes until the cadence throttle
 * caught it downstream. Measured in production: a single NFL entity accumulated
 * 26 timeline rows in 8 days this way.
 */
function findSameArticlePost(
  event: RawInjuryEvent,
  posts: ExistingPost[],
  now: number,
): ExistingPost | null {
  if (!hasArticleIdentity(event)) return null;
  const window = sameSourceWindowMs();
  return (
    posts.find(
      (post) =>
        post.source_url === event.source_url &&
        post.created_at != null &&
        now - new Date(post.created_at).getTime() < window,
    ) ?? null
  );
}

/** Posts for this athlete + sport, not in the future. */
async function listAthletePosts(event: RawInjuryEvent): Promise<ExistingPost[]> {
  const raw = await callTool('web', 'web_list_posts', {
    athlete_name: event.athlete_name,
    sport: event.sport,
    // Explicit: the tool defaults to 20, and a long-running injury thread can
    // exceed that. 50 is the server max.
    limit: 50,
  });
  const now = Date.now();
  return parseListPostsResponse(raw).filter((post) => {
    if (!post.created_at) return false;
    if (post.athlete_name && post.athlete_name !== event.athlete_name) return false;
    if (post.sport && post.sport !== event.sport) return false;
    return now - new Date(post.created_at).getTime() >= 0;
  });
}

interface MCPTextResponse {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface ExistingPost {
  post_id?: string;
  id?: string;
  athlete_name?: string;
  sport?: string;
  created_at?: string;
  headline?: string;
  /** The article this post came from. Persisted on injury_posts and returned
   *  by web_list_posts; article-specific for the news sources, but the shared
   *  feed endpoint for the structured ones. See fallbackDedup. */
  source_url?: string;
}

interface MatchingEntityResponse {
  matched: boolean;
  entity_id: string | null;
  canonical_post_id: string | null;
  body_part: string | null;
  laterality: 'LEFT' | 'RIGHT' | 'BILATERAL' | 'UNSPECIFIED' | null;
  injury_type: string | null;
  last_update_kind: string | null;
  last_severity: string | null;
  last_team_weeks: number | null;
  match_count: number;
}

export interface DedupResult {
  isDuplicate: boolean;
  // Set when an existing entity matched. Use as parent_post_id link on TRACKING posts.
  existingPostId?: string;
  // Set when an entity matched (whether or not we treat it as duplicate).
  entityId?: string;
  // The entity's stored body_part/laterality, when a match occurred — the thread's
  // established facts, as opposed to whatever this new event's text says. Callers
  // use this to detect and flag laterality drift across a thread.
  matchedBodyPart?: string | null;
  matchedLaterality?: 'LEFT' | 'RIGHT' | 'BILATERAL' | 'UNSPECIFIED' | null;
  // Diagnostic — what path made the decision.
  decision?:
    | 'entity_match_skip'
    | 'entity_match_pass_through'
    | 'entity_match_same_source'
    | 'entity_miss'
    | 'fallback_24h'
    | 'fallback_same_source'
    | 'no_match';
}

export interface DedupContext {
  resolvedPlayer: ResolvedPlayerInfo | null;
  metadata: ExtractedInjuryMetadata;
  /**
   * Whether this event reports something NEW about an injury we already track.
   *
   * Computed by the caller, because the two inputs come from different stages:
   * the source's own `is_update` when it has a status field, and otherwise the
   * classifier's `is_new` judgement. See resolveUpdateSignal in poller.ts.
   *
   * Optional so an old caller keeps the previous behaviour (source-only).
   */
  isUpdate?: boolean;
  /** Which of the two produced isUpdate. Diagnostic only. */
  updateSignal?: 'source' | 'classifier' | 'none';
}

function unwrap<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as unknown as T;
  const wrapped = raw as MCPTextResponse;
  if (wrapped.isError) return null;
  const text = wrapped.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Re-exported from utils/web-posts.ts, where the canonical copy now lives —
 * three separate hand-rolled versions of this had drifted apart. Kept here as
 * a named export because poller.ts and publishing-pipeline.ts import it from
 * this module.
 */
export function parseListPostsResponse(raw: unknown): ExistingPost[] {
  return parseListPostsPageRows<ExistingPost>(raw);
}

// Legacy 24h time-window dedup — fallback path when we can't resolve a player
// or the entity lookup fails. Same semantics as before the entity retrofit.
async function fallbackDedup(event: RawInjuryEvent): Promise<DedupResult> {
  try {
    const sameAthlete = await listAthletePosts(event);
    const now = Date.now();

    const recent = sameAthlete.find(
      (post) => now - new Date(post.created_at!).getTime() < FALLBACK_DEDUP_WINDOW_MS,
    );
    if (recent) {
      return {
        isDuplicate: true,
        existingPostId: recent.post_id ?? recent.id,
        decision: 'fallback_24h',
      };
    }

    // Past 24h, one more question: have we already published THIS article?
    const sameSource = findSameArticlePost(event, sameAthlete, now);
    if (sameSource) {
      console.log(
        `[Dedup] ${event.athlete_name} (${event.sport}): same source article already published ` +
          `${Math.round((now - new Date(sameSource.created_at!).getTime()) / 3600_000)}h ago — ` +
          `suppressed (no entity match).`,
      );
      return {
        isDuplicate: true,
        existingPostId: sameSource.post_id ?? sameSource.id,
        decision: 'fallback_same_source',
      };
    }

    return { isDuplicate: false, decision: 'no_match' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Dedup] Fallback lookup failed for ${event.athlete_name} (${event.sport}): ${message}`,
    );
    return { isDuplicate: false };
  }
}

// Entity-aware dedup. Asks the DB whether an active injury entity matching
// (player_id, body_part, laterality, injury_type) exists within 21 days.
// On match: append an injury_updates row tracking the new source report and
//   decide whether to let a new TRACKING post through (only when the event
//   carries an update signal — see DedupContext.isUpdate). Otherwise mark
//   as duplicate so the post is suppressed.
// On miss: return isDuplicate=false. The poller will create the entity AFTER
//   the post is published (so canonical_post_id can be set).
async function entityAwareDedup(
  event: RawInjuryEvent,
  context: DedupContext,
): Promise<DedupResult> {
  const player = context.resolvedPlayer;
  if (!player || player.confidence === 'ambiguous') {
    return fallbackDedup(event);
  }

  // Fall back to the source's own flag when the caller computed nothing, so
  // that a caller predating the classifier signal behaves exactly as before.
  const isUpdate = context.isUpdate ?? Boolean(event.is_update);

  const meta = context.metadata;
  const match = unwrap<MatchingEntityResponse>(
    await callTool('web', 'web_find_matching_entity', {
      player_id: player.player_id,
      body_part: meta.primary_body_part ?? undefined,
      laterality: meta.laterality,
      injury_type: meta.injury_type_hint ?? undefined,
      recency_days: 21,
    }),
  );

  if (!match || !match.matched || !match.entity_id) {
    return { isDuplicate: false, decision: 'entity_miss' };
  }

  // A matched entity plus an article we have already published about it is the
  // same story being re-served, not a new report. Checked BEFORE the timeline
  // append and before the update escape, because an article stays in the feed
  // for MAX_EVENT_AGE_DAYS and is re-emitted every cycle: without this, one
  // story would add a timeline row every 15 minutes for a week, and — once the
  // classifier signal opens the escape — burn a Sonnet call each time before
  // the cadence throttle rejected it downstream.
  if (hasArticleIdentity(event)) {
    try {
      const now = Date.now();
      const sameSource = findSameArticlePost(event, await listAthletePosts(event), now);
      if (sameSource) {
        console.log(
          `[Dedup] ${event.athlete_name} (${event.sport}): entity ${match.entity_id} already has a ` +
            `post from this article ` +
            `${Math.round((now - new Date(sameSource.created_at!).getTime()) / 3600_000)}h ago — suppressed.`,
        );
        return {
          isDuplicate: true,
          existingPostId: sameSource.post_id ?? match.canonical_post_id ?? undefined,
          entityId: match.entity_id,
          matchedBodyPart: match.body_part,
          matchedLaterality: match.laterality,
          decision: 'entity_match_same_source',
        };
      }
    } catch (err) {
      // A failed lookup must not suppress: falling through re-serves at worst,
      // where returning "duplicate" would silently drop a real report.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Dedup] same-article check failed for entity=${match.entity_id}: ${message}`,
      );
    }
  }

  // Append the source report to the entity timeline, with no post linkage
  // unless we end up letting one through below.
  const updateKind = isUpdate ? 'TRACKING' : 'CORRECTION';
  try {
    await callTool('web', 'web_append_injury_update', {
      entity_id: match.entity_id,
      update_kind: updateKind,
      source_url: event.source_url,
      description: event.injury_description.slice(0, 500),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Dedup] entity update append failed for entity=${match.entity_id}: ${message}`,
    );
  }

  try {
    await maybeProposeReturnWatch(match.entity_id, updateKind, {
      athleteName: event.athlete_name,
      sport: event.sport,
      sourceUrl: event.source_url,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Dedup] Return Watch check failed for entity=${match.entity_id}: ${message}`);
  }

  // An update signal means "this reports something new about a known injury" →
  // allow a TRACKING post. For the structured feeds that is ESPN's own status
  // change; for the news sources, which have no status field at all, it is the
  // classifier's is_new judgement. Without the second, a sport sourced purely
  // from news would be silenced for the whole 21-day window after its first
  // post — the surgery follow-up five days after the ACL report would never
  // publish. Everything downstream still applies: TRACKING needs tier 1-2, a
  // bar of 70, and the 5-day per-thread cadence throttle.
  if (isUpdate) {
    return {
      isDuplicate: false,
      existingPostId: match.canonical_post_id ?? undefined,
      entityId: match.entity_id,
      matchedBodyPart: match.body_part,
      matchedLaterality: match.laterality,
      decision: 'entity_match_pass_through',
    };
  }

  // Repeat source article about the same entity → suppress the post.
  return {
    isDuplicate: true,
    existingPostId: match.canonical_post_id ?? undefined,
    entityId: match.entity_id,
    matchedBodyPart: match.body_part,
    matchedLaterality: match.laterality,
    decision: 'entity_match_skip',
  };
}

/**
 * Checks whether a raw event is already covered.
 *
 * Two paths:
 *  • Entity-aware (preferred) — when context contains a resolved player, the
 *    function looks up the matching injury_entity by player + body part +
 *    laterality + injury type within a 21-day window. Repeat reports about
 *    the same entity append to its timeline and are suppressed from publishing.
 *    Events carrying an update signal (context.isUpdate — the source's status
 *    change, or the classifier's judgement where the source has no status
 *    field) are allowed through as TRACKING posts, unless we have already
 *    published the very same article.
 *  • Fallback — 24h time-window dedup on (athlete_name, sport). Used when no
 *    resolved player is available (ambiguous match, MCP failure, a name the
 *    roster does not know).
 *
 * On any MCP failure the function returns isDuplicate:false so the pipeline
 * continues (publishing-pipeline.ts has its own dedup fallback).
 */
export async function checkForExisting(
  event: RawInjuryEvent,
  context?: DedupContext,
): Promise<DedupResult> {
  if (!isServerAvailable('web')) {
    return { isDuplicate: false };
  }
  if (context) {
    return entityAwareDedup(event, context);
  }
  return fallbackDedup(event);
}
