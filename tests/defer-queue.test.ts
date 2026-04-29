import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock MCP client manager before importing defer-queue
vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import { evictExpired, handleDeferDecision } from '../src/monitoring/defer-queue.js';
import {
  _setConfigForTesting,
  _setTiersForTesting,
} from '../src/agents/injury-intelligence/significance.js';
import type { ClassificationResult } from '../src/types.js';

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
  sport_multipliers: {
    NBA: [
      { window: 'playoffs', from: '04-15', to: '06-30', multiplier: 1.1 },
    ],
  },
  default_sport_multiplier: 1.0,
  defer: {
    ttl_hours: 6,
    promotion_cap: 3,
    corroboration_bonus_per_source: 5,
    corroboration_bonus_max: 20,
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
      sport_multiplier: 1.0,
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

function mcpStateResponse(value: string | null) {
  if (value === null) return { content: [{ type: 'text', text: '' }] };
  return { content: [{ type: 'text', text: value }] };
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

describe('handleDeferDecision — new entry', () => {
  it('adds a new entry when fingerprint is not in queue', async () => {
    mockCallTool
      .mockResolvedValueOnce(mcpStateResponse(serializeQueue([])))  // load empty
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] }); // save

    const result = await handleDeferDecision(
      'NBA', 'moses-moody:patellar-tendon', makeClassified(), DEFER_CONFIG
    );

    expect(result).toBe('deferred');
    const saveCall = mockCallTool.mock.calls[1];
    const saved = JSON.parse(saveCall[2].value as string);
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0].fingerprint).toBe('moses-moody:patellar-tendon');
    expect(saved.entries[0].source_count).toBe(1);
    expect(saved.entries[0].promotion_count).toBe(0);
  });

  it('returns deferred when no significance on classified', async () => {
    const noSig = makeClassified({ significance: undefined });
    const result = await handleDeferDecision('NBA', 'fp', noSig, DEFER_CONFIG);
    expect(result).toBe('deferred');
  });
});

describe('handleDeferDecision — corroboration', () => {
  it('increments source_count when same fingerprint arrives again', async () => {
    const now = Date.now();
    const existing = [{
      fingerprint: 'moses-moody:patellar-tendon',
      deferred_at: new Date(now - 3_600_000).toISOString(),
      expires_at:  new Date(now + 5 * 3_600_000).toISOString(),
      sport: 'NBA',
      athlete_name: 'Moses Moody',
      classification: {
        content_type: 'BREAKING',
        athlete_tier: 2,
        athlete_tier_source: 'lookup',
        subscores: { athlete_prominence: 70, information_specificity: 30, event_recency_novelty: 15, content_type_prior: 75 },
        sport: 'NBA',
      },
      source_count: 1,
      promotion_count: 0,
    }];

    mockCallTool
      .mockResolvedValueOnce(mcpStateResponse(serializeQueue(existing)))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });

    await handleDeferDecision('NBA', 'moses-moody:patellar-tendon', makeClassified(), DEFER_CONFIG);

    const saveCall = mockCallTool.mock.calls[1];
    const saved = JSON.parse(saveCall[2].value as string);
    expect(saved.entries[0].source_count).toBe(2);
  });

  it('promotes when corroboration bonus pushes score to PROCESS threshold', async () => {
    const now = Date.now();
    // Make a classified event that, with bonus, crosses the PROCESS threshold (55 for BREAKING T2)
    // Base composite = 42 (DEFER). Corroboration bonus for source_count=2: +5 to recency.
    // Adjusted recency = 15 + 5 = 20. New raw = 70*0.35 + 30*0.30 + 20*0.20 + 75*0.15 = 24.5+9+4+11.25=48.75→49
    // composite = 49 * 1.1 (NBA playoffs) = 53.9 → 54 → DEFER (still under 55)
    // So we need a case that actually tips over. Let's set rec=45 so bonus pushes to 50:
    // raw = 70*0.35 + 60*0.30 + 50*0.20 + 75*0.15 = 24.5+18+10+11.25 = 63.75 → 64
    // composite = 64 * 1.1 = 70.4 → 70 → PROCESS (≥55)
    const highScoreClassified = makeClassified({
      significance: {
        raw_score: 58,
        sport_multiplier: 1.1,
        composite_score: 64,  // close enough to trigger with bonus
        triage_decision: 'DEFER',
        athlete_tier: 2,
        athlete_tier_source: 'lookup',
        subscores: {
          athlete_prominence: 70,
          information_specificity: 60,
          event_recency_novelty: 45,
          content_type_prior: 75,
        },
        rationale: 'DEFER score=64',
      },
    });

    const existing = [{
      fingerprint: 'moses-moody:patellar-tendon',
      deferred_at: new Date(now - 3_600_000).toISOString(),
      expires_at:  new Date(now + 5 * 3_600_000).toISOString(),
      sport: 'NBA',
      athlete_name: 'Moses Moody',
      classification: {
        content_type: 'BREAKING',
        athlete_tier: 2,
        athlete_tier_source: 'lookup',
        subscores: { athlete_prominence: 70, information_specificity: 60, event_recency_novelty: 45, content_type_prior: 75 },
        sport: 'NBA',
      },
      source_count: 1,
      promotion_count: 0,
    }];

    mockCallTool
      .mockResolvedValueOnce(mcpStateResponse(serializeQueue(existing)))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });

    const result = await handleDeferDecision(
      'NBA', 'moses-moody:patellar-tendon', highScoreClassified, DEFER_CONFIG
    );

    // With NBA playoffs (1.1), adjusted recency=50, raw=64, composite=70 → PROCESS
    expect(result).toBe('promoted');
  });

  it('respects promotion cap — never promotes after cap is reached', async () => {
    const now = Date.now();
    const existing = [{
      fingerprint: 'fp',
      deferred_at: new Date(now - 3_600_000).toISOString(),
      expires_at:  new Date(now + 5 * 3_600_000).toISOString(),
      sport: 'NBA',
      athlete_name: 'Moses Moody',
      classification: {
        content_type: 'BREAKING',
        athlete_tier: 2,
        athlete_tier_source: 'lookup',
        subscores: { athlete_prominence: 70, information_specificity: 60, event_recency_novelty: 45, content_type_prior: 75 },
        sport: 'NBA',
      },
      source_count: 1,
      promotion_count: 3, // at cap
    }];

    mockCallTool.mockResolvedValueOnce(mcpStateResponse(serializeQueue(existing)));

    const result = await handleDeferDecision('NBA', 'fp', makeClassified(), DEFER_CONFIG);
    expect(result).toBe('deferred');
  });
});

describe('handleDeferDecision — per-sport key isolation', () => {
  it('uses separate storage keys for different sports', async () => {
    mockCallTool
      .mockResolvedValue(mcpStateResponse(serializeQueue([])));

    await handleDeferDecision('NFL', 'fp', makeClassified({ sport: 'NFL', significance: { ...makeClassified().significance!, subscores: { ...makeClassified().significance!.subscores } } }), DEFER_CONFIG);
    await handleDeferDecision('NBA', 'fp', makeClassified(), DEFER_CONFIG);

    const calls = mockCallTool.mock.calls.filter((c) => c[1] === 'web_get_social_state');
    const keys = calls.map((c) => c[2].key as string);
    expect(keys.some((k) => k.includes('NFL'))).toBe(true);
    expect(keys.some((k) => k.includes('NBA'))).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
