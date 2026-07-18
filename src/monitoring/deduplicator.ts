import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { maybeProposeReturnWatch } from './return-watch.js';
import type { RawInjuryEvent } from '../types.js';
import type {
  ExtractedInjuryMetadata,
  ResolvedPlayerInfo,
} from '../agents/injury-intelligence/fact-validator.js';

// Fallback window for the legacy (non-entity) dedup path used when there's
// no resolved player (UFC, unresolved athlete, web MCP unavailable).
const FALLBACK_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  decision?: 'entity_match_skip' | 'entity_match_pass_through' | 'entity_miss' | 'fallback_24h' | 'no_match';
}

export interface DedupContext {
  resolvedPlayer: ResolvedPlayerInfo | null;
  metadata: ExtractedInjuryMetadata;
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

export function parseListPostsResponse(raw: unknown): ExistingPost[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as ExistingPost[];
  const wrapped = raw as MCPTextResponse;
  if (wrapped.isError) return [];
  const text = wrapped.content?.[0]?.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as ExistingPost[];
    if (parsed && Array.isArray((parsed as { posts?: unknown }).posts)) {
      return (parsed as { posts: ExistingPost[] }).posts;
    }
    return [];
  } catch {
    return [];
  }
}

// Legacy 24h time-window dedup — fallback path when we can't resolve a player
// or the entity lookup fails. Same semantics as before the entity retrofit.
async function fallbackDedup(event: RawInjuryEvent): Promise<DedupResult> {
  try {
    const raw = await callTool('web', 'web_list_posts', {
      athlete_name: event.athlete_name,
      sport: event.sport,
    });
    const posts = parseListPostsResponse(raw);
    const now = Date.now();
    const recent = posts.find((post) => {
      if (!post.created_at) return false;
      if (post.athlete_name && post.athlete_name !== event.athlete_name) return false;
      if (post.sport && post.sport !== event.sport) return false;
      const age = now - new Date(post.created_at).getTime();
      return age >= 0 && age < FALLBACK_DEDUP_WINDOW_MS;
    });
    if (!recent) return { isDuplicate: false, decision: 'no_match' };
    return {
      isDuplicate: true,
      existingPostId: recent.post_id ?? recent.id,
      decision: 'fallback_24h',
    };
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
//   decide whether to let a new TRACKING post through (only when is_update is
//   set on the inbound event — ESPN-flagged status changes). Otherwise mark
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

  // Append the source report to the entity timeline, with no post linkage
  // unless we end up letting one through below.
  const updateKind = event.is_update ? 'TRACKING' : 'CORRECTION';
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

  // is_update from ESPN means "this is a status change" → allow a TRACKING post.
  if (event.is_update) {
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
 *    Status updates (event.is_update) are allowed through as TRACKING posts.
 *  • Fallback — 24h time-window dedup on (athlete_name, sport). Used when no
 *    resolved player is available (UFC, ambiguous match, MCP failure).
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
