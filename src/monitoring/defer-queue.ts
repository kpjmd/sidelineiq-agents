import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { readSocialState } from '../utils/social-state.js';
import type {
  SportKey,
  ClassificationResult,
  ContentType,
  AthleteTier,
  AthleteTierSource,
  SignificanceSubscores,
  SignificanceAssessment,
  RawInjuryEvent,
} from '../types.js';
import {
  computeSignificance,
  computeAthleteKey,
  computeCorroborationDiscount,
  computeFingerprint,
  type DeferConfig,
} from '../agents/injury-intelligence/significance.js';
import { extractInjuryMetadata } from '../agents/injury-intelligence/fact-validator.js';
import { sourceFamilies } from './source-family.js';

interface ClassificationSnapshot {
  content_type: ContentType;
  athlete_tier: AthleteTier;
  athlete_tier_source: AthleteTierSource;
  subscores: SignificanceSubscores;
  sport: SportKey;
}

interface DeferQueueEntry {
  /** Log identity only. Never the match key — see computeAthleteKey. */
  fingerprint: string;
  /** The match key: `${sport}|${normalized classifier athlete name}`. */
  athlete_key: string;
  /**
   * Primary body part at the time the entry was created, or null when the
   * report did not say. NOT part of the key: a tweet saying "placed on IR"
   * carries no part, and keying on it would make exactly the ESPN+tweet pair
   * this queue exists to notice unmatchable. Used as a null-tolerant guard so
   * an ankle row and a knee tweet do not corroborate each other.
   */
  body_part: string | null;
  /** Distinct source FAMILIES seen, in arrival order. See source-family.ts. */
  sources: string[];
  deferred_at: string;
  expires_at: string;
  sport: SportKey;
  athlete_name: string;
  classification: ClassificationSnapshot;
  /**
   * Every arrival, including same-family re-serves — a DIAGNOSTIC, not
   * evidence. This used to be the corroboration signal itself, which is why
   * ESPN re-serving one row every cycle read as three sources agreeing.
   * Still written under its original name so a code rollback finds a number.
   */
  source_count: number;
  promotion_count: number;
  last_seen_at?: string;
}

interface DeferQueueState {
  version: 1;
  entries: DeferQueueEntry[];
}

/**
 * Brings a stored entry up to the current shape.
 *
 * Entries written before corroboration was redesigned have no `athlete_key`,
 * no `sources` and no `body_part`, and they are live in production right now.
 * They must keep working, and — the part that matters — an entry with no
 * recorded families must be SEEDED by its next arrival, never corroborated by
 * it: we do not know which publisher filed it, so we cannot know whether the
 * next one is a second.
 */
export function normalizeEntry(raw: DeferQueueEntry, sport: SportKey): DeferQueueEntry {
  return {
    ...raw,
    athlete_key: raw.athlete_key ?? computeAthleteKey(raw.sport ?? sport, raw.athlete_name ?? ''),
    body_part: raw.body_part ?? null,
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    source_count: Number.isFinite(raw.source_count) ? raw.source_count : 1,
    promotion_count: Number.isFinite(raw.promotion_count) ? raw.promotion_count : 0,
  };
}

/**
 * off    — families are recorded, nothing is ever promoted. This is what the
 *          queue actually did before this change (zero promotions across every
 *          measured cycle), named honestly rather than kept as a "legacy" path.
 * shadow — decides and logs would-promote, returns deferred.
 * on     — promotes.
 */
export type DeferCorroborationMode = 'off' | 'shadow' | 'on';

