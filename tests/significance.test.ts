import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeRawScore,
  decideTriage,
  resolveSportMultiplier,
  lookupAthleteTier,
  computeFingerprint,
  computeSignificance,
  _setTiersForTesting,
  _setConfigForTesting,
} from '../src/agents/injury-intelligence/significance.js';
import type { SignificanceSubscores } from '../src/types.js';

// ── Shared test config ────────────────────────────────────────────────────────

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
    NFL: [
      { window: 'offseason',      from: '03-01', to: '08-31', multiplier: 0.7 },
      { window: 'regular_season', from: '09-01', to: '02-28', multiplier: 1.0 },
    ],
    NBA: [
      { window: 'playoffs',       from: '04-15', to: '06-30', multiplier: 1.1 },
      { window: 'regular_season', from: '10-15', to: '04-14', multiplier: 1.0 },
      { window: 'offseason',      from: '07-01', to: '10-14', multiplier: 0.7 },
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

const TEST_TIERS = {
  version: 1,
  updated_at: '2026-04-29',
  athletes: [
    { name: 'Patrick Mahomes',     team: 'Chiefs',       sport: 'NFL', tier: 1 as const },
    { name: 'Garrett Wilson',      team: 'Jets',         sport: 'NFL', tier: 2 as const },
    { name: 'Calvin Ridley',       team: 'Titans',       sport: 'NFL', tier: 2 as const },
    { name: 'Anthony Edwards',     team: 'Timberwolves', sport: 'NBA', tier: 1 as const },
    { name: 'Donte DiVincenzo',    team: 'Timberwolves', sport: 'NBA', tier: 2 as const },
    { name: 'Moses Moody',         team: 'Warriors',     sport: 'NBA', tier: 2 as const },
    { name: 'Depth Player',        team: 'Practice',     sport: 'NFL', tier: 4 as const },
  ],
};

beforeEach(() => {
  _setConfigForTesting(TEST_CONFIG as Parameters<typeof _setConfigForTesting>[0]);
  _setTiersForTesting(TEST_TIERS as Parameters<typeof _setTiersForTesting>[0]);
});

// ── computeRawScore ──────────────────────────────────────────────────────────

describe('computeRawScore', () => {
  it('computes weighted sum correctly for typical inputs', () => {
    const subscores: SignificanceSubscores = {
      athlete_prominence: 70,
      information_specificity: 80,
      event_recency_novelty: 60,
      content_type_prior: 75,
    };
    // 70*0.35 + 80*0.30 + 60*0.20 + 75*0.15 = 24.5+24+12+11.25 = 71.75 → 72
    expect(computeRawScore(subscores)).toBe(72);
  });

  it('returns 0 when all subscores are 0', () => {
    const subscores: SignificanceSubscores = {
      athlete_prominence: 0,
      information_specificity: 0,
      event_recency_novelty: 0,
      content_type_prior: 0,
    };
    expect(computeRawScore(subscores)).toBe(0);
  });

  it('returns 100 when all subscores are 100', () => {
    const subscores: SignificanceSubscores = {
      athlete_prominence: 100,
      information_specificity: 100,
      event_recency_novelty: 100,
      content_type_prior: 100,
    };
    expect(computeRawScore(subscores)).toBe(100);
  });
});

// ── resolveSportMultiplier ───────────────────────────────────────────────────

describe('resolveSportMultiplier', () => {
  it('applies NFL offseason multiplier in April', () => {
    const date = new Date('2026-04-29');
    expect(resolveSportMultiplier('NFL', date)).toBe(0.7);
  });

  it('applies NFL regular season multiplier in October', () => {
    const date = new Date('2026-10-15');
    expect(resolveSportMultiplier('NFL', date)).toBe(1.0);
  });

  it('applies NFL regular season multiplier in January (year-wrap window)', () => {
    const date = new Date('2027-01-15');
    expect(resolveSportMultiplier('NFL', date)).toBe(1.0);
  });

  it('applies NBA playoffs multiplier in May', () => {
    const date = new Date('2026-05-10');
    expect(resolveSportMultiplier('NBA', date)).toBe(1.1);
  });

  it('applies NBA regular season multiplier in November', () => {
    const date = new Date('2026-11-01');
    expect(resolveSportMultiplier('NBA', date)).toBe(1.0);
  });

  it('applies NBA offseason multiplier in August', () => {
    const date = new Date('2026-08-15');
    expect(resolveSportMultiplier('NBA', date)).toBe(0.7);
  });

  it('returns default multiplier for unknown sport', () => {
    const date = new Date('2026-04-29');
    expect(resolveSportMultiplier('PREMIER_LEAGUE', date)).toBe(1.0);
  });
});

// ── decideTriage ─────────────────────────────────────────────────────────────

describe('decideTriage — default thresholds', () => {
  it('PROCESS at exactly threshold (score=55)', () => {
    expect(decideTriage(55, 'BREAKING', 2)).toBe('PROCESS');
  });

  it('DEFER just below PROCESS threshold (score=54)', () => {
    expect(decideTriage(54, 'BREAKING', 2)).toBe('DEFER');
  });

  it('DEFER at exactly defer threshold (score=35)', () => {
    expect(decideTriage(35, 'BREAKING', 2)).toBe('DEFER');
  });

  it('DROP just below defer threshold (score=34)', () => {
    expect(decideTriage(34, 'BREAKING', 2)).toBe('DROP');
  });
});

describe('decideTriage — CONFLICT_FLAG', () => {
  it('always PROCESS regardless of score', () => {
    expect(decideTriage(0, 'CONFLICT_FLAG', 4)).toBe('PROCESS');
    expect(decideTriage(100, 'CONFLICT_FLAG', 4)).toBe('PROCESS');
  });
});

describe('decideTriage — TRACKING', () => {
  it('PROCESS at score=70 for Tier 1', () => {
    expect(decideTriage(70, 'TRACKING', 1)).toBe('PROCESS');
  });

  it('PROCESS at score=70 for Tier 2', () => {
    expect(decideTriage(70, 'TRACKING', 2)).toBe('PROCESS');
  });

  it('DEFER (not PROCESS) at score=70 for Tier 3 — tier requirement fails', () => {
    expect(decideTriage(70, 'TRACKING', 3)).toBe('DEFER');
  });

  it('DEFER at score=69 for Tier 2 (below PROCESS threshold)', () => {
    expect(decideTriage(69, 'TRACKING', 2)).toBe('DEFER');
  });

  it('DEFER at score=35 for Tier 1 (above DEFER threshold)', () => {
    expect(decideTriage(35, 'TRACKING', 1)).toBe('DEFER');
  });

  it('DROP at score=34 for Tier 1 (below DEFER threshold)', () => {
    expect(decideTriage(34, 'TRACKING', 1)).toBe('DROP');
  });
});

describe('decideTriage — DEEP_DIVE', () => {
  it('PROCESS at score=40', () => {
    expect(decideTriage(40, 'DEEP_DIVE', 3)).toBe('PROCESS');
  });

  it('DEFER at score=39 (below PROCESS, above DEFER)', () => {
    expect(decideTriage(39, 'DEEP_DIVE', 3)).toBe('DEFER');
  });

  it('DEFER at score=25', () => {
    expect(decideTriage(25, 'DEEP_DIVE', 3)).toBe('DEFER');
  });

  it('DROP at score=24', () => {
    expect(decideTriage(24, 'DEEP_DIVE', 3)).toBe('DROP');
  });
});

describe('decideTriage — BREAKING Tier 1', () => {
  it('PROCESS at score=45 for Tier 1', () => {
    expect(decideTriage(45, 'BREAKING', 1)).toBe('PROCESS');
  });

  it('DEFER at score=44 for Tier 1', () => {
    expect(decideTriage(44, 'BREAKING', 1)).toBe('DEFER');
  });

  it('uses default threshold (55) for Tier 2 BREAKING', () => {
    expect(decideTriage(54, 'BREAKING', 2)).toBe('DEFER');
    expect(decideTriage(55, 'BREAKING', 2)).toBe('PROCESS');
  });
});

// ── lookupAthleteTier ────────────────────────────────────────────────────────

describe('lookupAthleteTier', () => {
  it('returns correct tier for an exact match', () => {
    const result = lookupAthleteTier('Patrick Mahomes', 'NFL');
    expect(result.tier).toBe(1);
    expect(result.source).toBe('lookup');
  });

  it('is case-insensitive', () => {
    const result = lookupAthleteTier('patrick mahomes', 'NFL');
    expect(result.tier).toBe(1);
    expect(result.source).toBe('lookup');
  });

  it('handles extra whitespace', () => {
    const result = lookupAthleteTier('  Garrett Wilson  ', 'NFL');
    expect(result.tier).toBe(2);
    expect(result.source).toBe('lookup');
  });

  it('returns Tier 3 default for unknown athlete', () => {
    const result = lookupAthleteTier('Nobody Famous', 'NFL');
    expect(result.tier).toBe(3);
    expect(result.source).toBe('default');
  });

  it('returns Tier 4 for an explicit Tier 4 entry', () => {
    const result = lookupAthleteTier('Depth Player', 'NFL');
    expect(result.tier).toBe(4);
    expect(result.source).toBe('lookup');
  });

  it('returns default when no tiers are loaded', () => {
    _setTiersForTesting(null);
    const result = lookupAthleteTier('Patrick Mahomes', 'NFL');
    expect(result.tier).toBe(3);
    expect(result.source).toBe('default');
  });

  it('matches by name when sport differs, as fallback', () => {
    // Mahomes is in NFL; looking up with NBA should still find by name
    const result = lookupAthleteTier('Patrick Mahomes', 'NBA');
    expect(result.tier).toBe(1);
    expect(result.source).toBe('lookup');
  });
});

// ── computeFingerprint ───────────────────────────────────────────────────────

describe('computeFingerprint', () => {
  function makeEvent(name: string, desc: string) {
    return {
      athlete_name: name,
      sport: 'NBA' as const,
      team: 'Warriors',
      injury_description: desc,
      source_url: 'https://example.com',
      reported_at: new Date(),
    };
  }

  it('produces a deterministic fingerprint', () => {
    const fp1 = computeFingerprint(makeEvent('Moses Moody', 'patellar tendon rupture'));
    const fp2 = computeFingerprint(makeEvent('Moses Moody', 'patellar tendon rupture'));
    expect(fp1).toBe(fp2);
  });

  it('normalizes case and punctuation', () => {
    const fp1 = computeFingerprint(makeEvent('Moses Moody', 'Patellar Tendon Rupture!'));
    const fp2 = computeFingerprint(makeEvent('moses moody', 'patellar tendon rupture'));
    expect(fp1).toBe(fp2);
  });

  it('produces the same fingerprint for paraphrased injuries (word sort)', () => {
    const fp1 = computeFingerprint(makeEvent('Moses Moody', 'torn patellar tendon'));
    const fp2 = computeFingerprint(makeEvent('Moses Moody', 'patellar tendon torn'));
    expect(fp1).toBe(fp2);
  });

  it('produces different fingerprints for different athletes', () => {
    const fp1 = computeFingerprint(makeEvent('Moses Moody', 'ACL tear'));
    const fp2 = computeFingerprint(makeEvent('Anthony Edwards', 'ACL tear'));
    expect(fp1).not.toBe(fp2);
  });

  it('produces different fingerprints for different injuries on same athlete', () => {
    const fp1 = computeFingerprint(makeEvent('Moses Moody', 'ACL tear'));
    const fp2 = computeFingerprint(makeEvent('Moses Moody', 'patellar tendon rupture'));
    expect(fp1).not.toBe(fp2);
  });
});

// ── computeSignificance (integration) ────────────────────────────────────────

describe('computeSignificance', () => {
  it('returns expected composite score and decision for high-signal NBA event', () => {
    // DiVincenzo Achilles rupture: T2, NBA playoffs, high spec+rec
    const result = computeSignificance(
      2, 'lookup',
      { information_specificity: 90, event_recency_novelty: 90 },
      'BREAKING', 'NBA',
      new Date('2026-04-29')
    );
    expect(result.sport_multiplier).toBe(1.1);
    expect(result.triage_decision).toBe('PROCESS');
    expect(result.composite_score).toBeGreaterThan(55);
  });

  it('clamps out-of-range Haiku sub-scores', () => {
    const result = computeSignificance(
      2, 'lookup',
      { information_specificity: 150, event_recency_novelty: -10 },
      'BREAKING', 'NFL',
      new Date('2026-10-15')
    );
    expect(result.subscores.information_specificity).toBe(100);
    expect(result.subscores.event_recency_novelty).toBe(0);
  });

  it('includes athlete_tier_source in rationale for default tier', () => {
    const result = computeSignificance(
      3, 'default',
      { information_specificity: 50, event_recency_novelty: 50 },
      'BREAKING', 'NFL',
      new Date('2026-10-15')
    );
    expect(result.athlete_tier_source).toBe('default');
    expect(result.rationale).toMatch(/tier=3\?/);
  });
});
