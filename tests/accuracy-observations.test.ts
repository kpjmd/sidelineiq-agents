/**
 * One return, one observation (pre-registration Amendment 2, A2.1).
 *
 * The behavioural claim is the Burns case: two threads for one left ankle,
 * both closed on the 09-27 game, both scored — one return counted twice. And
 * the Pierce case: four threads minted by a close→re-mint loop on one 09-13
 * game are one exclusion, not four, so the published exclusion count is a
 * count of returns like the headline beside it.
 *
 * The synthetic cases carry hand-written expectations — they state the rule.
 * The `source: "live"` case was RECORDED from production via
 * `src/scripts/accuracy-report.ts --emit-fixture`, so the helper is exercised
 * against real row shapes (string dates, legacy records with no `scoreable`
 * key, NULL records on old physician closes), never ones written to match it.
 *
 * This file and its fixture are twins of the ones in sidelineiq-frontend;
 * `helper_version` pins both copies of the helper to the same fixture.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeAccuracy,
  isScoredRecord,
  ACCURACY_OBSERVATIONS_VERSION,
  type ObservationThread,
} from '../src/utils/accuracy-observations.js';
import fixture from './fixtures/accuracy-observation-cases.json' with { type: 'json' };

interface Case {
  name: string;
  source: string;
  threads: ObservationThread[];
  expect: {
    within: number;
    n: number;
    excluded_by_reason: Record<string, number>;
    collapsed: number;
    legacy: number;
    signed_error_median: number | null;
    signed_error_n: number;
    window_weeks_median: number | null;
    observation_ids: string[];
  };
}

const CASES = (fixture as unknown as { cases: Case[] }).cases;

describe('accuracy-observations fixture', () => {
  it('was recorded against this version of the helper', () => {
    expect((fixture as unknown as { helper_version: number }).helper_version).toBe(
      ACCURACY_OBSERVATIONS_VERSION,
    );
  });

  it('carries synthetic boundaries and a recorded live corpus', () => {
    expect(CASES.some((c) => c.source === 'synthetic')).toBe(true);
    expect(CASES.some((c) => c.source === 'live')).toBe(true);
  });

  for (const c of CASES) {
    it(c.name, () => {
      const s = summarizeAccuracy(c.threads);
      expect({
        within: s.within,
        n: s.n,
        excluded_by_reason: s.excluded_by_reason,
        collapsed: s.collapsed.length,
        legacy: s.legacy,
        signed_error_median: s.signed_error_days.median,
        signed_error_n: s.signed_error_days.n,
        window_weeks_median: s.window_weeks.median,
        observation_ids: s.observations.map((o) => o.thread_id).sort(),
      }).toEqual(c.expect);
    });
  }
});

describe('summarizeAccuracy invariants', () => {
  it('accounts for every closed thread exactly once, as a scored return or inside an exclusion', () => {
    for (const c of CASES) {
      const s = summarizeAccuracy(c.threads);
      const covered = [...s.observations.flatMap((o) => o.member_ids), ...s.exclusions.flatMap((e) => e.member_ids)];
      expect(new Set(covered).size).toBe(covered.length);
      expect(covered.length).toBe(s.closed_threads);
    }
  });

  it('never re-scores: every observation carries its representative record verbatim', () => {
    for (const c of CASES) {
      const byId = new Map(c.threads.map((t) => [t.id, t]));
      for (const o of summarizeAccuracy(c.threads).observations) {
        const rec = byId.get(o.thread_id)!.accuracy_record!;
        expect(o.within_range).toBe(rec.within_range === true);
        expect(isScoredRecord(rec)).toBe(true);
      }
    }
  });

  it('does not depend on input order', () => {
    for (const c of CASES) {
      const a = summarizeAccuracy(c.threads);
      const b = summarizeAccuracy([...c.threads].reverse());
      expect(b.within).toBe(a.within);
      expect(b.n).toBe(a.n);
      expect(b.observations.map((o) => o.thread_id).sort()).toEqual(a.observations.map((o) => o.thread_id).sort());
    }
  });
});
