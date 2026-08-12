import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  computeRawScore,
  decideTriage,
  effectiveThresholds,
  resolveSeasonDelta,
  lookupAthleteTier,
  computeFingerprint,
  computeSignificance,
  computePromotionScore,
  PROMOTION_PROPOSE_THRESHOLD,
  _setTiersForTesting,
  _setSalarySnapshotForTesting,
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
  // Stated rather than assumed: the "genuinely unknown athlete" assertions
  // below would pass without this, but only because no salary snapshot is
  // installed in this process. Salary coverage is exercised in
  // tests/salary-tier.test.ts.
  _setSalarySnapshotForTesting(null);
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

// ── resolveSeasonDelta ───────────────────────────────────────────────────────

describe('resolveSeasonDelta', () => {
  it('raises the bar during the NFL offseason in April', () => {
    expect(resolveSeasonDelta('NFL', new Date('2026-04-29'))).toEqual({
      window: 'offseason',
      delta: 5,
    });
  });

  it('leaves the bar alone during the NFL regular season in October', () => {
    expect(resolveSeasonDelta('NFL', new Date('2026-10-15'))).toEqual({
      window: 'regular_season',
      delta: 0,
    });
  });

  it('resolves the NFL regular season in January (year-wrap window)', () => {
    expect(resolveSeasonDelta('NFL', new Date('2027-01-15'))).toEqual({
      window: 'regular_season',
      delta: 0,
    });
  });

  it('lowers the bar during the NBA playoffs in May', () => {
    expect(resolveSeasonDelta('NBA', new Date('2026-05-10'))).toEqual({
      window: 'playoffs',
      delta: -5,
    });
  });

  it('leaves the bar alone during the NBA regular season in November', () => {
    expect(resolveSeasonDelta('NBA', new Date('2026-11-01'))).toEqual({
      window: 'regular_season',
      delta: 0,
    });
  });

  it('raises the bar during the NBA offseason in August', () => {
    expect(resolveSeasonDelta('NBA', new Date('2026-08-15'))).toEqual({
      window: 'offseason',
      delta: 5,
    });
  });

  it('falls back to the default delta for a sport with no windows', () => {
    expect(resolveSeasonDelta('PREMIER_LEAGUE', new Date('2026-04-29'))).toEqual({
      window: 'none',
      delta: 0,
    });
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

  // Deferring these used to be the behaviour, but the defer queue re-scores with
  // the same tier, so require_tier_1_or_2 blocks PROCESS forever — the entry just
  // churned MCP state until its TTL expired. Drop immediately instead.
  it('DROP (not DEFER) at score=70 for Tier 3 — tier requirement can never be met', () => {
    expect(decideTriage(70, 'TRACKING', 3)).toBe('DROP');
  });

  it('DROP at any score for Tier 4 TRACKING', () => {
    expect(decideTriage(100, 'TRACKING', 4)).toBe('DROP');
    expect(decideTriage(50, 'TRACKING', 4)).toBe('DROP');
    expect(decideTriage(0, 'TRACKING', 4)).toBe('DROP');
  });

  // A tier-blocked cell reports no threshold, exactly like CONFLICT_FLAG's
  // always_process. decideTriage must test tier_blocked FIRST — reading the
  // absent threshold as "always processes" would invert the rule and publish
  // every low-tier TRACKING event.
  it('tier-blocked outranks the no-threshold case', () => {
    const blocked = effectiveThresholds('TRACKING', 3);
    expect(blocked).toEqual({ process: null, defer: null, tier_blocked: true });
    expect(decideTriage(100, 'TRACKING', 3)).toBe('DROP');

    const alwaysProcess = effectiveThresholds('CONFLICT_FLAG', 3);
    expect(alwaysProcess.tier_blocked).toBe(false);
    expect(decideTriage(0, 'CONFLICT_FLAG', 3)).toBe('PROCESS');
  });

  // The clamp exists for genuinely misconfigured cells; a tier-blocked cell is
  // not misconfigured, and warning about a bar that is never applied would log
  // on most of the feed.
  it('does not warn UNREACHABLE_THRESHOLD for tier-blocked cells', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      decideTriage(50, 'TRACKING', 3);
      decideTriage(50, 'TRACKING', 4);
      const unreachable = warn.mock.calls.filter((c) =>
        String(c[0]).includes('UNREACHABLE_THRESHOLD'),
      );
      expect(unreachable).toEqual([]);
    } finally {
      warn.mockRestore();
    }
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

  // Tier 4 is the deep-depth bucket, and its BREAKING ceiling (60) sits below
  // the offseason bar (65). Blocking it by policy states that; leaving it to
  // the reachability clamp would silently lower the bar instead.
  it('DROP for Tier 4 BREAKING when default.max_tier is set', () => {
    _setConfigForTesting({
      ...TEST_CONFIG,
      thresholds: { ...TEST_CONFIG.thresholds, default: { process: 60, defer: 35, max_tier: 3 } },
    } as Parameters<typeof _setConfigForTesting>[0]);

    expect(effectiveThresholds('BREAKING', 4)).toEqual({
      process: null,
      defer: null,
      tier_blocked: true,
    });
    expect(decideTriage(100, 'BREAKING', 4)).toBe('DROP');
    // Tier 3 still scores normally against the raised bar.
    expect(decideTriage(60, 'BREAKING', 3)).toBe('PROCESS');
    expect(decideTriage(59, 'BREAKING', 3)).toBe('DEFER');
  });

  it('ignores max_tier when the config omits it', () => {
    expect(effectiveThresholds('BREAKING', 4).tier_blocked).toBe(false);
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

// ── lookupAthleteTier: spelling variants ─────────────────────────────────────
//
// lookupAthleteTier and isSameAthleteName both answer "is this the same
// athlete?" and used to answer it with different normalizations. normalizeText
// turns "A.J. Brown" into "a j brown" but "AJ Brown" into "aj brown", so the
// exact-match lookup missed every punctuation and suffix variant and reported
// tier 3 `default` for a listed star — while the drift check happily called the
// two spellings the same person. Since tier drives 35% of the significance
// score, and the concussion gate drops on tier, that silent disagreement
// mattered. athlete-tiers.json is full of both shapes ("Ja'Marr Chase",
// "Amon-Ra St. Brown", "Jaren Jackson Jr.", "Kenneth Walker III").

describe('lookupAthleteTier — spelling variants sources actually produce', () => {
  const VARIANT_TIERS = {
    version: 1,
    updated_at: '2026-08-11',
    athletes: [
      { name: 'A.J. Brown',        team: 'Eagles',   sport: 'NFL', tier: 1 as const },
      { name: 'Jaren Jackson Jr.', team: 'Grizzlies', sport: 'NBA', tier: 1 as const },
      { name: 'Kenneth Walker III', team: 'Seahawks', sport: 'NFL', tier: 2 as const },
      { name: "Ja'Marr Chase",     team: 'Bengals',  sport: 'NFL', tier: 1 as const },
    ],
  };

  beforeEach(() => {
    _setTiersForTesting(VARIANT_TIERS as Parameters<typeof _setTiersForTesting>[0]);
  });

  it.each([
    ['AJ Brown', 1],
    ['A J Brown', 1],
    ['Jaren Jackson Jr', 1],
    ['Jaren Jackson', 1],
    ['Kenneth Walker', 2],
    ['JaMarr Chase', 1],
  ])('resolves %j from the DB rather than defaulting', (name, tier) => {
    const result = lookupAthleteTier(name, name === 'Jaren Jackson Jr' ? 'NBA' : 'NFL');
    expect(result.source).toBe('lookup');
    expect(result.tier).toBe(tier);
  });

  it('still defaults for a genuinely unknown athlete', () => {
    const result = lookupAthleteTier('Dyami Brown', 'NFL');
    expect(result.source).toBe('default');
    expect(result.tier).toBe(3);
  });

  // Suffix stripping can merge real people — Marvin Harrison Jr. is the son of
  // Marvin Harrison. Guessing between them is worse than admitting we can't
  // tell, so an ambiguous loose match falls back to the default.
  it('refuses to guess when suffix stripping is ambiguous', () => {
    _setTiersForTesting({
      version: 1,
      updated_at: '2026-08-11',
      athletes: [
        { name: 'Marvin Harrison Jr.', team: 'Cardinals', sport: 'NFL', tier: 1 as const },
        { name: 'Marvin Harrison Sr.', team: 'Colts',     sport: 'NFL', tier: 4 as const },
      ],
    } as Parameters<typeof _setTiersForTesting>[0]);

    const result = lookupAthleteTier('Marvin Harrison', 'NFL');
    expect(result.source).toBe('default');
    expect(result.tier).toBe(3);
  });

  it('still prefers an exact match over a loose one', () => {
    _setTiersForTesting({
      version: 1,
      updated_at: '2026-08-11',
      athletes: [
        { name: 'Marvin Harrison Jr.', team: 'Cardinals', sport: 'NFL', tier: 1 as const },
        { name: 'Marvin Harrison',     team: 'Colts',     sport: 'NFL', tier: 4 as const },
      ],
    } as Parameters<typeof _setTiersForTesting>[0]);

    // Exact hit wins outright — no ambiguity check, no default.
    expect(lookupAthleteTier('Marvin Harrison', 'NFL')).toEqual({ tier: 4, source: 'lookup' });
    expect(lookupAthleteTier('Marvin Harrison Jr.', 'NFL')).toEqual({ tier: 1, source: 'lookup' });
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
    expect(result.season_window).toBe('playoffs');
    expect(result.season_threshold_delta).toBe(-5);
    expect(result.triage_decision).toBe('PROCESS');
    // The score is now the raw score — the playoff window lowers the bar to 50
    // rather than inflating the score past 55.
    expect(result.composite_score).toBe(result.raw_score);
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

describe('computePromotionScore', () => {
  it('scores a fresh tier-1, max-magnitude, T1-corroborated conflict at the ceiling', () => {
    const { score, proposed, reasons } = computePromotionScore({
      composite: 95,
      conflict_flag_present: true,
      conflict_gap_weeks: 12,        // >= cap → full magnitude
      entity_staleness_days: 0,
      corroboration_tier: 'T1',
    });
    // 0.40*0.95 + 0.15*1 + 0.20*1 + 0.15*1 + 0.10*1 = 0.98 → 98
    expect(score).toBe(98);
    expect(proposed).toBe(true);
    expect(reasons).toHaveLength(5);
  });

  it('weights are normalized — a maxed-out input cannot exceed 100', () => {
    const { score } = computePromotionScore({
      composite: 100,
      conflict_flag_present: true,
      conflict_gap_weeks: 40,        // beyond cap, still clamps
      entity_staleness_days: 0,
      corroboration_tier: 'T1',
    });
    expect(score).toBe(100);
  });

  it('conflict magnitude raises the score — a bigger team-vs-OTM gap ranks higher', () => {
    const base = { composite: 40, conflict_flag_present: true, entity_staleness_days: 0, corroboration_tier: 'T1' as const };
    const small = computePromotionScore({ ...base, conflict_gap_weeks: 2 });
    const large = computePromotionScore({ ...base, conflict_gap_weeks: 12 });
    expect(large.score).toBeGreaterThan(small.score);
    // a large-gap conflict for an obscure (low-composite) athlete can outrank a
    // tiny-gap conflict for a star — magnitude is meant to do exactly this
    const obscureBigGap = computePromotionScore({ composite: 40, conflict_flag_present: true, conflict_gap_weeks: 12, entity_staleness_days: 0, corroboration_tier: 'T1' });
    const starTinyGap = computePromotionScore({ composite: 70, conflict_flag_present: true, conflict_gap_weeks: 1, entity_staleness_days: 0, corroboration_tier: 'T1' });
    expect(obscureBigGap.score).toBeGreaterThan(starTinyGap.score);
  });

  it('magnitude only counts when a conflict is flagged', () => {
    const withGapNoFlag = computePromotionScore({ composite: 40, conflict_flag_present: false, conflict_gap_weeks: 12, entity_staleness_days: 0, corroboration_tier: 'T1' });
    const noGapNoFlag = computePromotionScore({ composite: 40, conflict_flag_present: false, conflict_gap_weeks: 0, entity_staleness_days: 0, corroboration_tier: 'T1' });
    expect(withGapNoFlag.score).toBe(noGapNoFlag.score);
  });

  it('penalizes staleness — fresh outranks stale, all else equal', () => {
    const common = { composite: 70, conflict_flag_present: true, conflict_gap_weeks: 6, corroboration_tier: 'T1' as const };
    const fresh = computePromotionScore({ ...common, entity_staleness_days: 0 });
    const stale = computePromotionScore({ ...common, entity_staleness_days: 21 });
    expect(fresh.score).toBeGreaterThan(stale.score);
    // staleness floors at STALENESS_FLOOR_DAYS (21) — beyond that, no extra penalty
    const veryStale = computePromotionScore({ ...common, entity_staleness_days: 999 });
    expect(veryStale.score).toBe(stale.score);
  });

  it('rewards corroboration tier: T1 > T2 > T3/unknown', () => {
    const mk = (t: 'T1' | 'T2' | 'T3' | 'unknown') =>
      computePromotionScore({ composite: 50, conflict_flag_present: true, conflict_gap_weeks: 6, entity_staleness_days: 0, corroboration_tier: t }).score;
    expect(mk('T1')).toBeGreaterThan(mk('T2'));
    expect(mk('T2')).toBeGreaterThan(mk('T3'));
    expect(mk('T3')).toBe(mk('unknown'));
  });

  it('a non-conflict, low-prominence, stale, low-trust event falls below threshold', () => {
    const { score, proposed } = computePromotionScore({
      composite: 10,
      conflict_flag_present: false,
      entity_staleness_days: 30,
      corroboration_tier: 'T3',
    });
    expect(score).toBeLessThan(PROMOTION_PROPOSE_THRESHOLD);
    expect(proposed).toBe(false);
  });
});
