/**
 * The athlete-tiers.json loader guard.
 *
 * Until v3 the tiers file was JSON.parsed straight into the cache with no
 * validation at all, while its sibling significance-config.json got two checks.
 * The file is hand-curated — 219 rows a human edits — so a typo is the expected
 * failure, not an exotic one.
 *
 * The direction matters and is why this exists: a malformed TIER 4 row is a lost
 * SUPPRESSION. That athlete rises to the tier-3 default, where BREAKING becomes
 * scoreable instead of dropped — the file failing quietly UPWARD. A malformed
 * tier-1 row only costs prominence. Both are dropped and logged by name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateTiers } from '../src/agents/injury-intelligence/significance.js';

type DB = Parameters<typeof validateTiers>[0];
const db = (athletes: unknown[]): DB => ({ version: 3, updated_at: 'x', athletes } as DB);

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe('validateTiers', () => {
  it('passes a well-formed file through untouched and says nothing', () => {
    const input = db([
      { name: 'Patrick Mahomes', sport: 'NFL', tier: 1 },
      { name: 'Nick Chubb', sport: 'NFL', tier: 2 },
      { name: 'Some Depth Guy', sport: 'NFL', tier: 4 },
    ]);
    const out = validateTiers(input);
    expect(out.athletes).toHaveLength(3);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('accepts tier 3, even though the file does not normally list it', () => {
    // Tier 3 IS the default, so an explicit tier-3 row is redundant rather than
    // wrong. Dropping it would be a behaviour change dressed as validation.
    const out = validateTiers(db([{ name: 'Explicit Three', sport: 'NBA', tier: 3 }]));
    expect(out.athletes).toHaveLength(1);
  });

  it('drops an out-of-range tier and names the athlete', () => {
    const out = validateTiers(
      db([
        { name: 'Good Row', sport: 'NFL', tier: 1 },
        { name: 'Typo Row', sport: 'NFL', tier: 5 },
      ]),
    );
    expect(out.athletes.map((a) => a.name)).toEqual(['Good Row']);
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('Typo Row');
    // The log must state the consequence, not just the fact.
    expect(logged).toContain('tier-3 default');
  });

  it('drops a tier that arrived as a string, which JSON makes easy to write', () => {
    const out = validateTiers(db([{ name: 'Quoted Tier', sport: 'NFL', tier: '1' }]));
    expect(out.athletes).toHaveLength(0);
  });

  it('drops entries missing a name or a sport', () => {
    const out = validateTiers(
      db([
        { sport: 'NFL', tier: 1 },
        { name: '   ', sport: 'NFL', tier: 1 },
        { name: 'No Sport', tier: 2 },
        { name: 'Fine', sport: 'NBA', tier: 2 },
      ]),
    );
    expect(out.athletes.map((a) => a.name)).toEqual(['Fine']);
  });

  it('keeps every good row when one is bad — a typo costs its own row only', () => {
    // The same bad-row-vs-bad-page split the salary snapshot uses. Rejecting the
    // whole file would demote all 219 athletes at once over one stray comma.
    const rows = Array.from({ length: 50 }, (_, i) => ({
      name: `Athlete ${i}`,
      sport: 'NFL',
      tier: 2,
    }));
    const out = validateTiers(db([...rows, { name: 'Bad', sport: 'NFL', tier: 9 }]));
    expect(out.athletes).toHaveLength(50);
  });

  it('survives a file with no athletes array at all', () => {
    const out = validateTiers({ version: 3, updated_at: 'x' } as unknown as DB);
    expect(out.athletes).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
  });
});
