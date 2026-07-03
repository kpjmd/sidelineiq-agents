import type { SportKey, RawInjuryEvent, SignificanceAssessment, InjuryPostContent } from '../types.js';
import { SPORT_SOURCES } from './sports/index.js';
import { classifyEvent } from '../agents/injury-intelligence/classifier.js';
import {
  processInjuryEvent,
  parseTeamTimeline,
  type InjuryThreadContext,
} from '../agents/injury-intelligence/agent.js';
import { resolveInjuryDate } from '../agents/injury-intelligence/date-resolution.js';
import { checkForExisting, type DedupResult } from './deduplicator.js';
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

// Frozen OTM projection captured at thread open. Mirrors the MCP web server's
// OtmProjection shape (persisted as JSONB on injury_entities.otm_projection).
interface OtmProjection {
  min_weeks: number;
  max_weeks: number;
  probability_week_2?: number;
  probability_week_4?: number;
  probability_week_8?: number;
  projected_return_date?: string | null;
  created_at?: string;
}

export function addWeeksIso(baseIso: string, weeks: number): string | null {
  // baseIso may arrive as 'YYYY-MM-DD' OR a full ISO timestamp — the DB DATE
  // column comes back through MCP JSON as 'YYYY-MM-DDT00:00:00.000Z'. new Date
  // parses both; slicing the result normalizes back to a plain date.
  const t = new Date(baseIso).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

// Build the projection to freeze on the thread once OTM has produced the post.
function buildOtmProjection(post: InjuryPostContent, injuryDate: string | null): OtmProjection {
  const rtp = post.return_to_play;
  const mid = (rtp.min_weeks + rtp.max_weeks) / 2;
  return {
    min_weeks: rtp.min_weeks,
    max_weeks: rtp.max_weeks,
    probability_week_2: rtp.probability_week_2,
    probability_week_4: rtp.probability_week_4,
    probability_week_8: rtp.probability_week_8,
    projected_return_date: injuryDate ? addWeeksIso(injuryDate, mid) : null,
    created_at: new Date().toISOString(),
  };
}

async function maintainEntity(
  event: RawInjuryEvent,
  player: ResolvedPlayerInfo,
  metadata: import('../agents/injury-intelligence/fact-validator.js').ExtractedInjuryMetadata,
  dedup: DedupResult,
  postId: string,
  teamTimelineWeeks: number | undefined,
  otmMinWeeks: number | undefined,
  severity: string,
  // When the Injury Thread Manager already created/matched the entity pre-OTM,
  // reuse its id (avoids a duplicate entity) and freeze the OTM projection.
  opts?: { entityId?: string; otmProjection?: OtmProjection },
): Promise<void> {
  if (!isServerAvailable('web')) return;
  try {
    let entityId = opts?.entityId ?? dedup.entityId;
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
    // Freeze the OTM projection on the thread (dates are left untouched via COALESCE).
    if (opts?.otmProjection) {
      await callTool('web', 'web_thread_update_dates', {
        entity_id: entityId,
        otm_projection: opts.otmProjection,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[EntityMaint] failed for post=${postId}: ${message}`);
  }
}

// ── Injury Thread Manager: pre-OTM date resolution + thread assembly ────
// Runs behind DATE_RESOLUTION_ENABLED, after fact-validation + dedup, before
// OTM. Resolves the injury/surgery date (with a web-search fallback), persists
// it to the thread, and assembles the InjuryThreadContext OTM consumes. Returns
// null (→ OTM runs thread-less, i.e. today's behavior) on any failure.
interface ThreadEntityRow {
  injury_date: string | null;
  injury_date_confidence: 'unknown' | 'possible' | 'probable' | 'confirmed';
  surgery_date: string | null;
  surgery_confirmed: boolean;
  status: 'ACTIVE' | 'RESOLVED' | 'RETIRED';
}
interface ThreadUpdateRow {
  team_timeline_weeks: number | null;
  otm_min_weeks: number | null;
  severity_at_time: string | null;
  created_at: string;
}

async function resolveThreadAndDates(
  event: RawInjuryEvent,
  validation: ValidationResult,
  dedup: DedupResult,
): Promise<{ entityId: string; thread: InjuryThreadContext } | null> {
  const player = validation.resolvedPlayer;
  if (!player) return null;
  const metadata = validation.metadata;
  try {
    // 1. Resolve-or-create the entity early (canonical_post_id attached later).
    let entityId = dedup.entityId;
    if (!entityId) {
      const createRes = await callTool('web', 'web_create_injury_entity', {
        player_id: player.player_id,
        body_part: metadata.primary_body_part ?? undefined,
        laterality: metadata.laterality,
        injury_type: metadata.injury_type_hint ?? undefined,
      });
      entityId = unwrapMCP<{ entity: { id: string } }>(createRes)?.entity?.id;
    }
    if (!entityId) return null;

    // 2. Resolve the injury/surgery date (Pass 1 source-only, Pass 2 web search).
    const resolution = await resolveInjuryDate({
      event,
      player,
      metadata,
      reportedAt: event.reported_at,
      today: new Date().toISOString().slice(0, 10),
    });

    // 3. Persist dates + provenance; flag for MD review when still unknown.
    await callTool('web', 'web_thread_update_dates', {
      entity_id: entityId,
      injury_date: resolution.injury_date ?? undefined,
      injury_date_confidence: resolution.injury_date_confidence,
      surgery_date: resolution.surgery_date ?? undefined,
      surgery_confirmed: resolution.surgery_confirmed,
      date_resolution_sources: resolution.sources,
      needs_date_review: resolution.injury_date_confidence === 'unknown',
    });

    const webSources = resolution.sources.filter((s) => s.stage === 'web_search').length;
    console.log(
      `[ThreadManager] ${event.athlete_name} (${event.sport}) — entity=${entityId} ` +
        `injury_date=${resolution.injury_date ?? 'none'} confidence=${resolution.injury_date_confidence} ` +
        `surgery=${resolution.surgery_confirmed ? (resolution.surgery_date ?? 'confirmed') : 'no'} ` +
        `web_search=${resolution.used_web_search} web_sources=${webSources} ` +
        `needs_date_review=${resolution.injury_date_confidence === 'unknown'}`,
    );

    // 4. Read the thread back (entity with dates + trajectory) and assemble context.
    const getRes = await callTool('web', 'web_thread_get', { entity_id: entityId });
    const thread = unwrapMCP<{ entity: ThreadEntityRow; updates: ThreadUpdateRow[] }>(getRes);

    const priorFromDb = (thread?.updates ?? [])
      .map((u) => ({
        reported_weeks: u.team_timeline_weeks ?? null,
        otm_min_weeks: u.otm_min_weeks ?? null,
        severity: u.severity_at_time ?? null,
        at: u.created_at,
      }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); // list is newest-first

    // Append the current event's reported timeline in-memory (the persisted row
    // is written post-publish by maintainEntity) so compression detection sees it.
    const currentReported = event.team_timeline
      ? parseTeamTimeline(event.team_timeline)
      : null;
    const priorTimelines = [
      ...priorFromDb,
      {
        reported_weeks: currentReported,
        otm_min_weeks: null,
        severity: null,
        at: event.reported_at.toISOString(),
      },
    ];

    const entity = thread?.entity;
    return {
      entityId,
      thread: {
        injury_date: entity?.injury_date ?? resolution.injury_date,
        injury_date_confidence: entity?.injury_date_confidence ?? resolution.injury_date_confidence,
        surgery_date: entity?.surgery_date ?? resolution.surgery_date,
        surgery_confirmed: entity?.surgery_confirmed ?? resolution.surgery_confirmed,
        status: entity?.status ?? 'ACTIVE',
        prior_timelines: priorTimelines,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ThreadManager] date resolution failed for ${event.athlete_name}: ${message}`);
    return null;
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
  // Pre-OTM date resolution is opt-in (default off) until validated in prod.
  const dateResolutionEnabled = process.env.DATE_RESOLUTION_ENABLED === 'true';

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

      // ── Injury Thread Manager: resolve dates + assemble thread (pre-OTM) ──
      // Behind DATE_RESOLUTION_ENABLED (default off). When disabled or on any
      // failure, `thread` stays undefined → OTM runs exactly as before.
      let thread: InjuryThreadContext | undefined;
      let threadEntityId: string | undefined;
      if (dateResolutionEnabled && isServerAvailable('web') && validation.resolvedPlayer) {
        const resolved = await resolveThreadAndDates(event, validation, dedup);
        if (resolved) {
          thread = resolved.thread;
          threadEntityId = resolved.entityId;
        }
      }

      const post = await processInjuryEvent(classified, dedup.existingPostId, thread);
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
      // update tied to the new post so the timeline reflects it. When the thread
      // was resolved pre-OTM, reuse its entity id and freeze the OTM projection.
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
          threadEntityId
            ? {
                entityId: threadEntityId,
                otmProjection: buildOtmProjection(post, thread?.injury_date ?? null),
              }
            : undefined,
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
