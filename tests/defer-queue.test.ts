import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock MCP client manager before importing defer-queue
vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import {
  evictExpired,
  handleDeferDecision,
  normalizeEntry,
  type DeferQueueEntry,
} from '../src/monitoring/defer-queue.js';
import {
  _setConfigForTesting,
  _setTiersForTesting,
  computeAthleteKey,
  computeFingerprint,
} from '../src/agents/injury-intelligence/significance.js';
import type { ClassificationResult, RawInjuryEvent } from '../src/types.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

// ── Test helpers ─────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  version: 1 as const,
  thresholds: {
    default:       { process: 55, defer: 35 },
    BREAKING_T1:   { process: 45, defer: 30 },
    TRACKING:      { process: 70, defer: 35, require_tier_1_or_2: true },
    DEEP_DIVE:     { process: 40, defer: 25 },
    CONFLICT_FLAG: { always_process: true },
  },
  sport_seasons: {
    NBA: [
      { window: 'playoffs', from: '04-15', to: '06-30', threshold_delta: -5 },
    ],
  },
  default_threshold_delta: 0,
  defer: {
    ttl_hours: 48,
    promotion_cap: 3,
    corroboration_discount_per_source: 10,
    corroboration_discount_max: 20,
  },
};

const DEFER_CONFIG = TEST_CONFIG.defer;

function makeClassified(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    is_injury_event: true,
    confidence: 0.9,
    sport: 'NBA',
    athlete_name: 'Moses Moody',
    team: 'Warriors',
    injury_description: 'patellar tendon rupture',
    content_type: 'BREAKING',
    is_new: true,
    raw_event: {
      athlete_name: 'Moses Moody',
      sport: 'NBA',
      team: 'Warriors',
      injury_description: 'patellar tendon rupture',
      source_url: 'https://example.com',
      reported_at: new Date('2026-04-29'),
    },
    significance: {
      raw_score: 40,
      season_window: 'none',
      season_threshold_delta: 0,
      composite_score: 40,
      triage_decision: 'DEFER',
      athlete_tier: 2,
      athlete_tier_source: 'lookup',
      subscores: {
        athlete_prominence: 70,
        information_specificity: 30,
        event_recency_novelty: 15,
        content_type_prior: 75,
      },
      rationale: 'DEFER score=40',
    },
    ...overrides,
  };
}

/**
 * A web_get_social_state response, in the shape the LIVE server actually
 * returns: a {key, value} ENVELOPE as the MCP text, with value:null when the
 * key was never written. Recorded in tests/fixtures/social-state-responses.json.
 *
 * This helper used to hand the BARE state string back as the MCP text. Every
 * test in this file passed against a loadQueue that never unwrapped the
 * envelope, because the fixture shared the code's blind spot — the third time
 * that exact failure has bitten this repo.
 */
function mcpStateResponse(value: string | null) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ key: 'defer_queue_v1:NBA', value }) }],
  };
}

function serializeQueue(entries: object[]) {
  return JSON.stringify({ version: 1, entries });
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _setConfigForTesting(TEST_CONFIG as Parameters<typeof _setConfigForTesting>[0]);
  _setTiersForTesting(null); // tiers not needed for defer-queue tests
  mockIsServerAvailable.mockReturnValue(true);
});

// ── evictExpired ─────────────────────────────────────────────────────────────

describe('evictExpired', () => {
  it('returns 0 when queue is empty', async () => {
    mockCallTool.mockResolvedValue(mcpStateResponse(null));
    const result = await evictExpired('NBA');
    expect(result.evicted).toBe(0);
  });

  it('drops expired entries and keeps live ones', async () => {
    const now = Date.now();
    const entries = [
      {
        fingerprint: 'expired:entry',
        deferred_at: new Date(now - 7 * 3_600_000).toISOString(),
        expires_at:  new Date(now - 3_600_000).toISOString(), // 1h ago
        sport: 'NBA',
        athlete_name: 'Old Player',
        classification: { content_type: 'TRACKING', athlete_tier: 3, athlete_tier_source: 'default', subscores: { athlete_prominence: 40, information_specificity: 20, event_recency_novelty: 10, content_type_prior: 30 }, sport: 'NBA' },
        source_count: 1,
        promotion_count: 0,
      },
      {
        fingerprint: 'live:entry',
        deferred_at: new Date(now - 3_600_000).toISOString(),
        expires_at:  new Date(now + 5 * 3_600_000).toISOString(), // 5h from now
        sport: 'NBA',
        athlete_name: 'Live Player',
        classification: { content_type: 'BREAKING', athlete_tier: 2, athlete_tier_source: 'lookup', subscores: { athlete_prominence: 70, information_specificity: 40, event_recency_novelty: 30, content_type_prior: 75 }, sport: 'NBA' },
        source_count: 1,
        promotion_count: 0,
      },
    ];

    // First call: load, Second call: save (after eviction)
    mockCallTool
      .mockResolvedValueOnce(mcpStateResponse(serializeQueue(entries)))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });

    const result = await evictExpired('NBA');
    expect(result.evicted).toBe(1);

    // Verify save was called with only the live entry
    const saveCall = mockCallTool.mock.calls[1];
    expect(saveCall[1]).toBe('web_set_social_state');
    const saved = JSON.parse(saveCall[2].value as string);
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0].fingerprint).toBe('live:entry');
  });

  it('gracefully returns 0 when MCP is unavailable', async () => {
    mockIsServerAvailable.mockReturnValue(false);
    const result = await evictExpired('NBA');
    expect(result.evicted).toBe(0);
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});


