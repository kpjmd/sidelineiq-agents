/**
 * The team-vs-OTM gap helper.
 *
 * Which of these fail against pre-fix code: ALL of them, because the helper did
 * not exist — the arithmetic was open-coded at six sites in four different
 * shapes. The behavioural claim they pin is narrower than that, and it is the
 * `syn-carryover-inside` and `syn-kittle-total-misread` cases: pre-fix, a team
 * saying "two more weeks" about a 43-week-old ACL was a 43-week conflict, and
 * the pre-fix display would have printed |2 - 52| = 50.
 *
 * The boundary cases (exactly-on-min, exactly-on-max, gap of exactly 2 in each
 * direction) are fail-closed in BOTH directions: they pin that the threshold
 * stays where SKILL.md Rule 5 puts it, not that anything was fixed.
 *
 * Every `source: "live"` case in the fixture was RECORDED from real production
 * rows via `src/scripts/conflict-gap-dryrun.ts --emit-fixture`, never written
 * by hand. Recording rather than hand-writing is the house rule precisely
 * because four earlier bugs in this repo survived a green suite whose fixtures
 * had been written to match the broken code.
 */
import { describe, it, expect } from 'vitest';
import {
  computeConflictGap,
  elapsedWeeksSince,
  isConflict,
  CONFLICT_GAP_HELPER_VERSION,
  CONFLICT_GAP_THRESHOLD_WEEKS,
  type ConflictGapInput,
} from '../src/utils/conflict-gap.js';
import fixture from './fixtures/conflict-gap-cases.json' with { type: 'json' };

interface Case {
  id: string;
  source: string;
  note: string;
  input: ConflictGapInput;
  expected: {
    status: string;
    elapsed_weeks: number | null;
    team_total_weeks: number | null;
    gap_weeks: number;
    is_conflict: boolean;
  };
}

const CASES = (fixture as unknown as { cases: Case[] }).cases;

describe('conflict-gap fixture', () => {
  it('the fixture was recorded against this version of the helper', () => {
    // A one-sided edit to either repo's copy fails here instead of drifting.
    expect((fixture as unknown as { helper_version: number }).helper_version).toBe(
      CONFLICT_GAP_HELPER_VERSION,
    );
  });

  it('carries both synthetic boundaries and recorded live rows', () => {
    expect(CASES.some((c) => c.source === 'synthetic')).toBe(true);
    expect(CASES.some((c) => c.source === 'live')).toBe(true);
  });

  for (const c of CASES) {
    it(`${c.id} — ${c.note}`, () => {
      const gap = computeConflictGap(c.input);
      expect({ ...gap, is_conflict: isConflict(gap) }).toEqual(c.expected);
    });
  }
});

describe('computeConflictGap — the two clocks', () => {
  const window = { min_weeks: 39, max_weeks: 52 };

  it('a carryover inside the window is not a conflict, however large the raw subtraction', () => {
    // The Nick Bosa shape. Pre-fix: |1 - 45.5| = 44.5 > 2 → conflict, and the
    // published cast would have said "Delta: 51+ weeks".
    const gap = computeConflictGap({
      ...window,
      team_timeline_weeks: 1,
      injury_date: '2025-09-21',
      as_of: '2026-09-02',
    });
    expect(gap.status).toBe('inside');
    expect(gap.team_total_weeks).toBe(50);
    expect(isConflict(gap)).toBe(false);
  });

  it('is unchanged by elapsed time on a fresh injury — the population the old code got right', () => {
    const fresh: ConflictGapInput = {
      min_weeks: 6,
      max_weeks: 10,
      team_timeline_weeks: 1,
      injury_date: '2026-09-02',
      as_of: '2026-09-02',
    };
    const gap = computeConflictGap(fresh);
    expect(gap.elapsed_weeks).toBe(0);
    // Elapsed 0 means team-implied total IS the disclosure, so the comparison
    // is the one the pre-fix code was making.
    expect(gap.team_total_weeks).toBe(1);
  });
});

describe('computeConflictGap — no anchor, no verdict', () => {
  const base = { team_timeline_weeks: 2, min_weeks: 39, max_weeks: 52, as_of: '2026-09-02' };

  it.each([
    ['missing', null],
    ['empty', ''],
    ['unparseable', 'not-a-date'],
  ])('%s injury_date yields no_anchor, never elapsed zero', (_label, injury_date) => {
    const gap = computeConflictGap({ ...base, injury_date });
    expect(gap.status).toBe('no_anchor');
    expect(gap.elapsed_weeks).toBeNull();
    expect(isConflict(gap)).toBe(false);
  });

  it('an injury date AFTER as_of is a data error, not elapsed zero', () => {
    // Fails closed. Treating it as zero would silently publish the pre-fix
    // arithmetic under a new name.
    const gap = computeConflictGap({ ...base, injury_date: '2026-12-01' });
    expect(gap.status).toBe('no_anchor');
  });

  it.each([
    ['min_weeks', { min_weeks: null }],
    ['max_weeks', { max_weeks: null }],
  ])('a non-finite %s yields no_anchor', (_label, override) => {
    const gap = computeConflictGap({ ...base, injury_date: '2025-11-02', ...override } as ConflictGapInput);
    expect(gap.status).toBe('no_anchor');
  });

  it('no team disclosure is distinct from no anchor', () => {
    // They mean different things to a reader: "the team said nothing" versus
    // "we do not know when this happened".
    const gap = computeConflictGap({ ...base, team_timeline_weeks: null, injury_date: '2025-11-02' });
    expect(gap.status).toBe('no_timeline');
  });
});

describe('isConflict — SKILL.md Rule 5 threshold', () => {
  it('exactly two weeks outside the window is not a conflict', () => {
    expect(isConflict({ status: 'shorter', elapsed_weeks: 8, team_total_weeks: 8, gap_weeks: -2 })).toBe(false);
    expect(isConflict({ status: 'longer', elapsed_weeks: 8, team_total_weeks: 22, gap_weeks: 2 })).toBe(false);
  });

  it('more than two weeks outside is a conflict in both directions', () => {
    expect(isConflict({ status: 'shorter', elapsed_weeks: 7, team_total_weeks: 7, gap_weeks: -3 })).toBe(true);
    expect(isConflict({ status: 'longer', elapsed_weeks: 8, team_total_weeks: 23, gap_weeks: 3 })).toBe(true);
  });

  it('inside the window is never a conflict, however wide the window', () => {
    expect(isConflict({ status: 'inside', elapsed_weeks: 43, team_total_weeks: 45, gap_weeks: 0 })).toBe(false);
  });

  it('the threshold is the documented two weeks', () => {
    expect(CONFLICT_GAP_THRESHOLD_WEEKS).toBe(2);
  });
});

describe('elapsedWeeksSince', () => {
  it('reads a full ISO timestamp as its date half', () => {
    // Postgres DATE columns arrive through MCP as 'YYYY-MM-DDT00:00:00.000Z'.
    expect(elapsedWeeksSince('2025-11-02T00:00:00.000Z', '2026-09-02')).toBe(
      elapsedWeeksSince('2025-11-02', '2026-09-02'),
    );
  });

  it('accepts a Date as well as a string for as_of', () => {
    expect(elapsedWeeksSince('2026-08-19', new Date('2026-09-02T12:00:00Z'))).toBe(2);
  });

  it('floors to whole weeks so a partial week never rounds up', () => {
    expect(elapsedWeeksSince('2026-08-27', '2026-09-02')).toBe(0);
    expect(elapsedWeeksSince('2026-08-26', '2026-09-02')).toBe(1);
  });
});
