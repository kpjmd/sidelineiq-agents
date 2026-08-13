/**
 * Salary-derived athlete tiers.
 *
 * lookupAthleteTier returned tier 3 for every athlete absent from
 * athlete-tiers.json, so "tier 3" was not a statement about an athlete but the
 * absence of one — A.J. Brown and a practice-squad receiver scored identically
 * on prominence, which is 35% of the composite. Salary supplies a DEFAULT for
 * the unlisted; the override file stays authoritative.
 *
 * The invariant every test here exists to protect: salary can only ever
 * PROMOTE. If any of these fail by producing a tier WORSE than 3, the change
 * has started removing coverage that publishes today.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  lookupAthleteTier,
  tierFromSalary,
  loadSignificanceData,
  getLoadedConfig,
  _setConfigForTesting,
  _setTiersForTesting,
  _setSalarySnapshotForTesting,
} from '../src/agents/injury-intelligence/significance.js';
import type { SportKey } from '../src/types.js';

const M = 1_000_000;

// A minimal override file: the salary layer only runs for athletes NOT in here.
const TIERS = {
  version: 2,
  updated_at: '2026-08-12',
  athletes: [
    { name: 'Luther Burden III', team: 'Bears', sport: 'NFL', tier: 1 },
    { name: 'Kristian Wilkerson', team: 'Patriots', sport: 'NFL', tier: 4 },
  ],
};

// Mirrors the shipped bands closely enough to exercise the boundaries.
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
  salary_tiers: {
    currency: 'USD',
    bands: {
      NFL: { tier_1_min: 25 * M, tier_2_min: 8 * M },
      NBA: { tier_1_min: 45 * M, tier_2_min: 15 * M },
    },
  },
  defer: {
    ttl_hours: 6,
    promotion_cap: 3,
    corroboration_bonus_per_source: 5,
    corroboration_bonus_max: 20,
  },
};

type ConfigArg = Parameters<typeof _setConfigForTesting>[0];
type TiersArg = Parameters<typeof _setTiersForTesting>[0];

function salaried(rows: Array<[string, SportKey, number]>) {
  return rows.map(([full_name, sport, salary]) => ({ full_name, sport, salary }));
}

beforeEach(() => {
  _setTiersForTesting(TIERS as TiersArg);
  _setConfigForTesting(CONFIG as ConfigArg);
  _setSalarySnapshotForTesting(null);
});

afterEach(() => {
  _setSalarySnapshotForTesting(null);
});

describe('tierFromSalary — band mapping', () => {
  it.each([
    [25 * M, 1], // exactly at the floor is inside the band (>=)
    [40 * M, 1],
    [25 * M - 1, 2], // one dollar below tier 1
    [8 * M, 2],
    [8 * M - 1, null], // one dollar below tier 2
    [1 * M, null],
  ])('maps an NFL salary of %d to %s', (salary, expected) => {
    expect(tierFromSalary(salary, 'NFL')).toBe(expected);
  });

  it('applies each sport its own bands — cap structures differ enormously', () => {
    // $30M is a tier-1 NFL salary and only a tier-2 NBA one; $10M is a solid
    // NFL tier 2 and does not clear tier 2 in the NBA at all.
    expect(tierFromSalary(30 * M, 'NFL')).toBe(1);
    expect(tierFromSalary(30 * M, 'NBA')).toBe(2);
    expect(tierFromSalary(10 * M, 'NFL')).toBe(2);
    expect(tierFromSalary(10 * M, 'NBA')).toBeNull();
  });

  it.each([[0], [-1], [NaN], [Infinity], [null], [undefined]])(
    'refuses to promote on a salary of %s',
    (salary) => {
      expect(tierFromSalary(salary as number, 'NFL')).toBeNull();
    },
  );

  it.each<SportKey>(['PREMIER_LEAGUE', 'UFC'])(
    'never promotes in %s — no bands are configured',
    (sport) => {
      // ESPN's soccer roster carries no contract field at all, and UFC fighters
      // are not team-rostered. Absence from the config is the encoding of that.
      expect(tierFromSalary(50 * M, sport)).toBeNull();
    },
  );

  it('never promotes when no config is loaded at all', () => {
    _setConfigForTesting(null);
    expect(tierFromSalary(100 * M, 'NFL')).toBeNull();
  });
});

describe('the promote-only invariant', () => {
  // The single most important property in this feature. tierFromSalary's return
  // type makes tier 3 and 4 unrepresentable, so this sweep is really asserting
  // that the SHIPPED config cannot produce a surprise through some band shape.
  it('never yields anything but 1, 2 or null across the whole salary range', async () => {
    await loadSignificanceData(); // the REAL data file, not the fixture above
    const sports = ['NFL', 'NBA', 'PREMIER_LEAGUE', 'UFC'] as SportKey[];
    for (const sport of sports) {
      for (let salary = 0; salary <= 100 * M; salary += 250_000) {
        const tier = tierFromSalary(salary, sport);
        expect([1, 2, null]).toContain(tier);
      }
    }
  });

  it('drops a band that tries to name tier 3 or 4 rather than honouring it', async () => {
    // A band naming tier 4 is someone trying to make salary DEMOTE. Config
    // validation drops the whole sport, degrading to the flat default — the
    // safe direction — rather than half-applying it.
    const poisoned = {
      ...CONFIG,
      salary_tiers: {
        bands: {
          NFL: { tier_1_min: 25 * M, tier_2_min: 8 * M, tier_4_min: 1 * M },
          NBA: { tier_1_min: 45 * M, tier_2_min: 15 * M },
        },
      },
    };
    _setConfigForTesting(poisoned as ConfigArg);
    _setSalarySnapshotForTesting(salaried([['Depth Guy', 'NFL', 500_000]]));

    // The whole NFL band is gone, so nothing NFL is promoted...
    expect(tierFromSalary(30 * M, 'NFL')).toBeNull();
    expect(lookupAthleteTier('Depth Guy', 'NFL')).toEqual({ tier: 3, source: 'default' });
    // ...and the valid NBA band is untouched. One bad sport must not take the
    // rest of the file down with it.
    expect(tierFromSalary(50 * M, 'NBA')).toBe(1);
  });

  it.each([
    ['tier_1_min <= tier_2_min', { tier_1_min: 5 * M, tier_2_min: 8 * M }],
    ['a negative floor', { tier_1_min: 25 * M, tier_2_min: -1 }],
    ['a non-numeric floor', { tier_1_min: 25 * M, tier_2_min: 'lots' }],
  ])('drops a band with %s', (_label, band) => {
    _setConfigForTesting({
      ...CONFIG,
      salary_tiers: { bands: { NFL: band } },
    } as unknown as ConfigArg);
    expect(tierFromSalary(30 * M, 'NFL')).toBeNull();
  });
});

describe('lookupAthleteTier — precedence', () => {
  it('promotes an unlisted athlete out of the flat default', () => {
    // The case the whole feature exists for. A.J. Brown is paid $29.0M and was
    // resolving to tier 3 purely because nobody had added him to the file.
    _setSalarySnapshotForTesting(salaried([['A.J. Brown', 'NFL', 29 * M]]));
    expect(lookupAthleteTier('A.J. Brown', 'NFL')).toEqual({ tier: 1, source: 'salary' });
  });

  it('lets the override file beat a contradicting salary — the rookie case', () => {
    // Luther Burden III is a first-round pick on a rookie deal worth $1.34M,
    // which bands to nothing. Salary measures market value, not fame, and this
    // is exactly the failure mode the override list exists to absorb.
    _setSalarySnapshotForTesting(salaried([['Luther Burden III', 'NFL', 1.34 * M]]));
    expect(lookupAthleteTier('Luther Burden III', 'NFL')).toEqual({ tier: 1, source: 'lookup' });
  });

  it('lets an override tier 4 stand against a huge salary', () => {
    // Tier 4 is a deliberate editorial deprioritisation. Salary must not undo
    // it, and — since tierFromSalary cannot return 4 — salary can never create
    // one either.
    _setSalarySnapshotForTesting(salaried([['Kristian Wilkerson', 'NFL', 50 * M]]));
    expect(lookupAthleteTier('Kristian Wilkerson', 'NFL')).toEqual({ tier: 4, source: 'lookup' });
  });

  it('falls through to the flat default when the salary clears no band', () => {
    _setSalarySnapshotForTesting(salaried([['Depth Guy', 'NFL', 1.1 * M]]));
    expect(lookupAthleteTier('Depth Guy', 'NFL')).toEqual({ tier: 3, source: 'default' });
  });

  it('falls through when the athlete has no salary row at all', () => {
    // ~32% of NFL and ~26% of NBA rostered athletes have no ESPN contract.
    _setSalarySnapshotForTesting(salaried([['Someone Else', 'NFL', 30 * M]]));
    expect(lookupAthleteTier('Unsalaried Guy', 'NFL')).toEqual({ tier: 3, source: 'default' });
  });

  it('can be switched off per call, for before/after modelling', () => {
    _setSalarySnapshotForTesting(salaried([['A.J. Brown', 'NFL', 29 * M]]));
    expect(lookupAthleteTier('A.J. Brown', 'NFL', { allowSalary: false })).toEqual({
      tier: 3,
      source: 'default',
    });
  });
});

describe('lookupAthleteTier — name matching', () => {
  it.each([
    ['AJ Brown'],
    ['A J Brown'],
    ['a.j. brown'],
  ])('resolves %j against a snapshot spelled "A.J. Brown"', (queried) => {
    // Reuses normalizeText/looseNameKey rather than a third normalizer. Two
    // places answering "is this the same athlete?" differently is the defect
    // that made the drift check and the tier lookup disagree once already.
    _setSalarySnapshotForTesting(salaried([['A.J. Brown', 'NFL', 29 * M]]));
    expect(lookupAthleteTier(queried, 'NFL').tier).toBe(1);
  });

  it('matches across generational suffixes', () => {
    _setSalarySnapshotForTesting(salaried([['Jaren Jackson Jr.', 'NBA', 49 * M]]));
    expect(lookupAthleteTier('Jaren Jackson Jr', 'NBA')).toEqual({ tier: 1, source: 'salary' });
  });

  it('refuses an AMBIGUOUS loose match rather than guessing', () => {
    // Marvin Harrison Jr. and Marvin Harrison are father and son. Stripping the
    // suffix merges them; promoting on a coin flip is worse than not knowing.
    _setSalarySnapshotForTesting(
      salaried([
        ['Marvin Harrison Jr.', 'NFL', 30 * M],
        ['Marvin Harrison', 'NFL', 1 * M],
      ]),
    );
    expect(lookupAthleteTier('Marvin Harrison Junior', 'NFL')).toEqual({
      tier: 3,
      source: 'default',
    });
  });

  it('refuses an ambiguous EXACT match too, unlike the override path', () => {
    // The deliberate asymmetry. athlete-tiers.json is 219 hand-curated rows
    // where an exact duplicate is a curation bug a human would notice; this
    // snapshot is ~3,500 machine-generated rows where it is genuinely two
    // different people. First-wins here would promote the wrong athlete.
    _setSalarySnapshotForTesting(
      salaried([
        ['John Smith', 'NFL', 30 * M],
        ['John Smith', 'NFL', 900_000],
      ]),
    );
    expect(lookupAthleteTier('John Smith', 'NFL')).toEqual({ tier: 3, source: 'default' });
  });

  it('never takes a same-named athlete\'s salary from another league', () => {
    // THIS ASSERTION IS THE REVERSE OF THE ONE IT REPLACES, deliberately. The
    // lookup used to fall back to an any-sport key and band the hit by the
    // MATCHED row's sport, which read as principled and was not.
    //
    // Braden Smith, live in production: the NBA one is rostered, has no NBA
    // salary and no athlete-tiers.json entry; the NFL Colts tackle of the same
    // name was therefore the only salaried "Braden Smith" in the index. The
    // uniqueness guard saw count === 1, the fallback resolved, and an NBA
    // player was promoted to tier 2 on another man's contract.
    //
    // Sport-scoping is the fix. It costs nothing real: every polled event's
    // sport is a hardcoded per-source constant, and the index is built per
    // sport from a sport-filtered query, so a sport-scoped hit is exact by
    // construction. See lookupSalaryRow.
    _setSalarySnapshotForTesting(salaried([['Braden Smith', 'NFL', 20 * M]]));
    expect(lookupAthleteTier('Braden Smith', 'NBA')).toEqual({ tier: 3, source: 'default' });
    // ...while the athlete the salary actually belongs to is unaffected.
    expect(lookupAthleteTier('Braden Smith', 'NFL')).toEqual({ tier: 2, source: 'salary' });
  });

  it('does not promote when the matched row\'s sport has no bands', () => {
    // Queried as PREMIER_LEAGUE, not NFL. Under the old any-sport fallback the
    // NFL spelling was the only way to reach tierFromSalary's band check at
    // all; now a cross-sport query is refused earlier, so asking it that way
    // would pass for the wrong reason and stop testing the band rule.
    _setSalarySnapshotForTesting(salaried([['Soccer Guy', 'PREMIER_LEAGUE', 50 * M]]));
    expect(lookupAthleteTier('Soccer Guy', 'PREMIER_LEAGUE')).toEqual({
      tier: 3,
      source: 'default',
    });
  });

  it('leaves PREMIER_LEAGUE and UFC athletes on the flat default', () => {
    // The exposure sport-scoping closes wholesale. Neither league has a row in
    // this index (salary-snapshot only pages NFL and NBA), and neither has a
    // single entry in athlete-tiers.json to shadow a bad hit — so every salary
    // tier those sports could ever have received was an NFL/NBA
    // misattribution, in a lookup whose bands deliberately say those sports
    // have no salary signal.
    _setSalarySnapshotForTesting(
      salaried([
        ['Marcus Rashford', 'NFL', 40 * M],
        ['Conor McGregor', 'NBA', 50 * M],
      ]),
    );
    expect(lookupAthleteTier('Marcus Rashford', 'PREMIER_LEAGUE')).toEqual({
      tier: 3,
      source: 'default',
    });
    expect(lookupAthleteTier('Conor McGregor', 'UFC')).toEqual({ tier: 3, source: 'default' });
  });
});

describe('graceful degradation', () => {
  const names: Array<[string, SportKey]> = [
    ['A.J. Brown', 'NFL'],
    ['Luther Burden III', 'NFL'],
    ['Nobody At All', 'NBA'],
    ['Kristian Wilkerson', 'NFL'],
  ];

  it('behaves identically with a null snapshot and an empty one', () => {
    _setSalarySnapshotForTesting(null);
    const withNull = names.map(([n, s]) => lookupAthleteTier(n, s));
    _setSalarySnapshotForTesting([]);
    const withEmpty = names.map(([n, s]) => lookupAthleteTier(n, s));

    expect(withEmpty).toEqual(withNull);
    // And specifically: nothing resolves via salary, so this is the exact
    // pre-feature behaviour. A failed snapshot load must cost nothing but the
    // promotions it would have added.
    expect(withNull.every((r) => r.source !== 'salary')).toBe(true);
  });

  it('ignores malformed snapshot rows without losing the good ones', () => {
    _setSalarySnapshotForTesting([
      { full_name: '', sport: 'NFL', salary: 30 * M },
      { full_name: 'No Salary Guy', sport: 'NFL', salary: 0 },
      { full_name: 'Good Guy', sport: 'NFL', salary: 30 * M },
    ] as Parameters<typeof _setSalarySnapshotForTesting>[0]);

    expect(lookupAthleteTier('Good Guy', 'NFL')).toEqual({ tier: 1, source: 'salary' });
    expect(lookupAthleteTier('No Salary Guy', 'NFL')).toEqual({ tier: 3, source: 'default' });
  });
});

describe('the shipped config', () => {
  beforeEach(async () => {
    await loadSignificanceData();
  });

  it('pins the shipped band values', () => {
    // Calibrated against live rosters on 2026-08-12: the tier-1 floors sit at
    // roughly the hand-curated tier-1 MEDIAN for each sport ($26.0M NFL,
    // $50.1M NBA), so salary alone promotes to tier 1 only at the level of a
    // median hand-picked star. That matters because tier 1 also swaps the
    // BREAKING bar from 60 to BREAKING_T1's 45 — the loosest in the config.
    // Retuning is expected; doing it accidentally is not.
    expect(getLoadedConfig()?.salary_tiers?.bands).toEqual({
      NFL: { tier_1_min: 25_000_000, tier_2_min: 8_000_000 },
      NBA: { tier_1_min: 45_000_000, tier_2_min: 15_000_000 },
    });
  });

  it('configures no bands for PREMIER_LEAGUE or UFC', () => {
    const bands = getLoadedConfig()?.salary_tiers?.bands ?? {};
    expect(bands).not.toHaveProperty('PREMIER_LEAGUE');
    expect(bands).not.toHaveProperty('UFC');
  });

  it('names no tier_3_min or tier_4_min anywhere', () => {
    const bands = getLoadedConfig()?.salary_tiers?.bands ?? {};
    for (const band of Object.values(bands)) {
      expect(Object.keys(band).filter((k) => /^tier_[34]_min$/.test(k))).toEqual([]);
    }
  });
});
