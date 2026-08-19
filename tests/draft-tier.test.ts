import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  tierFromDraft,
  lookupAthleteTier,
  tierMarker,
  _setConfigForTesting,
  _setTiersForTesting,
  _setDraftSnapshotForTesting,
  _setSalarySnapshotForTesting,
  type DraftPick,
} from '../src/agents/injury-intelligence/significance.js';

const BAND = { tier_2_max_overall: 32, max_seasons_since_draft: 3 };
const CONFIG = { draft_tiers: { bands: { NFL: { ...BAND } } } } as never;

/** Anchor season is derived as max(class year), so 2026 is "this year". */
function pick(overall: number, year = 2026, round = 1): DraftPick {
  return { year, round, overall };
}
function snapshot(rows: Array<{ name: string; overall: number; year?: number; sport?: string }>) {
  _setDraftSnapshotForTesting(
    rows.map((r) => ({
      full_name: r.name,
      sport: r.sport ?? 'NFL',
      draft: { year: r.year ?? 2026, round: 1, overall: r.overall },
    })) as never,
  );
}

describe('tierFromDraft', () => {
  beforeEach(() => {
    _setConfigForTesting(CONFIG);
    _setTiersForTesting({ athletes: [] } as never);
    _setSalarySnapshotForTesting(null);
    // Anchor the window at 2026.
    snapshot([{ name: 'Anchor Athlete', overall: 1, year: 2026 }]);
  });
  afterEach(() => {
    _setConfigForTesting(null);
    _setTiersForTesting(null);
    _setDraftSnapshotForTesting(null);
    _setSalarySnapshotForTesting(null);
  });

  it('promotes a pick inside the ceiling to tier 2', () => {
    expect(tierFromDraft(pick(1), 'NFL')).toBe(2);
    expect(tierFromDraft(pick(32), 'NFL')).toBe(2);
  });

  it('returns null past the ceiling — never 3, never 4', () => {
    expect(tierFromDraft(pick(33), 'NFL')).toBeNull();
    expect(tierFromDraft(pick(250), 'NFL')).toBeNull();
  });

  it('expires a pick past the recency window — the bust case', () => {
    expect(tierFromDraft(pick(1, 2023), 'NFL')).toBe(2); // 3 seasons: inclusive
    expect(tierFromDraft(pick(1, 2022), 'NFL')).toBeNull(); // 4 seasons: gone
  });

  it('ignores a class from the future', () => {
    expect(tierFromDraft(pick(1, 2027), 'NFL')).toBeNull();
  });

  it('returns null for a sport with no band, no config, or no snapshot', () => {
    expect(tierFromDraft(pick(1), 'NBA')).toBeNull();
    _setConfigForTesting(null);
    expect(tierFromDraft(pick(1), 'NFL')).toBeNull();
    _setConfigForTesting(CONFIG);
    _setDraftSnapshotForTesting(null);
    expect(tierFromDraft(pick(1), 'NFL')).toBeNull();
  });

  it('is promote-only across the whole input space', () => {
    // The invariant, swept rather than sampled.
    for (let overall = 1; overall <= 300; overall += 7) {
      for (let back = 0; back <= 12; back++) {
        const t = tierFromDraft(pick(overall, 2026 - back), 'NFL');
        expect(t === 1 || t === 2 || t === null, `overall=${overall} back=${back}`).toBe(true);
      }
    }
  });

  it('never confers tier 1 under the shipped config', () => {
    // tier_1_max_overall ships absent: tier 1 swaps the BREAKING bar to
    // BREAKING_T1's 45, the loosest in the config, so a false tier 1 is the
    // expensive error. A #1 overall pick is what a team HOPES.
    for (let overall = 1; overall <= 32; overall++) {
      expect(tierFromDraft(pick(overall), 'NFL')).not.toBe(1);
    }
  });

  it('honours tier_1_max_overall when a config does set it', () => {
    _setConfigForTesting({
      draft_tiers: { bands: { NFL: { ...BAND, tier_1_max_overall: 5 } } },
    } as never);
    expect(tierFromDraft(pick(5), 'NFL')).toBe(1);
    expect(tierFromDraft(pick(6), 'NFL')).toBe(2);
  });
});

