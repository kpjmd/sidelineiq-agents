import type { SportKey, RawInjuryEvent, SignificanceAssessment } from '../types.js';
import { SPORT_SOURCES } from './sports/index.js';
import { classifyEvent } from '../agents/injury-intelligence/classifier.js';
import { processInjuryEvent } from '../agents/injury-intelligence/agent.js';
import { checkForExisting } from './deduplicator.js';
import { publishInjuryPost } from '../utils/publishing-pipeline.js';
import {
  loadSignificanceData,
  lookupAthleteTier,
  computeFingerprint,
  getDeferConfig,
} from '../agents/injury-intelligence/significance.js';
import { evictExpired, handleDeferDecision } from './defer-queue.js';
import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import {
  validateEvent,
  summarizeFailures,
  type ResolvedPlayerInfo,
  type ValidationResult,
} from '../agents/injury-intelligence/fact-validator.js';

const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

const SPORT_KEYS: SportKey[] = ['NFL', 'NBA', 'PREMIER_LEAGUE', 'UFC'];

const SPORT_ENV_FLAGS: Record<SportKey, string> = {
  NFL: 'POLL_NFL',
  NBA: 'POLL_NBA',
  PREMIER_LEAGUE: 'POLL_PREMIER_LEAGUE',
  UFC: 'POLL_UFC',
};

// Default to launch order: NFL active, others opt-in until stable
const SPORT_DEFAULTS: Record<SportKey, boolean> = {
  NFL: true,
  NBA: false,
  PREMIER_LEAGUE: false,
  UFC: false,
};

interface Timers {
  [sport: string]: NodeJS.Timeout | null;
}

const timers: Timers = {};
let stopped = false;

function getPollIntervalMs(): number {
  const raw = process.env.POLL_INTERVAL_MS;
  if (!raw) return DEFAULT_POLL_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_POLL_INTERVAL_MS;
}

function isSportEnabled(sport: SportKey): boolean {
  const envVar = SPORT_ENV_FLAGS[sport];
  const raw = process.env[envVar];
  if (raw === undefined) return SPORT_DEFAULTS[sport];
  return raw === 'true' || raw === '1';
}

// Events with clear injury signal — always pass to classifier regardless of other content.
const INJURY_ANCHOR_RE = /\b(injur|torn?|tear|sprain|fractur|concuss|sidelin|surger|strain|ruptur|acl|mcl|hamstring|achilles|tendon|ligament|hyperextension|disloc|contusion|laceration|bruise|bone|stress fracture)\b/i;

// Non-injury signals — drop the event only when no injury anchor is present.
const NON_INJURY_RE = /\b(load management|personal reasons?|personal leave|family (matter|emergency|reasons?)|contract (extension|signing|negotiation)|suspended|suspension|ejected|ejection|paternity leave|bereavement|rest day)\b/i;

function isObviousNonInjury(event: RawInjuryEvent): boolean {
  if (INJURY_ANCHOR_RE.test(event.injury_description)) return false;
  return NON_INJURY_RE.test(event.injury_description);
}

interface PollSummary {
  fetched: number;
  classified_positive: number;
  pre_filtered: number;
  dropped_significance: number;
  dropped_fact_validation: number;
  soft_failed_fact_validation: number;
  deferred: number;
  promoted_from_defer: number;
  expired_from_defer: number;
  duplicates: number;
  published: number;
  pending_review: number;
  skipped: number;
  errors: number;
}

interface ResolveResponse {
  resolved: boolean;
  player: ResolvedPlayerInfo | null;
}

interface MCPResultLike {
  content?: Array<{ text?: string }>;
}

