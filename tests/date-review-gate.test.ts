import { describe, it, expect } from 'vitest';
import {
  shouldForceDateReview,
  parseAnnotateOnlyCodes,
  partitionSoftFailures,
  DATE_REVIEW_CODE,
} from '../src/monitoring/poller.js';
import type { CarryoverSignals } from '../src/agents/injury-intelligence/carryover.js';
import type { RawInjuryEvent } from '../src/types.js';

const surgical: RawInjuryEvent = {
  athlete_name: 'Mykel Williams',
  sport: 'NFL',
  team: 'San Francisco 49ers',
  injury_description: 'Right Leg Knee - ACL Surgery — out — Status: Out',
  injury_details: { type: 'Knee - ACL', location: 'Leg', detail: 'Surgery', side: 'Right' },
  source_url: 'https://example.com/injuries',
  reported_at: new Date('2026-08-19T00:14:00Z'),
};

const structured: CarryoverSignals = {
  strength: 'structured',
  codes: ['roster_designation:PUP-P'],
  evidence: [],
};
const none: CarryoverSignals = { strength: 'none', codes: [], evidence: [] };

describe('shouldForceDateReview', () => {
  it('forces review on a carryover whose date did not resolve', () => {
    expect(shouldForceDateReview(structured, surgical, 'unknown', '')).toEqual({
      fires: true,
      force: true,
      annotate: false,
    });
    // 'possible' means only a vague window — the confidence that would
    // otherwise publish a plausible-looking guess at the report date.
    expect(shouldForceDateReview(structured, surgical, 'possible', '').force).toBe(true);
  });

  it('stays out of the way when the date DID resolve', () => {
    for (const c of ['probable', 'confirmed'] as const) {
      expect(shouldForceDateReview(structured, surgical, c, '').fires).toBe(false);
    }
  });

  it('does not fire on an unresolved date with no carryover evidence', () => {
    // The narrowness requirement. An unknown date on a genuinely new injury is
    // normal traffic and must publish exactly as it did before.
    expect(shouldForceDateReview(none, surgical, 'unknown', '')).toEqual({
      fires: false,
      force: false,
      annotate: false,
    });
  });

  it('downgrades to an annotation when the operator names the code', () => {
    const r = shouldForceDateReview(structured, surgical, 'unknown', DATE_REVIEW_CODE);
    expect(r).toEqual({ fires: true, force: false, annotate: true });
  });

  it('still forces when a DIFFERENT code is downgraded', () => {
    // Fail-closed: the lever is per-code, never a blanket off switch.
    expect(shouldForceDateReview(structured, surgical, 'unknown', 'source_tier_low').force).toBe(
      true,
    );
  });

  it('tolerates spacing and casing in the env var', () => {
    for (const env of [
      ` ${DATE_REVIEW_CODE} `,
      `source_tier_low, ${DATE_REVIEW_CODE}`,
      DATE_REVIEW_CODE.toUpperCase(),
    ]) {
      expect(shouldForceDateReview(structured, surgical, 'unknown', env).annotate, env).toBe(true);
    }
  });
});

describe('parseAnnotateOnlyCodes', () => {
  it('parses, trims, lowercases and drops empties', () => {
    expect([...parseAnnotateOnlyCodes(' A, ,b ,,C ')].sort()).toEqual(['a', 'b', 'c']);
    expect(parseAnnotateOnlyCodes(undefined).size).toBe(0);
    expect(parseAnnotateOnlyCodes('').size).toBe(0);
  });

  it('still governs partitionSoftFailures identically after the extraction', () => {
    // Regression lock on the shared-parser refactor: one definition of the set.
    const failures = [
      { code: 'source_tier_low' as const, detail: 'x' },
      { code: 'laterality_inconsistent' as const, detail: 'y' },
    ];
    const { forcing, annotateOnly } = partitionSoftFailures(failures, 'SOURCE_TIER_LOW');
    expect(annotateOnly.map((f) => f.code)).toEqual(['source_tier_low']);
    expect(forcing.map((f) => f.code)).toEqual(['laterality_inconsistent']);
    expect(partitionSoftFailures(failures, '').forcing).toHaveLength(2);
  });
});