describe('validateDraftTiers', () => {
  afterEach(() => _setConfigForTesting(null));

  it('drops a band that tries to demote', () => {
    for (const key of ['tier_3_max_overall', 'tier_4_max_overall']) {
      const cfg = { draft_tiers: { bands: { NFL: { ...BAND, [key]: 200 } } } } as never;
      _setConfigForTesting(cfg);
      snapshot([{ name: 'X', overall: 1 }]);
      expect(tierFromDraft(pick(1), 'NFL'), key).toBeNull();
    }
  });

  it('keeps a well-formed band — fail-closed in both directions', () => {
    _setConfigForTesting({ draft_tiers: { bands: { NFL: { ...BAND } } } } as never);
    snapshot([{ name: 'X', overall: 1 }]);
    expect(tierFromDraft(pick(1), 'NFL')).toBe(2);
  });

  it('drops a band whose tier_1 ceiling is not BELOW tier_2 (inverted comparison)', () => {
    _setConfigForTesting({
      draft_tiers: { bands: { NFL: { ...BAND, tier_1_max_overall: 32 } } },
    } as never);
    snapshot([{ name: 'X', overall: 1 }]);
    expect(tierFromDraft(pick(1), 'NFL')).toBeNull();
  });

  it('drops a band with a malformed window or ceiling', () => {
    for (const bad of [
      { tier_2_max_overall: 0, max_seasons_since_draft: 3 },
      { tier_2_max_overall: 32, max_seasons_since_draft: -1 },
      { tier_2_max_overall: Number.NaN, max_seasons_since_draft: 3 },
    ]) {
      _setConfigForTesting({ draft_tiers: { bands: { NFL: bad } } } as never);
      snapshot([{ name: 'X', overall: 1 }]);
      expect(tierFromDraft(pick(1), 'NFL'), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('lookupAthleteTier — draft in the chain', () => {
  beforeEach(() => {
    _setConfigForTesting({
      salary_tiers: { bands: { NFL: { tier_1_min: 25e6, tier_2_min: 8e6 } } },
      draft_tiers: { bands: { NFL: { ...BAND } } },
    } as never);
    _setTiersForTesting({ athletes: [] } as never);
    _setSalarySnapshotForTesting(null);
  });
  afterEach(() => {
    _setConfigForTesting(null);
    _setTiersForTesting(null);
    _setDraftSnapshotForTesting(null);
    _setSalarySnapshotForTesting(null);
  });

  it('promotes an unlisted recent high pick out of the flat default', () => {
    snapshot([{ name: 'Malik Nabers', overall: 6, year: 2024 }, { name: 'A', overall: 1, year: 2026 }]);
    expect(lookupAthleteTier('Malik Nabers', 'NFL')).toEqual({ tier: 2, source: 'draft' });
  });

  it('lets the curated file beat a contradicting draft slot', () => {
    _setTiersForTesting({ athletes: [{ name: 'Bust Guy', sport: 'NFL', tier: 4 }] } as never);
    snapshot([{ name: 'Bust Guy', overall: 1 }]);
    expect(lookupAthleteTier('Bust Guy', 'NFL')).toEqual({ tier: 4, source: 'lookup' });
  });

  it('lets salary beat draft — the newer signal wins', () => {
    _setSalarySnapshotForTesting([
      { full_name: 'Paid Rookie', sport: 'NFL', salary: 30e6 },
    ] as never);
    snapshot([{ name: 'Paid Rookie', overall: 1 }]);
    expect(lookupAthleteTier('Paid Rookie', 'NFL')).toEqual({ tier: 1, source: 'salary' });
  });

  it('returns the pre-feature answer when allowDraft is false', () => {
    snapshot([{ name: 'Malik Nabers', overall: 6, year: 2024 }, { name: 'A', overall: 1, year: 2026 }]);
    expect(lookupAthleteTier('Malik Nabers', 'NFL', { allowDraft: false })).toEqual({
      tier: 3,
      source: 'default',
    });
  });

  it('matches across a generational suffix the draft record lacks', () => {
    // Draft records carry the COLLEGE-era name; pro rosters add the suffix.
    snapshot([{ name: 'Anthony Richardson', overall: 4, year: 2026 }]);
    expect(lookupAthleteTier('Anthony Richardson Sr.', 'NFL').source).toBe('draft');
  });

  it('refuses an ambiguous loose match rather than guessing', () => {
    snapshot([
      { name: 'Marvin Harrison Jr.', overall: 4 },
      { name: 'Marvin Harrison', overall: 5 },
    ]);
    expect(lookupAthleteTier('Marvin Harrison II', 'NFL')).toEqual({
      tier: 3,
      source: 'default',
    });
  });

  it('never takes a same-named athlete draft slot from another league', () => {
    snapshot([{ name: 'Braden Smith', overall: 1, sport: 'NFL' }]);
    expect(lookupAthleteTier('Braden Smith', 'NBA')).toEqual({ tier: 3, source: 'default' });
  });
});

describe('tierMarker', () => {
  it('gives draft its own greppable marker', () => {
    expect(tierMarker('draft')).toBe('^');
    // ...distinct from every other source.
    const all = ['lookup', 'salary', 'club', 'card', 'draft', 'default'] as const;
    const marks = all.map(tierMarker);
    expect(new Set(marks).size).toBeGreaterThanOrEqual(4);
    expect(tierMarker('draft')).not.toBe(tierMarker('salary'));
    expect(tierMarker('draft')).not.toBe(tierMarker('club'));
  });
});