export function getDeferCorroborationMode(): DeferCorroborationMode {
  const raw = process.env.DEFER_CORROBORATION_MODE?.trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'on') return raw;
  if (raw) {
    console.warn(
      `[DeferQueue] DEFER_CORROBORATION_MODE="${raw}" is not off|shadow|on — using 'on'.`,
    );
  }
  return 'on';
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
    return { entries: state.entries.map((e) => normalizeEntry(e, sport)), available: true };
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
        `[SignificanceGate] decision=EXPIRE fingerprint=${entry.fingerprint} athlete="${entry.athlete_name}" ` +
          `sport=${sport} deferred_for_h=${deferredForH} ` +
          `families=${entry.sources.length > 0 ? entry.sources.join(',') : 'none'} sightings=${entry.source_count}`
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
 * The outcome of handing a DEFER decision to the queue.
 *
 * A promotion returns the RE-SCORED assessment rather than just a verdict,
 * because the discount that bought the promotion has to travel with it: the
 * poller writes it back onto the classified event so the audit row, the
 * content-type drift check and the pipeline all read the same bar the gate
 * used. Returning a bare 'promoted' is what left the old code's re-score on
 * the floor, with everything downstream still reading the pre-promotion score.
 */
export type DeferOutcome =
  | { result: 'promoted'; significance: SignificanceAssessment; sources: string[] }
  | { result: 'deferred'; would_promote?: boolean };

/**
 * Two body parts are compatible when the sources do not actively disagree.
 *
 * Null on either side wildcards, which is the common case and the reason the
 * part is not in the key: ESPN's table always names a part and a tweet
 * usually does not.
 */
function partsCompatible(entryPart: string | null, arrivingPart: string | null): boolean {
  if (entryPart === null || arrivingPart === null) return true;
  return entryPart === arrivingPart;
}

/**
 * Handle a DEFER decision from the significance gate.
 *
 * Corroboration means a second PUBLISHER said the same thing about the same
 * athlete — not the same feed saying it again. Three things follow, and each
 * one was a live bug:
 *
 *  - Entries are keyed on the athlete, not on computeFingerprint. Two
 *    publishers never share a fingerprint, so the old key could only ever
 *    match ESPN to ESPN.
 *  - A promotion requires an arrival that ADDS a source family. Without that,
 *    an entry that had once collected two families would re-promote on every
 *    subsequent ESPN re-serve, up to promotion_cap — three Sonnet-bound passes
 *    for one story.
 *  - Promotion additionally requires two families outright, not merely a
 *    passing score. The re-decision happens on a later date than the deferral,
 *    and a season boundary moves every bar (Sept 1 moves NFL's by 5), so a
 *    single-source entry could otherwise promote on the calendar alone.
 *
 * Returns 'promoted' when the event should now PROCESS, 'deferred' otherwise.
 */