function unwrapMCP<T>(res: unknown): T | null {
  try {
    const text = (res as MCPResultLike)?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function resolvePlayer(
  name: string,
  sport: SportKey,
): Promise<ResolvedPlayerInfo | null> {
  if (!isServerAvailable('web')) return null;
  try {
    const res = await callTool('web', 'web_resolve_player', { name, sport });
    const parsed = unwrapMCP<ResolveResponse>(res);
    return parsed?.resolved ? parsed.player : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[FactValidator] resolve_player failed for ${name}: ${message}`);
    return null;
  }
}

async function maintainEntity(
  event: RawInjuryEvent,
  player: ResolvedPlayerInfo,
  metadata: import('../agents/injury-intelligence/fact-validator.js').ExtractedInjuryMetadata,
  dedup: import('./deduplicator.js').DedupResult,
  postId: string,
  teamTimelineWeeks: number | undefined,
  otmMinWeeks: number | undefined,
  severity: string,
): Promise<void> {
  if (!isServerAvailable('web')) return;
  try {
    let entityId = dedup.entityId;
    if (!entityId) {
      const createRes = await callTool('web', 'web_create_injury_entity', {
        player_id: player.player_id,
        body_part: metadata.primary_body_part ?? undefined,
        laterality: metadata.laterality,
        injury_type: metadata.injury_type_hint ?? undefined,
        canonical_post_id: postId,
      });
      const parsed = unwrapMCP<{ entity: { id: string } }>(createRes);
      entityId = parsed?.entity?.id;
    }
    if (!entityId) return;
    const updateKind =
      dedup.decision === 'entity_match_pass_through' ? 'TRACKING' : 'INITIAL';
    await callTool('web', 'web_append_injury_update', {
      entity_id: entityId,
      post_id: postId,
      update_kind: updateKind,
      severity_at_time: severity,
      team_timeline_weeks: teamTimelineWeeks,
      otm_min_weeks: otmMinWeeks,
      source_url: event.source_url,
      description: event.injury_description.slice(0, 500),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[EntityMaint] failed for post=${postId}: ${message}`);
  }
}

async function auditValidation(
  event: RawInjuryEvent,
  result: ValidationResult,
  action: 'fact_validate_drop' | 'fact_validate_soft_fail' | 'fact_validate_pass',
): Promise<void> {
  if (!isServerAvailable('web')) return;
  try {
    await callTool('web', 'web_audit_append', {
      actor: 'system',
      actor_id: 'fact-validator',
      entity_type: 'injury_event',
      action,
      payload: {
        athlete_name: event.athlete_name,
        sport: event.sport,
        team_reported: event.team,
        source_url: event.source_url,
        hard_failures: result.hardFailures,
        soft_failures: result.softFailures,
        corrections: result.corrections,
        resolved_player_id: result.resolvedPlayer?.player_id ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[FactValidator] audit append failed: ${message}`);
  }
}

function logGateDecision(sport: SportKey, athleteName: string, sig: SignificanceAssessment): void {
  const { triage_decision, composite_score, raw_score, sport_multiplier, athlete_tier, athlete_tier_source, subscores } = sig;
  console.log(
    `[SignificanceGate] decision=${triage_decision} score=${composite_score} raw=${raw_score} mult=${sport_multiplier.toFixed(2)} athlete="${athleteName}" tier=${athlete_tier}${athlete_tier_source === 'default' ? '?' : ''} sport=${sport} ct_prior=${subscores.content_type_prior} prom=${subscores.athlete_prominence} spec=${subscores.information_specificity} rec=${subscores.event_recency_novelty}`
  );
}

export async function pollSport(sport: SportKey): Promise<PollSummary> {
  const summary: PollSummary = {
    fetched: 0,
    classified_positive: 0,
    pre_filtered: 0,
    dropped_significance: 0,
    dropped_fact_validation: 0,
    soft_failed_fact_validation: 0,
    deferred: 0,
    promoted_from_defer: 0,
    expired_from_defer: 0,
    duplicates: 0,
    published: 0,
    pending_review: 0,
    skipped: 0,
    errors: 0,
  };

  const gateEnabled = process.env.SIGNIFICANCE_GATE_ENABLED !== 'false';

  // Refresh significance data (athlete tiers + config) at the start of every cycle
  await loadSignificanceData();

  if (!gateEnabled) {
    console.warn(
      `[SignificanceGate] ${sport} — gate BYPASSED (SIGNIFICANCE_GATE_ENABLED=false); all classified events will reach Sonnet`
    );
  }

  // Evict TTL-expired defer queue entries for this sport
  try {
    const { evicted } = await evictExpired(sport);
    summary.expired_from_defer = evicted;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[SignificanceGate] ${sport} — defer eviction failed: ${message}`);
  }

  const source = SPORT_SOURCES[sport];
  if (!source) {
    console.warn(`[Poller] No source registered for ${sport}`);
    return summary;
  }

  console.log(`[Poller] ${sport} — fetching from ${source.name}`);
  let events: RawInjuryEvent[] = [];
  try {
    events = await source.fetchLatestEvents();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Poller] ${sport} — source fetch failed: ${message}`);
    return summary;
  }

  summary.fetched = events.length;
  console.log(`[Poller] ${sport} — ${events.length} raw events to process`);

  const deferConfig = getDeferConfig();

  // Sequential to avoid races on dedup lookups for the same athlete
  for (const event of events) {
    const context = `${event.athlete_name} (${sport}/${event.team})`;
    try {
      if (isObviousNonInjury(event)) {
        summary.pre_filtered++;
        continue;
      }

      // Resolve athlete tier before classifying — Haiku must not infer prominence
      const tierInfo = lookupAthleteTier(event.athlete_name, event.sport);

      const classified = await classifyEvent(event, {
        athleteTier: tierInfo.tier,
        athleteTierSource: tierInfo.source,
      });

      if (!classified.is_injury_event) {
        summary.skipped++;
        continue;
      }
      summary.classified_positive++;

      // ── Significance gate ────────────────────────────────────────────────
      const sig = classified.significance!;
      logGateDecision(sport, classified.athlete_name, sig);

      if (gateEnabled) {
        if (sig.triage_decision === 'DROP') {
          summary.dropped_significance++;
          continue;
        }

        if (sig.triage_decision === 'DEFER') {
          const fingerprint = computeFingerprint(event);
          let deferResult: 'promoted' | 'deferred' = 'deferred';
          try {
            deferResult = await handleDeferDecision(sport, fingerprint, classified, deferConfig);
          } catch (deferErr) {
            const message = deferErr instanceof Error ? deferErr.message : String(deferErr);
            console.warn(`[SignificanceGate] ${sport} — defer queue op failed for ${context}: ${message}`);
            // On failure, treat as deferred (conservative — event skips this cycle)
          }

          if (deferResult === 'promoted') {
            summary.promoted_from_defer++;
            // Fall through to dedup + agent processing below
          } else {
            summary.deferred++;
            continue;
          }
        }
        // triage_decision === 'PROCESS' or promoted from defer → fall through
      }
      // ── End significance gate ────────────────────────────────────────────

      // ── Fact validation ──────────────────────────────────────────────
      // Runs BEFORE Sonnet so hard failures don't burn agent tokens.
      // Hard fail → drop the event. Soft fail → route post to MD review.
      const resolved = await resolvePlayer(event.athlete_name, sport);
      const validation = await validateEvent(event, resolved, {
        contentTypeHint: classified.content_type,
      });

      let forceMDReviewReason: string | undefined;
      if (!validation.passed) {
        const codes = summarizeFailures(validation.hardFailures);
        console.warn(
          `[FactValidator] ${sport} DROP — ${context} — codes=${codes}`,
        );
        summary.dropped_fact_validation++;
        await auditValidation(event, validation, 'fact_validate_drop');
        continue;
      }
      if (validation.softFailures.length > 0) {
        const codes = summarizeFailures(validation.softFailures);
        forceMDReviewReason = `fact_soft_fail:${codes}`;
        summary.soft_failed_fact_validation++;
        console.log(
          `[FactValidator] ${sport} SOFT — ${context} — codes=${codes} (routing to MD review)`,
        );
        await auditValidation(event, validation, 'fact_validate_soft_fail');
      } else {
        await auditValidation(event, validation, 'fact_validate_pass');
      }
      // ── End fact validation ─────────────────────────────────────────

      const dedup = await checkForExisting(event, {
        resolvedPlayer: validation.resolvedPlayer,
        metadata: validation.metadata,
      });
      if (dedup.isDuplicate) {
        summary.duplicates++;
        console.log(
          `[Poller] ${sport} — duplicate skipped: ${context} (decision=${dedup.decision})`,
        );
        continue;
      }

      const post = await processInjuryEvent(classified, dedup.existingPostId);
      if (!post) {
        summary.errors++;
        continue;
      }

      const result = await publishInjuryPost(
        post,
        forceMDReviewReason ? { forceMDReviewReason } : {},
      );
      if (result.status === 'published') summary.published++;
      else if (result.status === 'pending_review') summary.pending_review++;
      else summary.skipped++;

      // ── Entity bookkeeping (after the post lands) ────────────────────
      // On entity miss → create the entity + INITIAL update linked to the post.
      // On entity match (status-update pass-through) → append a TRACKING
      // update tied to the new post so the timeline reflects it.
      if (result.post_id && validation.resolvedPlayer) {
        await maintainEntity(
          event,
          validation.resolvedPlayer,
          validation.metadata,
          dedup,
          result.post_id,
          post.team_timeline_weeks,
          post.return_to_play.min_weeks,
          post.injury_severity,
        );
      }
    } catch (err) {
      summary.errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Poller] ${sport} — event failed for ${context}: ${message}`);
    }
  }

  console.log(
    `[Poller] ${sport} — summary: fetched=${summary.fetched} pre_filtered=${summary.pre_filtered} classified+=${summary.classified_positive} dropped_sig=${summary.dropped_significance} dropped_fact=${summary.dropped_fact_validation} soft_fact=${summary.soft_failed_fact_validation} deferred=${summary.deferred} promoted=${summary.promoted_from_defer} expired=${summary.expired_from_defer} dupes=${summary.duplicates} published=${summary.published} review=${summary.pending_review} skipped=${summary.skipped} errors=${summary.errors}`
  );
  return summary;
}

