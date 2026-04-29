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

interface PollSummary {
  fetched: number;
  classified_positive: number;
  dropped_significance: number;
  deferred: number;
  promoted_from_defer: number;
  expired_from_defer: number;
  duplicates: number;
  published: number;
  pending_review: number;
  skipped: number;
  errors: number;
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
    dropped_significance: 0,
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

      const dedup = await checkForExisting(event);
      if (dedup.isDuplicate) {
        summary.duplicates++;
        console.log(`[Poller] ${sport} — duplicate skipped: ${context}`);
        continue;
      }

      const post = await processInjuryEvent(classified, dedup.existingPostId);
      if (!post) {
        summary.errors++;
        continue;
      }

      const result = await publishInjuryPost(post);
      if (result.status === 'published') summary.published++;
      else if (result.status === 'pending_review') summary.pending_review++;
      else summary.skipped++;
    } catch (err) {
      summary.errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Poller] ${sport} — event failed for ${context}: ${message}`);
    }
  }

  console.log(
    `[Poller] ${sport} — summary: fetched=${summary.fetched} classified+=${summary.classified_positive} dropped_sig=${summary.dropped_significance} deferred=${summary.deferred} promoted=${summary.promoted_from_defer} expired=${summary.expired_from_defer} dupes=${summary.duplicates} published=${summary.published} review=${summary.pending_review} skipped=${summary.skipped} errors=${summary.errors}`
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
