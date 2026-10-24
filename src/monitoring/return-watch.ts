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
import { refreshTierSnapshotsIfStale } from '../agents/injury-intelligence/tier-snapshots.js';

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

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function minDaysSincePublish(): number {
  return parseInt(process.env.RETURN_WATCH_MIN_DAYS_SINCE_PUBLISH ?? '14', 10) || 14;
}

// TRACKING's own bar. It is NOT PROMOTION_PROPOSE_THRESHOLD (55): that bar asks
// "is this worth a whole new post?", and 35 of its 100 points come from a
// team-vs-OTM conflict a Return Watch event can never have. Under it a tier-2
// athlete topped out at 53 and was never proposed at all — Ben Simmons, whose
// desk post the MD had already chosen to write. The MD's desk pick has answered
// "is this athlete worth covering"; this bar only filters weak signals. At 40,
// tier 1 and 2 always qualify with a T1/T2 source, tier 3 only with T1.
export const RETURN_WATCH_TRACKING_MIN_SCORE_DEFAULT = 40;
function trackingMinScore(): number {
  return envInt('RETURN_WATCH_TRACKING_MIN_SCORE', RETURN_WATCH_TRACKING_MIN_SCORE_DEFAULT);
}

// One window for both TRACKING guards: no proposal within this many days of the
// last Return Watch update on the post, or of the MD dismissing one for it.
// ESPN's injuries table is a status table re-read every POLL_INTERVAL_MS, so
// without these the same unchanged status could prompt the MD every six hours.
export const RETURN_WATCH_TRACKING_COOLDOWN_DAYS_DEFAULT = 14;
function trackingCooldownDays(): number {
  return envInt('RETURN_WATCH_TRACKING_COOLDOWN_DAYS', RETURN_WATCH_TRACKING_COOLDOWN_DAYS_DEFAULT);
}

// web_list_candidates has no entity/target filter; 500 is its max. A full page
// means we may not have seen every row, so the guard cannot answer.
const CANDIDATE_PAGE_LIMIT = 500;

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

interface DeskPostUpdateRow {
  created_at: string;
}

interface CandidateRow {
  status: string;
  candidate_kind: string;
  target_desk_post_id: string | null;
  decided_at: string | null;
}

type GuardResult = { blocked: false } | { blocked: true; reason: string };

function withinDays(iso: string | null | undefined, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && Date.now() - t < days * 86_400_000;
}

/**
 * The TRACKING-only guards, each a read. Any read that fails or cannot answer
 * BLOCKS: a proposal is only a prompt, so a missed one costs a nudge, while a
 * spurious one costs MD attention every cycle. RESOLUTION never calls this, so
 * a failed read can never swallow a return.
 */
async function trackingGuard(deskPostId: string): Promise<GuardResult> {
  const cooldown = trackingCooldownDays();

  const updates = unwrap<{ updates: DeskPostUpdateRow[] }>(
    await callTool('web', 'desk_list_updates', { desk_post_id: deskPostId }),
  )?.updates;
  if (!Array.isArray(updates)) return { blocked: true, reason: 'read_failed:desk_list_updates' };
  if (updates.some((u) => withinDays(u.created_at, cooldown))) {
    return { blocked: true, reason: `cooldown:update_within_${cooldown}d` };
  }

  // DISMISSED: the MD already said no recently. ACCEPTED: one is already waiting
  // in Return Watch pending — the upsert only dedupes against PROPOSED, so a new
  // proposal would sit beside it.
  for (const status of ['DISMISSED', 'ACCEPTED'] as const) {
    const rows = unwrap<{ candidates: CandidateRow[] }>(
      await callTool('web', 'web_list_candidates', { status, limit: CANDIDATE_PAGE_LIMIT }),
    )?.candidates;
    if (!Array.isArray(rows)) return { blocked: true, reason: `read_failed:web_list_candidates_${status}` };
    if (rows.length >= CANDIDATE_PAGE_LIMIT) return { blocked: true, reason: `truncated:web_list_candidates_${status}` };
    const mine = rows.filter(
      (c) => c.candidate_kind === 'RETURN_WATCH_UPDATE' && c.target_desk_post_id === deskPostId,
    );
    if (status === 'DISMISSED' && mine.some((c) => withinDays(c.decided_at, cooldown))) {
      return { blocked: true, reason: `dismissed_within_${cooldown}d` };
    }
    if (status === 'ACCEPTED' && mine.length > 0) {
      return { blocked: true, reason: 'accepted_pending' };
    }
  }
  return { blocked: false };
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

  const logPrefix = `[ReturnWatch] entity=${entityId} (${ctx.athleteName}) update_kind=${updateKind} target_post=${publishedPost.id}`;

  if (updateKind === 'TRACKING') {
    const guard = await trackingGuard(publishedPost.id);
    if (guard.blocked) {
      console.log(`${logPrefix} decision=skip reason=${guard.reason}`);
      return;
    }
  }

  const entity = unwrap<{ entity: EntityForStaleness | null }>(
    await callTool('web', 'web_get_entity', { entity_id: entityId }),
  )?.entity;
  if (!entity) return;

  await loadSignificanceData();
  await refreshTierSnapshotsIfStale();
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
  // The score is still computed for both kinds: it is what the MD sees on the
  // candidate. Only the bar differs, and computePromotionScore's own `proposed`
  // (the NEW_POST bar) is deliberately not consulted.
  const { score, reasons } = computePromotionScore(scoreInput);

  if (updateKind === 'RESOLUTION') {
    // First game back is the moment Return Watch exists for, and a thread
    // resolves once. No bar, no cooldown.
    reasons.push('resolution (always proposes)');
  } else {
    const bar = trackingMinScore();
    if (score < bar) {
      console.log(`${logPrefix} decision=skip reason=below_tracking_bar score=${score} bar=${bar}`);
      return;
    }
  }

  console.log(`${logPrefix} decision=propose score=${score}`);

  await callTool('web', 'web_propose_candidate', {
    entity_id: entityId,
    promotion_score: score,
    reasons,
    proposed_by: 'system',
    candidate_kind: 'RETURN_WATCH_UPDATE',
    target_desk_post_id: publishedPost.id,
  });
}
