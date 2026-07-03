import { describe, it, expect } from 'vitest';
import { validateRTPEstimate } from '../src/agents/injury-intelligence/rtp-estimator.js';
import type { ReturnToPlayEstimate } from '../src/types.js';

function makeRTP(overrides: Partial<ReturnToPlayEstimate> = {}): ReturnToPlayEstimate {
  return {
    min_weeks: 2,
    max_weeks: 4,
    probability_week_2: 0.2,
    probability_week_4: 0.5,
    probability_week_8: 0.9,
    confidence: 0.8,
    ...overrides,
  };
}

describe('validateRTPEstimate — finiteness (F3)', () => {
  it('rejects a non-finite min_weeks', () => {
    const r = validateRTPEstimate(makeRTP({ min_weeks: NaN }), 'ACL tear', 'MODERATE');
    expect(r.valid).toBe(false);
  });

  it('rejects a non-finite max_weeks', () => {
    const r = validateRTPEstimate(makeRTP({ max_weeks: Infinity }), 'ACL tear', 'MODERATE');
    expect(r.valid).toBe(false);
  });

  it('rejects a NaN probability', () => {
    const r = validateRTPEstimate(makeRTP({ probability_week_4: NaN }), 'ACL tear', 'MODERATE');
    expect(r.valid).toBe(false);
  });
});

describe('validateRTPEstimate — bounds & ordering', () => {
  it('clamps out-of-range probabilities', () => {
    const r = validateRTPEstimate(
      makeRTP({ probability_week_2: -0.5, probability_week_8: 1.4 }),
      'ACL tear',
      'MODERATE',
    );
    expect(r.valid).toBe(true);
    expect(r.corrected?.probability_week_2).toBe(0);
    expect(r.corrected?.probability_week_8).toBe(1);
  });

  it('swaps min>max and clamps the resulting negative week to 0', () => {
    const r = validateRTPEstimate(makeRTP({ min_weeks: 3, max_weeks: -1 }), 'ACL tear', 'MODERATE');
    expect(r.valid).toBe(true);
    expect(r.corrected?.min_weeks).toBe(0);
    expect(r.corrected?.max_weeks).toBe(3);
  });
});

describe('validateRTPEstimate — monotonicity routes to review (F6)', () => {
  it('flags requiresReview and repairs a non-monotonic curve', () => {
    const r = validateRTPEstimate(
      makeRTP({ probability_week_2: 0.9, probability_week_4: 0.1, probability_week_8: 0.5 }),
      'ACL tear',
      'MODERATE',
    );
    expect(r.valid).toBe(true);
    expect(r.requiresReview).toBe(true);
    expect(r.corrected?.probability_week_4).toBe(0.9);
    expect(r.corrected?.probability_week_8).toBe(0.9);
  });

  it('leaves a clean estimate uncorrected and unflagged', () => {
    const r = validateRTPEstimate(makeRTP(), 'ACL tear', 'MODERATE');
    expect(r.valid).toBe(true);
    expect(r.corrected).toBeUndefined();
    expect(r.requiresReview).toBeFalsy();
    expect(r.warnings).toHaveLength(0);
  });

  it('warns but does not require review for an extreme max_weeks', () => {
    const r = validateRTPEstimate(makeRTP({ max_weeks: 105 }), 'ACL tear', 'SEVERE');
    expect(r.valid).toBe(true);
    expect(r.requiresReview).toBeFalsy();
    expect(r.warnings.some((w) => w.includes('104'))).toBe(true);
  });
});
