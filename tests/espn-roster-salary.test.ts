/**
 * ESPN contract-salary extraction.
 *
 * ESPN serves contract data under two different keys and both appear live.
 * Reading only `contract.salary` covers ~62% of NFL and NBA athletes; adding
 * the `contracts[0].salary` fallback lifts that to 68% NFL / 74% NBA. Getting
 * this wrong is silent — every athlete simply reverts to the flat tier-3
 * default with no error anywhere.
 */
import { describe, it, expect } from 'vitest';
import { extractSalary, type ESPNRawAthlete } from '../src/monitoring/sports/espn-base.js';

const athlete = (extra: Partial<ESPNRawAthlete>): ESPNRawAthlete => ({
  id: '1',
  fullName: 'Test Athlete',
  experience: { years: 5 }, // a veteran unless a test says otherwise
  ...extra,
});

describe('extractSalary', () => {
  it('reads the singular contract shape', () => {
    // Saquon Barkley's live shape as of 2026-08-12.
    expect(extractSalary(athlete({ contract: { salary: 16_750_100 } }))).toBe(16_750_100);
  });

  it('falls back to the contracts array', () => {
    // Worth ~6 points of NFL coverage and ~12 of NBA on its own.
    expect(extractSalary(athlete({ contracts: [{ salary: 20_000_000 }] }))).toBe(20_000_000);
  });

  it('prefers the singular shape when both are present', () => {
    expect(
      extractSalary(athlete({ contract: { salary: 30 * 1e6 }, contracts: [{ salary: 1 }] })),
    ).toBe(30 * 1e6);
  });

  it('returns undefined for a soccer athlete, which carries neither key', () => {
    // soccer/eng.1 has 0% contract coverage — the field is absent from the
    // schema entirely, not merely empty. This is why PREMIER_LEAGUE gets no
    // salary bands.
    expect(extractSalary(athlete({}))).toBeUndefined();
  });

  it.each([
    ['an empty contracts array', { contracts: [] }],
    ['a contracts entry with no salary', { contracts: [{}] }],
    ['a zero salary', { contract: { salary: 0 } }],
    ['a negative salary', { contract: { salary: -1 } }],
    ['a null salary', { contract: { salary: null } }],
    ['NaN', { contract: { salary: NaN } }],
  ])('returns undefined for %s', (_label, extra) => {
    expect(extractSalary(athlete(extra as Partial<ESPNRawAthlete>))).toBeUndefined();
  });

  it('refuses a string salary rather than coercing it', () => {
    // "20000000" would coerce fine, but a "$20M" variant coerces to 20 — a
    // salary of twenty dollars, which bands to the flat default and is
    // therefore indistinguishable from "no contract" in every log we have.
    // Failing to read a new shape is recoverable; misreading one is not.
    expect(extractSalary(athlete({ contract: { salary: '20000000' } }))).toBeUndefined();
    expect(extractSalary(athlete({ contract: { salary: '$20M' } }))).toBeUndefined();
  });

  it('survives a malformed athlete without throwing', () => {
    expect(extractSalary(undefined as unknown as ESPNRawAthlete)).toBeUndefined();
    expect(extractSalary({ contracts: 'nope' } as unknown as ESPNRawAthlete)).toBeUndefined();
  });

  it('rounds a fractional salary to whole dollars', () => {
    // The DB column is BIGINT; a float would be silently truncated by pg.
    expect(extractSalary(athlete({ contract: { salary: 1_500_000.6 } }))).toBe(1_500_001);
  });
});

describe('rookies — the unit mismatch the dry-run caught', () => {
  it('refuses a rookie salary, which is a multi-year TOTAL not an annual figure', () => {
    // Fernando Mendoza's live shape: experience 0, salary $38,996,344,
    // yearsRemaining 3, signedThrough 2029. Taken at face value that is a
    // top-of-the-league annual salary and put him in tier 1 ahead of most of
    // the NFL. Five incoming rookies banded to tier 1 this way.
    expect(
      extractSalary(
        athlete({ experience: { years: 0 }, contract: { salary: 38_996_344 } }),
      ),
    ).toBeUndefined();
  });

  it('accepts a first-year veteran — only year ZERO is the rookie case', () => {
    expect(
      extractSalary(athlete({ experience: { years: 1 }, contract: { salary: 20 * 1e6 } })),
    ).toBe(20 * 1e6);
  });

  it('treats a missing experience field as "not a rookie"', () => {
    // Deliberate risk direction: if ESPN stopped sending experience, rejecting
    // would silently disable salary tiers league-wide, which is much worse than
    // re-admitting the ~22 inflated rookies.
    expect(extractSalary({ id: '1', fullName: 'X', contract: { salary: 20 * 1e6 } })).toBe(
      20 * 1e6,
    );
    expect(
      extractSalary({
        id: '1',
        fullName: 'X',
        experience: { years: 'rookie' },
        contract: { salary: 20 * 1e6 },
      } as ESPNRawAthlete),
    ).toBe(20 * 1e6);
  });
});
