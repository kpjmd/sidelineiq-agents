import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { readSocialState } from '../utils/social-state.js';
import type {
  SportKey,
  ClassificationResult,
  ContentType,
  AthleteTier,
  AthleteTierSource,
  SignificanceSubscores,
} from '../types.js';
import {
  computeSignificance,
  decideTriage,
  type DeferConfig,
} from '../agents/injury-intelligence/significance.js';

interface ClassificationSnapshot {
  content_type: ContentType;
  athlete_tier: AthleteTier;
  athlete_tier_source: AthleteTierSource;
  subscores: SignificanceSubscores;
  sport: SportKey;
}

interface DeferQueueEntry {
  fingerprint: string;
  deferred_at: string;
  expires_at: string;
  sport: SportKey;
  athlete_name: string;
  classification: ClassificationSnapshot;
  source_count: number;
  promotion_count: number;
}

interface DeferQueueState {
  version: 1;
  entries: DeferQueueEntry[];
}

function stateKey(sport: SportKey): string {
  return `defer_queue_v1:${sport}`;
}

/**
 * An empty return from loadQueue is ambiguous: the queue really is empty, or
 * the state store is unreachable and every DEFER will look brand new forever
 * (nothing ever corroborates, nothing ever promotes, nothing ever expires).
 * Callers can't tell those apart from the entry list alone, so say which it was.
 */
type QueueLoad = { entries: DeferQueueEntry[]; available: boolean };

