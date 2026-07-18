// Return Watch — detects when an entity that already has a PUBLISHED Injury
// Desk post gets new activity worth a "Day 298: first game back"-style dated
// follow-up, and proposes it as a RETURN_WATCH_UPDATE desk_candidate for the
// MD to triage (same queue as the original NEW_POST promotion path).
//
// Called from the two places injury_updates already gets appended
// (deduplicator.ts's entityAwareDedup, poller.ts's maintainEntity) — both
// already have everything this needs, so there's no separate polling loop.
// Failure here must never break ingestion: every call site wraps this in the
// same console.warn-and-continue pattern as the web_append_injury_update
// call it follows.

import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import {
  computePromotionScore,
  prominenceForTier,
  lookupAthleteTier,
  loadSignificanceData,
} from '../agents/injury-intelligence/significance.js';
import { resolveSourceTier } from '../agents/injury-intelligence/fact-validator.js';
import type { SportKey, PromotionScoreInput } from '../types.js';

export type InjuryUpdateKind =
  | 'INITIAL'
  | 'TRACKING'
  | 'CONFLICT'
  | 'DEEP_DIVE'
  | 'CORRECTION'
  | 'RESOLUTION';

export interface ReturnWatchContext {
  athleteName: string;
  sport: SportKey;
  sourceUrl?: string | null;
}

interface MCPTextResponse {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function unwrap<T>(raw: unknown): T | null {
  const wrapped = raw as MCPTextResponse;
  if (!wrapped || wrapped.isError) return null;
  const text = wrapped.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface PublishedDeskPost {
  id: string;
  published_at: string | null;
}

interface EntityForStaleness {
  last_updated_at: string;
}

function minDaysSincePublish(): number {
  return parseInt(process.env.RETURN_WATCH_MIN_DAYS_SINCE_PUBLISH ?? '14', 10) || 14;
}

// Only a real status change or a return-to-play resolution is worth
// interrupting the MD's queue for — routine chatter (CONFLICT, CORRECTION,
// INITIAL, DEEP_DIVE) is excluded. Both call sites already gate TRACKING on
// a real status-change signal before reaching here (deduplicator.ts only
// emits TRACKING when event.is_update is set; poller.ts's maintainEntity
// only emits TRACKING via the same pass-through path), so no extra flag is
// needed here.
function isReturnWatchWorthy(updateKind: InjuryUpdateKind): boolean {
  return updateKind === 'RESOLUTION' || updateKind === 'TRACKING';
}

export async function maybeProposeReturnWatch(
  entityId: string,
  updateKind: InjuryUpdateKind,
  ctx: ReturnWatchContext,
): Promise<void> {
  if (!isReturnWatchWorthy(updateKind)) return;
  if (!isServerAvailable('web')) return;

  const publishedPost = unwrap<{ post: PublishedDeskPost | null }>(
    await callTool('web', 'web_get_published_desk_post_for_entity', { entity_id: entityId }),
  )?.post;
  if (!publishedPost || !publishedPost.published_at) return;

  const daysSincePublish = Math.floor(
    (Date.now() - new Date(publishedPost.published_at).getTime()) / 86_400_000,
  );
  if (daysSincePublish < minDaysSincePublish()) return;

  const entity = unwrap<{ entity: EntityForStaleness | null }>(
    await callTool('web', 'web_get_entity', { entity_id: entityId }),
  )?.entity;
  if (!entity) return;

  await loadSignificanceData();
  const { tier } = lookupAthleteTier(ctx.athleteName, ctx.sport);
  const stalenessDays = Math.max(
    0,
    Math.round((Date.now() - new Date(entity.last_updated_at).getTime()) / 86_400_000),
  );

  const scoreInput: PromotionScoreInput = {
    composite: prominenceForTier(tier),
    // A return event has no team-vs-OTM conflict concept.
    conflict_flag_present: false,
    conflict_gap_weeks: null,
    entity_staleness_days: stalenessDays,
    corroboration_tier: await resolveSourceTier(ctx.sourceUrl),
  };
  const { score, proposed, reasons } = computePromotionScore(scoreInput);
  if (!proposed) return;

  console.log(
    `[ReturnWatch] entity=${entityId} (${ctx.athleteName}) update_kind=${updateKind} → score=${score}, target_post=${publishedPost.id}`,
  );

  await callTool('web', 'web_propose_candidate', {
    entity_id: entityId,
    promotion_score: score,
    reasons,
    proposed_by: 'system',
    candidate_kind: 'RETURN_WATCH_UPDATE',
    target_desk_post_id: publishedPost.id,
  });
}