// ── handleDeferDecision ───────────────────────────────────────────────────────
//
// The behaviour under test changed shape, so read these as a pair with the old
// suite: corroboration used to mean "this fingerprint arrived again", and now
// means "a second PUBLISHER said it". Tests marked FAILS-ON-OLD promoted (or
// refused to promote) the opposite way before the redesign; the ones marked
// FAIL-CLOSED pass in both directions and exist to pin the safe default.

/** An event as a source hands it to the poller. */
function makeEvent(overrides: Partial<RawInjuryEvent> = {}): RawInjuryEvent {
  return {
    athlete_name: 'Moses Moody',
    sport: 'NBA',
    team: 'Warriors',
    injury_description: 'sprained ankle',
    source_url: 'https://www.espn.com/nba/injuries',
    reported_at: new Date('2026-09-01'),
    source_name: 'espn-nba',
    ...overrides,
  };
}

/**
 * Subscores that land the composite exactly 2 points under the default
 * BREAKING bar (70×.35 + 48×.30 + 15×.20 + 75×.15 = 53.15 → 53, bar 55).
 *
 * That gap is the one the OLD arithmetic could just clear: +10 recency ×
 * weight 0.20 = +2 composite. Every FAILS-ON-OLD promotion test below is built
 * on it, because a wider gap would have been refused by the old code for the
 * wrong reason and proved nothing.
 */
const GAP_2_SUBSCORES = {
  athlete_prominence: 70,
  information_specificity: 48,
  event_recency_novelty: 15,
  content_type_prior: 75,
};

function classifiedWith(
  subscores: typeof GAP_2_SUBSCORES,
  overrides: Partial<ClassificationResult> = {},
): ClassificationResult {
  const base = makeClassified(overrides);
  return {
    ...base,
    significance: { ...base.significance!, subscores, composite_score: 0, raw_score: 0 },
  };
}

function storedEntry(overrides: Partial<DeferQueueEntry> = {}): DeferQueueEntry {
  const now = Date.now();
  return normalizeEntry(
    {
      fingerprint: computeFingerprint(makeEvent()),
      athlete_key: computeAthleteKey('NBA', 'Moses Moody'),
      body_part: 'ankle',
      sources: ['espn'],
      deferred_at: new Date(now - 3_600_000).toISOString(),
      expires_at: new Date(now + 40 * 3_600_000).toISOString(),
      sport: 'NBA',
      athlete_name: 'Moses Moody',
      classification: {
        content_type: 'BREAKING',
        athlete_tier: 2,
        athlete_tier_source: 'lookup',
        subscores: GAP_2_SUBSCORES,
        sport: 'NBA',
      },
      source_count: 1,
      promotion_count: 0,
      ...overrides,
    } as DeferQueueEntry,
    'NBA',
  );
}

/** Load-then-save: the two calls every corroboration path makes. */
function primeQueue(entries: object[]) {
  mockCallTool
    .mockResolvedValueOnce(mcpStateResponse(serializeQueue(entries)))
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
}

function savedEntries(): Record<string, unknown>[] {
  const call = mockCallTool.mock.calls.find(([, tool]) => tool === 'web_set_social_state');
  if (!call) throw new Error('nothing was saved');
  return JSON.parse(call[2].value as string).entries;
}

// A date outside TEST_CONFIG's only season window, so the bar is unshifted.
const OFF_SEASON = new Date('2026-09-01T12:00:00Z');

