/**
 * Calibration fixture tests for the significance gate.
 *
 * These use the 6 example cases from the spec (3 expected DROP, 3 expected PROCESS)
 * as a regression suite. Any change to the scoring logic that flips a decision
 * here should be explicitly reviewed by the founder before merging.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { computeSignificance, _setConfigForTesting, _setTiersForTesting } from '../src/agents/injury-intelligence/significance.js';
import type { TriageDecision } from '../src/types.js';

const TEST_CONFIG = {
  version: 1 as const,
  thresholds: {
    default:       { process: 55, defer: 35 },
    BREAKING_T1:   { process: 45, defer: 30 },
    TRACKING:      { process: 65, defer: 40, require_tier_1_or_2: true },
    DEEP_DIVE:     { process: 40, defer: 25 },
    CONFLICT_FLAG: { always_process: true },
  },
  sport_seasons: {
    NFL: [
      { window: 'offseason',      from: '03-01', to: '08-31', threshold_delta:  5 },
      { window: 'regular_season', from: '09-01', to: '02-28', threshold_delta:  0 },
    ],
    NBA: [
      { window: 'playoffs',       from: '04-15', to: '06-30', threshold_delta: -5 },
      { window: 'regular_season', from: '10-15', to: '04-14', threshold_delta:  0 },
      { window: 'offseason',      from: '07-01', to: '10-14', threshold_delta:  5 },
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

// Minimal tiers for fixture tests — only athletes that appear in examples
const TEST_TIERS = {
  version: 1,
  updated_at: '2026-04-29',
  athletes: [
    { name: 'Anthony Edwards',  team: 'Timberwolves', sport: 'NBA', tier: 1 as const },
    { name: 'Donte DiVincenzo', team: 'Timberwolves', sport: 'NBA', tier: 2 as const },
    { name: 'Moses Moody',      team: 'Warriors',     sport: 'NBA', tier: 2 as const },
    { name: 'Garrett Wilson',   team: 'Jets',         sport: 'NFL', tier: 2 as const },
    { name: 'Calvin Ridley',    team: 'Titans',       sport: 'NFL', tier: 2 as const },
    // Mark Williams is NOT in the tier DB → defaults to Tier 3
  ],
};

// April 29, 2026 — the reference date used in the spec examples
const REFERENCE_DATE = new Date('2026-04-29');

beforeEach(() => {
  _setConfigForTesting(TEST_CONFIG as Parameters<typeof _setConfigForTesting>[0]);
  _setTiersForTesting(TEST_TIERS as Parameters<typeof _setTiersForTesting>[0]);
});

// ── Helper ────────────────────────────────────────────────────────────────────

function score(
  athleteName: string,
  sport: 'NFL' | 'NBA',
  contentType: 'BREAKING' | 'TRACKING' | 'DEEP_DIVE' | 'CONFLICT_FLAG',
  haikuSpec: number,
  haikuRec: number,
  date = REFERENCE_DATE
): { decision: TriageDecision; composite: number; seasonDelta: number } {
  const tierEntry = TEST_TIERS.athletes.find(
    (a) => a.name === athleteName && a.sport === sport
  );
  const tier = tierEntry?.tier ?? 3;
  const source = tierEntry ? 'lookup' : 'default';

  const result = computeSignificance(
    tier as 1 | 2 | 3 | 4,
    source as 'lookup' | 'default',
    { information_specificity: haikuSpec, event_recency_novelty: haikuRec },
    contentType,
    sport,
    date
  );

  return {
    decision: result.triage_decision,
    composite: result.composite_score,
    seasonDelta: result.season_threshold_delta,
  };
}

// ── Noise examples (expected: DROP) ──────────────────────────────────────────

describe('noise fixtures — should DROP', () => {
  it('Mark Williams foot fracture: vague, re-report, NBA TRACKING, Tier 3 (not in DB)', () => {
    // "remains out with a left foot fracture" — no type, no update
    // spec=20 (foot fracture, no structure named), rec=10 (stale "remains out")
    const r = score('Mark Williams', 'NBA', 'TRACKING', 20, 10);
    // Tier 3, NBA playoffs (bar -5)
    // score = 40*0.35 + 20*0.30 + 10*0.20 + 30*0.15 = 14+6+2+4.5 = 26.5 → 27
    // TRACKING requires tier 1-2 → DROP outright, score never consulted
    expect(r.decision).toBe('DROP');
    expect(r.composite).toBe(27);
    expect(r.seasonDelta).toBe(-5);
  });

  it('Garrett Wilson knee sprain: vague, stale offseason, NFL TRACKING, Tier 2', () => {
    // "knee sprain, Questionable, April offseason" — vague grade, no novelty
    // spec=25, rec=5 (stale Questionable tag)
    const r = score('Garrett Wilson', 'NFL', 'TRACKING', 25, 5);
    // Tier 2, NFL offseason (bar +5)
    // score = 70*0.35 + 25*0.30 + 5*0.20 + 30*0.15 = 24.5+7.5+1+4.5 = 37.5 → 38
    // TRACKING defer floor = 40+5 = 45; 38 < 45 → DROP
    expect(r.decision).toBe('DROP');
    expect(r.composite).toBe(38);
    expect(r.seasonDelta).toBe(5);
  });

  it('Calvin Ridley lower leg surgery: procedure unknown, NFL TRACKING, Tier 2', () => {
    // "recovering from lower leg surgery" — type unknown, RTP speculative
    // spec=25 (surgery confirmed, no type), rec=20 (some novelty from surgery news)
    const r = score('Calvin Ridley', 'NFL', 'TRACKING', 25, 20);
    // Tier 2, NFL offseason (bar +5)
    // score = 70*0.35 + 25*0.30 + 20*0.20 + 30*0.15 = 24.5+7.5+4+4.5 = 40.5 → 41
    // TRACKING defer floor = 40+5 = 45; 41 < 45 → DROP.
    // This is the fixture that forced TRACKING.defer 35→40: at the old floor of
    // 35 (+5 = 40) a score of 41 would have flipped to DEFER.
    expect(r.decision).toBe('DROP');
    expect(r.composite).toBe(41);
    expect(r.seasonDelta).toBe(5);
  });
});

// ── Signal examples (expected: PROCESS) ──────────────────────────────────────

describe('signal fixtures — should PROCESS', () => {
  it('DiVincenzo Achilles rupture: confirmed, surgery, NBA playoffs, BREAKING Tier 2', () => {
    // "ruptured right Achilles, surgery scheduled, 10-month timeline"
    // spec=90, rec=90
    const r = score('Donte DiVincenzo', 'NBA', 'BREAKING', 90, 90);
    // Tier 2, NBA playoffs (bar -5)
    // score = 70*0.35 + 90*0.30 + 90*0.20 + 75*0.15 = 24.5+27+18+11.25 = 80.75 → 81
    // BREAKING T2 (not T1): default bar 55-5 = 50; 81 >= 50 → PROCESS
    expect(r.decision).toBe('PROCESS');
    expect(r.composite).toBe(81);
    expect(r.seasonDelta).toBe(-5);
  });

  it('Moses Moody patellar tendon: confirmed rupture + surgery, NBA playoffs, DEEP_DIVE Tier 2', () => {
    // "complete patellar tendon rupture, surgical repair confirmed"
    // spec=90, rec=90
    const r = score('Moses Moody', 'NBA', 'DEEP_DIVE', 90, 90);
    // Tier 2, NBA playoffs (bar -5)
    // score = 70*0.35 + 90*0.30 + 90*0.20 + 80*0.15 = 24.5+27+18+12 = 81.5 → 82
    // DEEP_DIVE bar = 40-5 = 35; 82 >= 35 → PROCESS
    expect(r.decision).toBe('PROCESS');
    expect(r.composite).toBe(82);
    expect(r.seasonDelta).toBe(-5);
  });

  it('Anthony Edwards knee bone bruise + hyperextension: NBA playoffs, BREAKING Tier 1', () => {
    // "left knee bone bruise + hyperextension, OUT in playoffs"
    // spec=55 (named finding but no specific structure), rec=70 (new, playoff context)
    const r = score('Anthony Edwards', 'NBA', 'BREAKING', 55, 70);
    // Tier 1, NBA playoffs (bar -5)
    // score = 95*0.35 + 55*0.30 + 70*0.20 + 75*0.15 = 33.25+16.5+14+11.25 = 75
    // BREAKING T1 bar = 45-5 = 40; 75 >= 40 → PROCESS
    expect(r.decision).toBe('PROCESS');
    expect(r.composite).toBe(75);
    expect(r.seasonDelta).toBe(-5);
  });
});
