import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldForceMDReviewForXSource } from '../src/monitoring/poller.js';

describe('shouldForceMDReviewForXSource', () => {
  const original = process.env.X_INSIDER_FORCE_MD_REVIEW;

  beforeEach(() => {
    delete process.env.X_INSIDER_FORCE_MD_REVIEW;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.X_INSIDER_FORCE_MD_REVIEW;
    else process.env.X_INSIDER_FORCE_MD_REVIEW = original;
  });

  it('forces MD review for an X-sourced event by default', () => {
    const reason = shouldForceMDReviewForXSource('X:AdamSchefter');
    expect(reason).toBe('x_insider_unverified_source:X:AdamSchefter');
  });

  it('does not force review for non-X sources', () => {
    expect(shouldForceMDReviewForXSource('espn-nfl')).toBeUndefined();
    expect(shouldForceMDReviewForXSource('newsapi-nfl')).toBeUndefined();
    expect(shouldForceMDReviewForXSource(undefined)).toBeUndefined();
  });

  it('is disabled via X_INSIDER_FORCE_MD_REVIEW=false', () => {
    process.env.X_INSIDER_FORCE_MD_REVIEW = 'false';
    expect(shouldForceMDReviewForXSource('X:AdamSchefter')).toBeUndefined();
  });
});
