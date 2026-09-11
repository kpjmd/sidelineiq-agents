import { describe, it, expect } from 'vitest';
import {
  CONFIDENCE_RUBRIC_SINCE,
  rowsCreatedBetween,
  identicalConfidenceShare,
} from '../src/scripts/md-confidence-dryrun.js';
import corpus from './fixtures/post-confidence-corpus.json' with { type: 'json' };

/**
 * Section F of md-confidence-dryrun.ts compares the share of new posts whose two
 * confidences are byte-identical — PR #30's symptom — against a baseline. The
 * baseline used to be every row before --since, which is mostly the defect PR
 * #30 fixed. The first acceptance run printed "in-window 1/2 vs baseline 31.5%"
 * when the honest comparison was 3.3%.
 *
 * The fixture is every live injury_posts row, recorded 2026-09-11, so these
 * assertions are the old-vs-new diff over real data, frozen.
 */
type Row = { id: string; created_at: string; md_review_confidence: string | null; rtp_confidence: string | null };
const rows = (corpus as unknown as { rows: Row[] }).rows;

/** When the first post-deploy acceptance run was scored from. */
const SINCE = Date.parse('2026-09-10T21:11:54Z');
const RUBRIC = Date.parse(CONFIDENCE_RUBRIC_SINCE);

describe('section F baseline window', () => {
  it('starts at PR #30, not at the beginning of the table', () => {
    const baseline = rowsCreatedBetween(rows, RUBRIC, SINCE);
    expect(identicalConfidenceShare(baseline)).toEqual({ same: 2, withBoth: 61 });
  });

  it('keeps the pre-rubric history out of the comparison', () => {
    const history = rowsCreatedBetween(rows, -Infinity, RUBRIC);
    // The defect itself: 38% of rows carrying both numbers had them identical.
    expect(identicalConfidenceShare(history)).toEqual({ same: 100, withBoth: 263 });
  });

  it('partitions the old baseline exactly — nothing lost, nothing counted twice', () => {
    // What the old code compared against: everything before --since.
    const old = identicalConfidenceShare(rowsCreatedBetween(rows, -Infinity, SINCE));
    expect(old).toEqual({ same: 102, withBoth: 324 });

    const a = identicalConfidenceShare(rowsCreatedBetween(rows, -Infinity, RUBRIC));
    const b = identicalConfidenceShare(rowsCreatedBetween(rows, RUBRIC, SINCE));
    expect(a.same + b.same).toBe(old.same);
    expect(a.withBoth + b.withBoth).toBe(old.withBoth);
  });

  it('never lets the in-window rows into the baseline', () => {
    const inWindow = rowsCreatedBetween(rows, SINCE, Infinity);
    const baseline = new Set(rowsCreatedBetween(rows, RUBRIC, SINCE).map((r) => r.id));
    expect(inWindow.length).toBeGreaterThan(0);
    expect(inWindow.filter((r) => baseline.has(r.id))).toEqual([]);
  });
});

describe('rowsCreatedBetween', () => {
  // A real row's own timestamp as the boundary, so the edges are tested on the
  // exact string shape the database returns.
  const pivot = rows[Math.floor(rows.length / 2)];
  const at = Date.parse(pivot.created_at);

  it('includes the lower bound', () => {
    expect(rowsCreatedBetween([pivot], at, at + 1)).toEqual([pivot]);
  });

  it('excludes the upper bound', () => {
    expect(rowsCreatedBetween([pivot], at - 1, at)).toEqual([]);
  });

  it('puts an unparseable timestamp in no window at all', () => {
    // Derived from a recorded row: only created_at is broken.
    const broken = { ...pivot, created_at: 'not-a-date' };
    expect(rowsCreatedBetween([broken], -Infinity, Infinity)).toEqual([]);
  });
});

describe('identicalConfidenceShare', () => {
  const both = rows.find((r) => r.md_review_confidence !== null && r.rtp_confidence !== null)!;

  it('compares the numbers, not the DECIMAL strings Postgres returns', () => {
    // "0.72" and "0.720" are the same confidence.
    const row = { ...both, md_review_confidence: '0.72', rtp_confidence: '0.720' };
    expect(identicalConfidenceShare([row])).toEqual({ same: 1, withBoth: 1 });
  });

  it('leaves a row missing either number out of the denominator', () => {
    // Before 2026-09-10 no auto-published row stored md_review_confidence;
    // counting those would dilute the rate toward zero.
    const noPost = { ...both, md_review_confidence: null };
    const noRtp = { ...both, rtp_confidence: null };
    expect(identicalConfidenceShare([noPost, noRtp])).toEqual({ same: 0, withBoth: 0 });
  });
});