function scheduleNext(sport: SportKey, intervalMs: number): void {
  if (stopped) return;
  timers[sport] = setTimeout(() => {
    void runAndReschedule(sport, intervalMs);
  }, intervalMs);
}

async function runAndReschedule(sport: SportKey, intervalMs: number): Promise<void> {
  try {
    await pollSport(sport);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Poller] ${sport} — poll cycle crashed: ${message}`);
  } finally {
    scheduleNext(sport, intervalMs);
  }
}

/**
 * Starts the autonomous polling loop for all enabled sports.
 * Each sport runs on its own timer so a slow sport does not delay others.
 * Uses setTimeout chaining (not setInterval) so runs never overlap.
 */
export function startPolling(): void {
  if (process.env.POLLING_ENABLED === 'false') {
    console.log('[Poller] POLLING_ENABLED=false — skipping startup');
    return;
  }

  stopped = false;
  const intervalMs = getPollIntervalMs();
  const enabled = SPORT_KEYS.filter(isSportEnabled);

  if (enabled.length === 0) {
    console.log('[Poller] No sports enabled — polling idle');
    return;
  }

  console.log(
    `[Poller] Starting — interval=${intervalMs}ms sports=${enabled.join(',')}`
  );

  for (const sport of enabled) {
    // Fire each sport immediately on startup, then chain via scheduleNext
    void runAndReschedule(sport, intervalMs);
  }
}

/**
 * Stops all polling timers. Safe to call multiple times.
 */
export function stopPolling(): void {
  stopped = true;
  for (const sport of Object.keys(timers) as SportKey[]) {
    const timer = timers[sport];
    if (timer) {
      clearTimeout(timer);
      timers[sport] = null;
    }
  }
  console.log('[Poller] Stopped');
}
