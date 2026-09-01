/**
 * Derived athlete tiers for the sports salary cannot reach.
 *
 * PREMIER_LEAGUE has no contract data on ESPN at all and UFC has neither pay
 * nor a roster, so before this every athlete in both resolved
 * {tier: 3, source: 'default'} — which meant ALL their TRACKING was
 * tier-blocked and every concussion event was dropped. Club (PL) and card
 * position (UFC) are the prominence signals those sports actually publish.
 *
 * The invariant every test here exists to protect is the one salary-tier.test.ts
 * protects: a derived signal can only ever PROMOTE. If any of these fail by
 * producing a tier WORSE than 3, the change has started removing coverage. Tier
 * 4 is the specific hazard — it sits above thresholds.default.max_tier, so a
 * derived 4 would not reprioritise an athlete, it would drop their BREAKING.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  lookupAthleteTier,
  tierFromDerived,
  tierMarker,
  computeSignificance,
  loadSignificanceData,
  getLoadedConfig,
  _setConfigForTesting,
  _setTiersForTesting,
  _setSalarySnapshotForTesting,
  _setDerivedSnapshotForTesting,
  type DerivedRow,
} from '../src/agents/injury-intelligence/significance.js';
import type { SportKey } from '../src/types.js';

const M = 1_000_000;

const TIERS = {
  version: 4,
  updated_at: '2026-08-15',
  athletes: [
    { name: 'Mohamed Salah', sport: 'PREMIER_LEAGUE', tier: 1 },
    { name: 'Ollie Watkins', sport: 'PREMIER_LEAGUE', tier: 2 },
    { name: 'A.J. Brown', sport: 'NFL', tier: 1 },
  ],
};

const CONFIG = {
  version: 3,
  thresholds: {
    default: { process: 60, defer: 35, max_tier: 3 },
    BREAKING_T1: { process: 45, defer: 30 },
    TRACKING: { process: 65, defer: 40, require_tier_1_or_2: true },
    DEEP_DIVE: { process: 40, defer: 25 },
    CONFLICT_FLAG: { always_process: true },
  },
  sport_seasons: {},
  default_threshold_delta: 0,
  salary_tiers: { bands: { NFL: { tier_1_min: 25 * M, tier_2_min: 8 * M } } },
  derived_tiers: {
    PREMIER_LEAGUE: {
      kind: 'club' as const,
      tier_2_clubs: [
        { espn_team_id: '359', name: 'Arsenal' },
        { espn_team_id: '364', name: 'Liverpool' },
      ],
    },
    UFC: {
      kind: 'card' as const,
      window_days_back: 180,
      window_days_forward: 90,
      slot_tiers: {
        champion: 1,
        ppv_main_event: 1,
        ppv_co_main: 2,
        ppv_main_card: 2,
        fight_night_main_event: 2,
        fight_night_co_main: 2,
      },
    },
  },
  concussion: { require_tier_1_or_2: true },
  defer: { ttl_hours: 48, promotion_cap: 3, corroboration_discount_per_source: 10, corroboration_discount_max: 20 },
};

const club = (name: string, espn_team_id: string, team_name?: string): DerivedRow => ({
  full_name: name,
  sport: 'PREMIER_LEAGUE',
  signal: { kind: 'club', espn_team_id, team_name },
});
const card = (name: string, slot: 'champion' | 'ppv_main_event' | 'ppv_co_main' | 'ppv_main_card' | 'fight_night_main_event' | 'fight_night_co_main'): DerivedRow => ({
  full_name: name,
  sport: 'UFC',
  signal: { kind: 'card', slot, event_name: 'UFC 330', event_date: '2026-08-15T21:30Z' },
});

const SNAPSHOT: DerivedRow[] = [
  club('Bukayo Saka', '359', 'Arsenal'),
  club('Mohamed Salah', '364', 'Liverpool'),
  club('Ollie Watkins', '362', 'Aston Villa'), // not a listed club
  club('Jordan Pickford', '368', 'Everton'),   // not a listed club
  card('Islam Makhachev', 'champion'),
  card('Ian Machado Garry', 'ppv_main_event'),
  card('Mackenzie Dern', 'ppv_co_main'),
  card('Jeremiah Wells', 'fight_night_co_main'),
];

beforeEach(() => {
  _setConfigForTesting(structuredClone(CONFIG) as never);
  _setTiersForTesting(structuredClone(TIERS) as never);
  _setDerivedSnapshotForTesting(SNAPSHOT);
  _setSalarySnapshotForTesting(null);
});

afterEach(() => {
  _setConfigForTesting(null);
  _setTiersForTesting(null);
  _setDerivedSnapshotForTesting(null);
  _setSalarySnapshotForTesting(null);
});

describe('tierFromDerived — promote-only', () => {
  it('promotes a listed club to tier 2', () => {
    expect(tierFromDerived({ kind: 'club', espn_team_id: '359' }, 'PREMIER_LEAGUE')).toBe(2);
  });

  it('never promotes a club to tier 1 — that stays hand-curated', () => {
    // Tier 1 swaps the BREAKING bar to BREAKING_T1's 45, the loosest in the
    // config. "Plays for Arsenal" is as true of the academy goalkeeper as of
    // Saka, so a club must not be able to buy that bar.
    for (const id of ['359', '364']) {
      expect(tierFromDerived({ kind: 'club', espn_team_id: id }, 'PREMIER_LEAGUE')).not.toBe(1);
    }
  });

  it('returns null for an unlisted club rather than demoting', () => {
    expect(tierFromDerived({ kind: 'club', espn_team_id: '362' }, 'PREMIER_LEAGUE')).toBeNull();
  });

  it('maps card slots to their configured tiers', () => {
    const cases: Array<[string, number | null]> = [
      ['champion', 1],
      ['ppv_main_event', 1],
      ['ppv_co_main', 2],
      ['ppv_main_card', 2],
      ['fight_night_main_event', 2],
      ['fight_night_co_main', 2],
    ];
    for (const [slot, expected] of cases) {
      expect(
        tierFromDerived({ kind: 'card', slot: slot as never, event_name: 'x', event_date: '' }, 'UFC'),
      ).toBe(expected);
    }
  });

  it.each<SportKey>(['NFL', 'NBA'])('never derives a tier in %s — no derived config', (sport) => {
    expect(tierFromDerived({ kind: 'club', espn_team_id: '359' }, sport)).toBeNull();
  });

  it('refuses when the snapshot and the config disagree about the signal kind', () => {
    // A config edit that landed without a snapshot refresh. Guessing would mean
    // reading a club id as a card slot.
    expect(
      tierFromDerived({ kind: 'card', slot: 'champion', event_name: 'x', event_date: '' }, 'PREMIER_LEAGUE'),
    ).toBeNull();
    expect(tierFromDerived({ kind: 'club', espn_team_id: '359' }, 'UFC')).toBeNull();
  });

  it('never promotes when no config is loaded at all', () => {
    _setConfigForTesting(null);
    expect(tierFromDerived({ kind: 'club', espn_team_id: '359' }, 'PREMIER_LEAGUE')).toBeNull();
  });
});

describe('validateDerivedTiers drops what would demote', () => {
  const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  afterEach(() => warn.mockClear());

  it('drops a slot mapped to tier 4 and keeps the rest', () => {
    const cfg = structuredClone(CONFIG) as never as typeof CONFIG;
    (cfg.derived_tiers.UFC.slot_tiers as Record<string, number>).ppv_co_main = 4;
    _setConfigForTesting(cfg as never);

    expect(
      tierFromDerived({ kind: 'card', slot: 'ppv_co_main', event_name: 'x', event_date: '' }, 'UFC'),
    ).toBeNull();
    expect(
      tierFromDerived({ kind: 'card', slot: 'champion', event_name: 'x', event_date: '' }, 'UFC'),
    ).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('remove coverage'));
  });

  it('drops a slot mapped to tier 3 — the default, spelled twice', () => {
    const cfg = structuredClone(CONFIG) as never as typeof CONFIG;
    (cfg.derived_tiers.UFC.slot_tiers as Record<string, number>).champion = 3;
    _setConfigForTesting(cfg as never);
    expect(
      tierFromDerived({ kind: 'card', slot: 'champion', event_name: 'x', event_date: '' }, 'UFC'),
    ).toBeNull();
  });

  it('drops a club entry with no espn_team_id — the name is not the key', () => {
    const cfg = structuredClone(CONFIG) as never as typeof CONFIG;
    cfg.derived_tiers.PREMIER_LEAGUE.tier_2_clubs = [{ name: 'Arsenal' } as never];
    _setConfigForTesting(cfg as never);
    expect(tierFromDerived({ kind: 'club', espn_team_id: '359' }, 'PREMIER_LEAGUE')).toBeNull();
  });
});

describe('lookupAthleteTier with derived signals', () => {
  it('promotes an unlisted big-six player to tier 2, sourced as club', () => {
    expect(lookupAthleteTier('Bukayo Saka', 'PREMIER_LEAGUE')).toEqual({ tier: 2, source: 'club' });
  });

  it('promotes a UFC main-eventer to tier 1, sourced as card', () => {
    expect(lookupAthleteTier('Islam Makhachev', 'UFC')).toEqual({ tier: 1, source: 'card' });
  });

  it('leaves an unlisted player at a non-listed club on the default', () => {
    expect(lookupAthleteTier('Jordan Pickford', 'PREMIER_LEAGUE')).toEqual({ tier: 3, source: 'default' });
  });

  it('the curated file is a FLOOR — a listed tier 1 is not capped to his clubs tier 2', () => {
    expect(lookupAthleteTier('Mohamed Salah', 'PREMIER_LEAGUE')).toEqual({ tier: 1, source: 'lookup' });
  });

  it('the curated file also lifts a star at an unlisted club', () => {
    // Ollie Watkins is at Aston Villa, which derives nothing. Without his entry
    // he would be tier 3 and all his TRACKING would be blocked.
    expect(lookupAthleteTier('Ollie Watkins', 'PREMIER_LEAGUE')).toEqual({ tier: 2, source: 'lookup' });
  });

  it('is sport-scoped — a PL club row never answers a UFC or NFL question', () => {
    _setDerivedSnapshotForTesting([club('Braden Smith', '359', 'Arsenal')]);
    expect(lookupAthleteTier('Braden Smith', 'UFC').source).toBe('default');
    expect(lookupAthleteTier('Braden Smith', 'NFL').source).toBe('default');
    expect(lookupAthleteTier('Braden Smith', 'PREMIER_LEAGUE')).toEqual({ tier: 2, source: 'club' });
  });

  it('refuses to resolve a name held by two players in the same sport', () => {
    // Two different people, not one athlete indexed twice — the Braden Smith
    // failure in a league whose squads genuinely contain repeated names.
    _setDerivedSnapshotForTesting([
      club('Danny Ward', '359', 'Arsenal'),
      club('Danny Ward', '368', 'Everton'),
    ]);
    expect(lookupAthleteTier('Danny Ward', 'PREMIER_LEAGUE').source).toBe('default');
  });

  it('resolves punctuation and suffix variants like the other lookups', () => {
    _setDerivedSnapshotForTesting([club('Alexis Mac Allister', '364', 'Liverpool')]);
    expect(lookupAthleteTier('Alexis MacAllister', 'PREMIER_LEAGUE').tier).toBe(2);
  });

  it('leaves NFL and NBA untouched when a derived snapshot is installed', () => {
    _setSalarySnapshotForTesting([{ full_name: 'Saquon Barkley', sport: 'NFL', salary: 16.75 * M }]);
    expect(lookupAthleteTier('Saquon Barkley', 'NFL')).toEqual({ tier: 2, source: 'salary' });
    expect(lookupAthleteTier('Some Depth Player', 'NFL')).toEqual({ tier: 3, source: 'default' });
    expect(lookupAthleteTier('A.J. Brown', 'NFL')).toEqual({ tier: 1, source: 'lookup' });
  });

  it('honours allowDerived:false, so a before/after model can ask for the old answer', () => {
    expect(lookupAthleteTier('Bukayo Saka', 'PREMIER_LEAGUE', { allowDerived: false })).toEqual({
      tier: 3,
      source: 'default',
    });
  });

  it('behaves exactly as before when no snapshot is installed', () => {
    _setDerivedSnapshotForTesting(null);
    expect(lookupAthleteTier('Bukayo Saka', 'PREMIER_LEAGUE')).toEqual({ tier: 3, source: 'default' });
    expect(lookupAthleteTier('Islam Makhachev', 'UFC')).toEqual({ tier: 3, source: 'default' });
  });

  it('money is consulted before club or card when a sport somehow has both', () => {
    const cfg = structuredClone(CONFIG) as never as typeof CONFIG;
    (cfg.salary_tiers.bands as Record<string, unknown>).PREMIER_LEAGUE = {
      tier_1_min: 20 * M,
      tier_2_min: 5 * M,
    };
    _setConfigForTesting(cfg as never);
    _setSalarySnapshotForTesting([{ full_name: 'Bukayo Saka', sport: 'PREMIER_LEAGUE', salary: 25 * M }]);

    expect(lookupAthleteTier('Bukayo Saka', 'PREMIER_LEAGUE')).toEqual({ tier: 1, source: 'salary' });
  });
});

describe('the derived tier is visible wherever a tier is logged', () => {
  it('marks club and card tiers as inferred, distinctly from salary and default', () => {
    expect(tierMarker('lookup')).toBe('');
    expect(tierMarker('salary')).toBe('~');
    expect(tierMarker('club')).toBe('+');
    expect(tierMarker('card')).toBe('+');
    expect(tierMarker('default')).toBe('?');
  });

  it('carries the marker into the significance rationale', () => {
    const sig = computeSignificance(
      2,
      'club',
      { information_specificity: 70, event_recency_novelty: 80 },
      'BREAKING',
      'PREMIER_LEAGUE',
      new Date('2026-08-22T12:00:00Z'),
    );
    expect(sig.rationale).toContain('tier=2+');
    expect(sig.athlete_tier_source).toBe('club');
  });
});

describe('the shipped config', () => {
  beforeEach(async () => {
    await loadSignificanceData();
  });

  it('gives PREMIER_LEAGUE a club provider and UFC a card provider', () => {
    const derived = getLoadedConfig()?.derived_tiers;
    expect(derived?.PREMIER_LEAGUE?.kind).toBe('club');
    expect(derived?.UFC?.kind).toBe('card');
  });

  it('gives NFL and NBA no derived provider — they have salary', () => {
    const derived = getLoadedConfig()?.derived_tiers;
    expect(derived).not.toHaveProperty('NFL');
    expect(derived).not.toHaveProperty('NBA');
  });

  it('maps no club and no slot to a tier that would remove coverage', () => {
    const derived = getLoadedConfig()?.derived_tiers;
    const ufc = derived?.UFC;
    if (ufc?.kind !== 'card') throw new Error('UFC provider is not card-based');
    for (const tier of Object.values(ufc.slot_tiers ?? {})) {
      expect([1, 2]).toContain(tier);
    }
  });

  it('lists every tier-2 club with an espn_team_id', () => {
    const pl = getLoadedConfig()?.derived_tiers?.PREMIER_LEAGUE;
    if (pl?.kind !== 'club') throw new Error('PL provider is not club-based');
    expect(pl.tier_2_clubs?.length).toBeGreaterThan(0);
    for (const c of pl.tier_2_clubs ?? []) expect(c.espn_team_id).toMatch(/^\d+$/);
  });
});
