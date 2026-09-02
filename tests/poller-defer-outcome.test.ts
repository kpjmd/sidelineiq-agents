import { describe, it, expect } from 'vitest';
import { applyDeferOutcome, checkDeferTtlReachable } from '../src/monitoring/poller.js';
import type { ClassificationResult, SignificanceAssessment } from '../src/types.js';

const SIX_HOURS_MS = 21_600_000; // the production POLL_INTERVAL_MS

function assessment(overrides: Partial<SignificanceAssessment> = {}): SignificanceAssessment {
  return {
    raw_score: 53,
    season_window: 'none',
    season_threshold_delta: 0,
    composite_score: 53,
    process_threshold: 55,
    defer_threshold: 35,
    tier_blocked: false,
    triage_decision: 'DEFER',
    athlete_tier: 2,
    athlete_tier_source: 'lookup',
    subscores: {
      athlete_prominence: 70,
      information_specificity: 48,
      event_recency_novelty: 15,
      content_type_prior: 75,
    },
    rationale: 'DEFER score=53',
    ...overrides,
  };
}

describe('checkDeferTtlReachable', () => {
  it('names the exact production misconfiguration', () => {
    // ttl_hours 6 against a 6-hour poll: every entry was evicted at the start
    // of the very next cycle, before anything could corroborate it. 324 EXPIRE
    // lines in the live log, all at deferred_for_h≈6.0, and nothing said why.
    const warning = checkDeferTtlReachable(6, SIX_HOURS_MS);
    expect(warning).toContain('DEFER_TTL_UNREACHABLE');
    expect(warning).toContain('DEFER is DROP');
  });

  it('is silent at the shipped 48h', () => {
    expect(checkDeferTtlReachable(48, SIX_HOURS_MS)).toBeNull();
  });

  it('warns when a TTL buys only one corroboration window', () => {
    const warning = checkDeferTtlReachable(11, SIX_HOURS_MS);
    expect(warning).toContain('DEFER_TTL_SINGLE_WINDOW');
  });
});

describe('applyDeferOutcome', () => {
  it('replaces the DEFER assessment with the promotion that superseded it', () => {
    // Everything after the gate reads significance off `classified`. The old
    // code discarded the re-score, so a promoted event carried a DEFER verdict
    // and its pre-promotion bar through the rest of the pipeline.
    const promoted = assessment({
      triage_decision: 'PROCESS',
      process_threshold: 45,
      corroboration_discount: 10,
      corroborating_sources: ['espn', 'x:adamschefter'],
    });
    const classified = { significance: assessment() } as ClassificationResult;

    const returned = applyDeferOutcome(classified, {
      result: 'promoted',
      significance: promoted,
      sources: ['espn', 'x:adamschefter'],
    });

    expect(classified.significance).toBe(promoted);
    expect(returned).toBe(promoted);
    expect(classified.significance?.triage_decision).toBe('PROCESS');
    expect(classified.significance?.corroboration_discount).toBe(10);
  });
});