async function loadQueue(sport: SportKey): Promise<QueueLoad> {
  if (!isServerAvailable('web')) {
    console.warn(
      `[DeferQueue] ${sport} — web MCP unavailable; treating queue as empty. ` +
        'Corroboration and TTL expiry are inactive this cycle.',
    );
    return { entries: [], available: false };
  }
  try {
    const raw = await callTool('web', 'web_get_social_state', { key: stateKey(sport) });
    // web_get_social_state returns a {key, value} ENVELOPE, not the stored
    // string. Reading `.entries` off the envelope — which is what this did until
    // 2026-08-22 — always found undefined and degraded to an empty queue.
    const read = readSocialState(raw);
    if (read.status === 'unreadable') {
      console.warn(
        `[DeferQueue] ${sport} — state unreadable (${read.reason}); ` +
          'corroboration and TTL expiry are inactive this cycle and nothing will be written.',
      );
      return { entries: [], available: false };
    }
    if (read.status === 'absent') return { entries: [], available: true };

    const state = JSON.parse(read.value) as DeferQueueState;
    if (!Array.isArray(state.entries)) {
      // A stored blob we cannot read must not read as "queue empty" — that is
      // how the envelope bug stayed invisible for weeks. Say unavailable so the
      // summary shows defer_q=-1 and the save path stands down.
      console.warn(
        `[DeferQueue] ${sport} — stored state has no entries array; refusing to treat as empty.`,
      );
      return { entries: [], available: false };
    }
    return { entries: state.entries, available: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[DeferQueue] ${sport} — failed to load queue: ${message}`);
    return { entries: [], available: false };
  }
}

async function saveQueue(sport: SportKey, entries: DeferQueueEntry[]): Promise<void> {
  if (!isServerAvailable('web')) return;
  const state: DeferQueueState = { version: 1, entries };
  try {
    await callTool('web', 'web_set_social_state', {
      key: stateKey(sport),
      value: JSON.stringify(state),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DeferQueue] ${sport} — failed to save queue: ${message}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface EvictResult {
  evicted: number;
  /** Entries still live after eviction — surfaced so a queue that only ever
   *  grows, or one stuck at zero because the store is down, is visible. */
  size: number;
  /** False when the state store could not be read this cycle. */
  available: boolean;
}

/**
 * Drop TTL-expired entries from the defer queue for a sport.
 * Called at the start of each poll cycle.
 */
export async function evictExpired(sport: SportKey): Promise<EvictResult> {
  const { entries, available } = await loadQueue(sport);
  if (entries.length === 0) return { evicted: 0, size: 0, available };

  const now = Date.now();
  const live: DeferQueueEntry[] = [];
  let evicted = 0;

  for (const entry of entries) {
    if (now > new Date(entry.expires_at).getTime()) {
      const deferredForMs = now - new Date(entry.deferred_at).getTime();
      const deferredForH = (deferredForMs / 3_600_000).toFixed(1);
      console.log(
        `[SignificanceGate] decision=EXPIRE fingerprint=${entry.fingerprint} athlete="${entry.athlete_name}" sport=${sport} deferred_for_h=${deferredForH}`
      );
      evicted++;
    } else {
      live.push(entry);
    }
  }

  if (evicted > 0) await saveQueue(sport, live);
  return { evicted, size: live.length, available };
}

/**
 * Handle the DEFER branch for an event.
 *
 * - If the fingerprint is already in the queue (corroboration):
 *   applies a bonus to event_recency_novelty, re-scores, and may promote.
 * - If not in queue: adds a new entry.
 *
 * Returns 'promoted' if the event should now PROCESS, 'deferred' otherwise.
 */
export async function handleDeferDecision(
  sport: SportKey,
  fingerprint: string,
  classified: ClassificationResult,
  config: DeferConfig
): Promise<'promoted' | 'deferred'> {
  if (!classified.significance) return 'deferred';

  const { entries, available } = await loadQueue(sport);
  // Never write a queue we could not read. saveQueue persists `entries` in
  // full, so appending to a wrongly-empty list overwrites everything already
  // stored — which is exactly what the envelope bug did on every single
  // deferral, leaving the live NFL queue holding one entry at a time.
  if (!available) return 'deferred';

  const now = Date.now();
  const existingIdx = entries.findIndex((e) => e.fingerprint === fingerprint);

  if (existingIdx >= 0) {
    const existing = entries[existingIdx];

    // Respect promotion cap
    if (existing.promotion_count >= config.promotion_cap) {
      console.log(
        `[SignificanceGate] decision=DEFER_CAP fingerprint=${fingerprint} athlete="${classified.athlete_name}" sport=${sport} cap=${config.promotion_cap}`
      );
      return 'deferred';
    }

    // Apply corroboration bonus to recency signal and re-score
    const newSourceCount = existing.source_count + 1;
    const bonus = Math.min(
      config.corroboration_bonus_max,
      newSourceCount * config.corroboration_bonus_per_source
    );
    const adjustedRecency = Math.min(
      100,
      classified.significance.subscores.event_recency_novelty + bonus
    );

    const reScored = computeSignificance(
      classified.significance.athlete_tier,
      classified.significance.athlete_tier_source,
      {
        information_specificity: classified.significance.subscores.information_specificity,
        event_recency_novelty: adjustedRecency,
      },
      classified.content_type,
      classified.sport,
      new Date()
    );

    // computeSignificance already applied the season threshold delta, so reuse its
    // decision. Re-deriving it with a bare decideTriage() call would silently drop
    // the delta and make promotion easier than the gate that deferred this event.
    const newDecision = reScored.triage_decision;

    // Update entry
    existing.source_count = newSourceCount;
    if (newDecision === 'PROCESS') {
      existing.promotion_count += 1;
      await saveQueue(sport, entries);
      console.log(
        `[SignificanceGate] decision=PROMOTE fingerprint=${fingerprint} athlete="${classified.athlete_name}" sport=${sport} from_score=${classified.significance.composite_score} to_score=${reScored.composite_score} sources=${newSourceCount}`
      );
      return 'promoted';
    }

    await saveQueue(sport, entries);
    return 'deferred';
  }

  // New entry
  const ttlMs = config.ttl_hours * 3_600_000;
  const deferredAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();

  const newEntry: DeferQueueEntry = {
    fingerprint,
    deferred_at: deferredAt,
    expires_at: expiresAt,
    sport,
    athlete_name: classified.athlete_name,
    classification: {
      content_type: classified.content_type,
      athlete_tier: classified.significance.athlete_tier,
      athlete_tier_source: classified.significance.athlete_tier_source,
      subscores: classified.significance.subscores,
      sport: classified.sport,
    },
    source_count: 1,
    promotion_count: 0,
  };

  entries.push(newEntry);
  await saveQueue(sport, entries);
  return 'deferred';
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export type { DeferQueueEntry, DeferQueueState };
