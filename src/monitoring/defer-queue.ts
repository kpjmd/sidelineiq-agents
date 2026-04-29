import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import type {
  SportKey,
  ClassificationResult,
  ContentType,
  AthleteTier,
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
  athlete_tier_source: 'lookup' | 'default';
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

function parseMCPText(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const wrapped = raw as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (wrapped.isError) return null;
  return wrapped.content?.[0]?.text ?? null;
}

async function loadQueue(sport: SportKey): Promise<DeferQueueEntry[]> {
  if (!isServerAvailable('web')) return [];
  try {
    const raw = await callTool('web', 'web_get_social_state', { key: stateKey(sport) });
    const text = parseMCPText(raw);
    if (!text) return [];
    const state = JSON.parse(text) as DeferQueueState;
    return Array.isArray(state.entries) ? state.entries : [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[DeferQueue] ${sport} — failed to load queue: ${message}`);
    return [];
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
}

/**
 * Drop TTL-expired entries from the defer queue for a sport.
 * Called at the start of each poll cycle.
 */
export async function evictExpired(sport: SportKey): Promise<EvictResult> {
  const entries = await loadQueue(sport);
  if (entries.length === 0) return { evicted: 0 };

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
  return { evicted };
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

  const entries = await loadQueue(sport);
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

    const newDecision = decideTriage(reScored.composite_score, classified.content_type, classified.significance.athlete_tier);

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