export async function handleDeferDecision(
  sport: SportKey,
  event: RawInjuryEvent,
  classified: ClassificationResult,
  config: DeferConfig,
  opts?: { now?: Date; mode?: DeferCorroborationMode },
): Promise<DeferOutcome> {
  if (!classified.significance) return { result: 'deferred' };

  const { entries, available } = await loadQueue(sport);
  // Never write a queue we could not read. saveQueue persists `entries` in
  // full, so appending to a wrongly-empty list overwrites everything already
  // stored — which is exactly what the envelope bug did on every single
  // deferral, leaving the live NFL queue holding one entry at a time.
  if (!available) return { result: 'deferred' };

  const mode = opts?.mode ?? getDeferCorroborationMode();
  const nowDate = opts?.now ?? new Date();
  const now = nowDate.getTime();

  const fingerprint = computeFingerprint(event);
  const athleteKey = computeAthleteKey(classified.sport, classified.athlete_name);
  const bodyPart = extractInjuryMetadata(event.injury_description, event.injury_details)
    .primary_body_part;
  const families = sourceFamilies(event);

  const existing = entries.find(
    (e) => e.athlete_key === athleteKey && partsCompatible(e.body_part, bodyPart),
  );

  /** Re-decide under the evidence now on the entry. */
  const rescore = (sources: string[]): SignificanceAssessment =>
    computeSignificance(
      classified.significance!.athlete_tier,
      classified.significance!.athlete_tier_source,
      {
        information_specificity: classified.significance!.subscores.information_specificity,
        event_recency_novelty: classified.significance!.subscores.event_recency_novelty,
      },
      classified.content_type,
      classified.sport,
      nowDate,
      {
        corroborationDiscount: computeCorroborationDiscount(sources.length, config),
        corroboratingSources: sources,
      },
    );

  const describe = (entry: DeferQueueEntry, rescored?: SignificanceAssessment): string =>
    `athlete="${classified.athlete_name}" sport=${sport} fingerprint=${fingerprint} ` +
    `families=${entry.sources.join(',')} sightings=${entry.source_count}` +
    (rescored
      ? ` score=${rescored.composite_score} bar=${rescored.process_threshold}` +
        ` discount=${rescored.corroboration_discount ?? 0}`
      : '');

  /**
   * Shared tail for both the new-entry and corroboration paths: an entry whose
   * family set just grew to two or more gets one re-decision.
   */
  const decide = async (entry: DeferQueueEntry): Promise<DeferOutcome> => {
    // Two families is the evidence bar, checked independently of the
    // arithmetic. See the header: a bar that moved for unrelated reasons must
    // not be able to promote a single-source event.
    if (entry.sources.length < 2) {
      await saveQueue(sport, entries);
      return { result: 'deferred' };
    }

    if (entry.promotion_count >= config.promotion_cap) {
      console.log(
        `[SignificanceGate] decision=DEFER_CAP ${describe(entry)} cap=${config.promotion_cap}`,
      );
      await saveQueue(sport, entries);
      return { result: 'deferred' };
    }

    const rescored = rescore(entry.sources);
    if (rescored.triage_decision !== 'PROCESS') {
      console.log(`[SignificanceGate] decision=CORROBORATE ${describe(entry, rescored)}`);
      await saveQueue(sport, entries);
      return { result: 'deferred' };
    }

    if (mode === 'shadow') {
      // Decides and says so, changes nothing. Counted as would_promote= in the
      // poll summary so the volume is measurable before it is acted on.
      console.log(`[SignificanceGate] decision=SHADOW_PROMOTE ${describe(entry, rescored)}`);
      await saveQueue(sport, entries);
      return { result: 'deferred', would_promote: true };
    }
    if (mode === 'off') {
      // Disabled outright: the family set is still recorded (so turning the
      // feature back on does not start from nothing) but nothing is claimed
      // and nothing is logged as a near-miss.
      await saveQueue(sport, entries);
      return { result: 'deferred' };
    }

    entry.promotion_count += 1;
    await saveQueue(sport, entries);
    console.log(`[SignificanceGate] decision=PROMOTE ${describe(entry, rescored)}`);
    return { result: 'promoted', significance: rescored, sources: [...entry.sources] };
  };

  if (!existing) {
    const entry: DeferQueueEntry = {
      fingerprint,
      athlete_key: athleteKey,
      body_part: bodyPart,
      sources: families,
      deferred_at: new Date(now).toISOString(),
      expires_at: new Date(now + config.ttl_hours * 3_600_000).toISOString(),
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
      last_seen_at: new Date(now).toISOString(),
    };
    entries.push(entry);
    // Two publishers can arrive in ONE cycle: MultiSource merges same-day
    // duplicates and hands the survivor its loser's family. That is
    // corroboration on first sight, so a new entry gets a decision too.
    return decide(entry);
  }

  existing.source_count += 1;
  existing.last_seen_at = new Date(now).toISOString();
  // A part is learned once and never overwritten — the first source to name one
  // is as good an answer as any, and letting later reports rewrite it would let
  // an entry drift onto a different injury.
  if (existing.body_part === null && bodyPart !== null) existing.body_part = bodyPart;

  const added = families.filter((f) => !existing.sources.includes(f));
  if (added.length === 0) {
    // The dominant case by far: ESPN re-serving the same status row. It is a
    // sighting, not a second opinion, and it must never move anything.
    console.log(
      `[SignificanceGate] decision=DEFER_SEEN ${describe(existing)} ` +
        `family=${families.length > 0 ? families.join(',') : 'unknown'}`,
    );
    await saveQueue(sport, entries);
    return { result: 'deferred' };
  }

  existing.sources.push(...added);
  return decide(existing);
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export type { DeferQueueEntry, DeferQueueState };