describe('handleDeferDecision — new entry', () => {
  it('records the athlete key, body part and source family', async () => {
    primeQueue([]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent(),
      makeClassified(),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('deferred');
    const entries = savedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      athlete_key: 'NBA|moses moody',
      body_part: 'ankle',
      sources: ['espn'],
      source_count: 1,
      promotion_count: 0,
    });
  });

  it('sets expires_at from ttl_hours', async () => {
    primeQueue([]);
    const now = new Date('2026-09-01T00:00:00Z');

    await handleDeferDecision('NBA', makeEvent(), makeClassified(), DEFER_CONFIG, { now });

    const entry = savedEntries()[0];
    expect(entry.expires_at).toBe('2026-09-03T00:00:00.000Z'); // +48h
  });

  it('returns deferred and touches nothing when the event has no significance', async () => {
    const noSig = makeClassified({ significance: undefined });
    const result = await handleDeferDecision('NBA', makeEvent(), noSig, DEFER_CONFIG);
    expect(result.result).toBe('deferred');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('FAILS-ON-OLD: promotes on first sight when MultiSource merged a second publisher', async () => {
    // Two publishers can arrive in ONE cycle — deduplicateEvents collapses
    // same-day duplicates and hands the survivor its loser's family. The old
    // code created a fresh entry at source_count 1 and always deferred.
    primeQueue([]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent({ corroborating_families: ['x:shamscharania'] }),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('promoted');
    if (result.result !== 'promoted') return;
    expect(result.sources).toEqual(['espn', 'x:shamscharania']);
    expect(result.significance.triage_decision).toBe('PROCESS');
    expect(result.significance.process_threshold).toBe(45); // 55 − 10
    expect(result.significance.corroboration_discount).toBe(10);
  });
});

describe('handleDeferDecision — corroboration requires a second FAMILY', () => {
  it('FAILS-ON-OLD: the same feed re-serving its own row never promotes', async () => {
    // The live case, and the dominant one: ESPN re-serves an unchanged status
    // row every cycle. Old code read that as sources=2, applied +10 recency
    // (+2 composite) and promoted at exactly this gap.
    primeQueue([storedEntry()]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent(),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('deferred');
    const entry = savedEntries()[0];
    expect(entry.sources).toEqual(['espn']); // unchanged — no second publisher
    expect(entry.source_count).toBe(2); // the sighting is still counted
  });

  it('FAILS-ON-OLD: a second family promotes through the threshold discount', async () => {
    primeQueue([storedEntry()]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent({
        source_name: 'X:ShamsCharania',
        source_url: 'https://x.com/ShamsCharania/status/1',
        injury_description: 'sprained ankle, out multiple weeks',
      }),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('promoted');
    if (result.result !== 'promoted') return;
    expect(result.sources).toEqual(['espn', 'x:shamscharania']);
    expect(result.significance.corroborating_sources).toEqual(['espn', 'x:shamscharania']);
    expect(savedEntries()[0].promotion_count).toBe(1);
  });

  it('FAILS-ON-OLD: a re-serve after two families have been seen does not re-promote', async () => {
    // Old code kept adding to source_count and promoted again on every arrival
    // until promotion_cap — three Sonnet-bound passes for one story.
    primeQueue([storedEntry({ sources: ['espn', 'x:shamscharania'], promotion_count: 1 })]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent(),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('deferred');
    expect(savedEntries()[0].promotion_count).toBe(1);
  });

  it('FAIL-CLOSED: an unidentifiable publisher never corroborates', async () => {
    primeQueue([storedEntry()]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent({ source_name: undefined }),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('deferred');
    expect(savedEntries()[0].sources).toEqual(['espn']);
  });

  it('FAIL-CLOSED: all espn-* sources are ONE family', async () => {
    // espn-nba and espn-premier-league-news are two of our fetchers, not two
    // newsrooms. Corroborating one with the other would be ESPN agreeing with
    // itself through a different endpoint.
    primeQueue([storedEntry()]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent({ source_name: 'espn-nba-news', source_url: 'https://www.espn.com/nba/story/x' }),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('deferred');
    expect(savedEntries()[0].sources).toEqual(['espn']);
  });
});

describe('handleDeferDecision — the two-family guard', () => {
  it('FAILS-ON-OLD: a bar that fell for unrelated reasons cannot promote one source', async () => {
    // TEST_CONFIG drops NBA bars 5 points in the playoffs, so this composite
    // (53) clears the seasonal bar (50) on its own. Old code re-scored and
    // promoted. Corroboration is evidence about the REPORT, and one publisher
    // is one publisher whatever the calendar says.
    primeQueue([storedEntry({ sources: [] })]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent(),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: new Date('2026-05-01T12:00:00Z') },
    );

    expect(result.result).toBe('deferred');
    expect(savedEntries()[0].sources).toEqual(['espn']);
  });

  it('FAIL-CLOSED: a migrated entry is SEEDED by its next arrival, not corroborated', async () => {
    // Entries written before this change record no families. We do not know
    // which publisher filed them, so we cannot know whether the next one is a
    // second — the first arrival only establishes the set.
    const legacy = {
      fingerprint: 'moses moody:ankle-sprained',
      deferred_at: new Date(Date.now() - 3_600_000).toISOString(),
      expires_at: new Date(Date.now() + 40 * 3_600_000).toISOString(),
      sport: 'NBA',
      athlete_name: 'Moses Moody',
      classification: {
        content_type: 'BREAKING',
        athlete_tier: 2,
        athlete_tier_source: 'lookup',
        subscores: GAP_2_SUBSCORES,
        sport: 'NBA',
      },
      source_count: 4,
      promotion_count: 0,
    };
    primeQueue([legacy]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent({ source_name: 'X:ShamsCharania', source_url: 'https://x.com/ShamsCharania/status/1' }),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('deferred');
    const entry = savedEntries()[0];
    expect(entry.athlete_key).toBe('NBA|moses moody');
    expect(entry.sources).toEqual(['x:shamscharania']);
    expect(entry.source_count).toBe(5);
  });
});

describe('handleDeferDecision — body part guard', () => {
  it('FAIL-CLOSED: a different known body part opens a separate entry', async () => {
    primeQueue([storedEntry({ body_part: 'ankle' })]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent({
        source_name: 'X:ShamsCharania',
        source_url: 'https://x.com/ShamsCharania/status/1',
        injury_description: 'knee surgery',
      }),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('deferred');
    const entries = savedEntries();
    expect(entries).toHaveLength(2);
    expect(entries[1].body_part).toBe('knee');
    expect(entries[1].sources).toEqual(['x:shamscharania']);
  });

  it('an unstated body part wildcards, and is learned once', async () => {
    // A tweet that says only "placed on IR" names no part. Refusing to match
    // it would exclude exactly the reports the queue is waiting for.
    primeQueue([storedEntry({ body_part: null })]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent({
        source_name: 'X:ShamsCharania',
        source_url: 'https://x.com/ShamsCharania/status/1',
        injury_description: 'knee surgery',
      }),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('promoted');
    expect(savedEntries()[0].body_part).toBe('knee');
  });
});

describe('handleDeferDecision — caps, modes and isolation', () => {
  it('FAIL-CLOSED: never promotes past promotion_cap', async () => {
    primeQueue([storedEntry({ promotion_count: 3 })]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent({ source_name: 'X:ShamsCharania', source_url: 'https://x.com/ShamsCharania/status/1' }),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON },
    );

    expect(result.result).toBe('deferred');
    expect(savedEntries()[0].promotion_count).toBe(3);
  });

  it('FAIL-CLOSED: mode=off records the family but never promotes', async () => {
    primeQueue([storedEntry()]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent({ source_name: 'X:ShamsCharania', source_url: 'https://x.com/ShamsCharania/status/1' }),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON, mode: 'off' },
    );

    expect(result.result).toBe('deferred');
    expect(result.would_promote).toBeUndefined();
    expect(savedEntries()[0].sources).toEqual(['espn', 'x:shamscharania']);
  });

  it('mode=shadow reports what it would have done without doing it', async () => {
    primeQueue([storedEntry()]);

    const result = await handleDeferDecision(
      'NBA',
      makeEvent({ source_name: 'X:ShamsCharania', source_url: 'https://x.com/ShamsCharania/status/1' }),
      classifiedWith(GAP_2_SUBSCORES),
      DEFER_CONFIG,
      { now: OFF_SEASON, mode: 'shadow' },
    );

    expect(result.result).toBe('deferred');
    expect(result.would_promote).toBe(true);
    expect(savedEntries()[0].promotion_count).toBe(0);
  });

  it('FAIL-CLOSED: refuses to write a queue it could not read', async () => {
    mockIsServerAvailable.mockReturnValue(false);
    const result = await handleDeferDecision('NBA', makeEvent(), makeClassified(), DEFER_CONFIG);
    expect(result.result).toBe('deferred');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('uses separate storage keys for different sports', async () => {
    mockCallTool.mockResolvedValue(mcpStateResponse(null));

    await handleDeferDecision('NBA', makeEvent(), makeClassified(), DEFER_CONFIG);
    await handleDeferDecision(
      'NFL',
      makeEvent({ sport: 'NFL' }),
      makeClassified({ sport: 'NFL' }),
      DEFER_CONFIG,
    );

    const keys = mockCallTool.mock.calls.map(([, , args]) => (args as { key: string }).key);
    expect(keys).toContain('defer_queue_v1:NBA');
    expect(keys).toContain('defer_queue_v1:NFL');
  });
});
