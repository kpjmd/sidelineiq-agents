/**
 * The classifier's `sport` field is the only sport value in the pipeline that
 * is not a hardcoded per-source constant — everything else (poller,
 * return-watch, roster-sync, the salary snapshot) carries a league that came
 * from the source class or a loop variable and cannot be wrong.
 *
 * It used to reach lookupAthleteTier as a bare `as SportKey` cast, and it is
 * persisted to injury_posts.sport, which /admin re-scores from later. That
 * mattered once the salary index became sport-scoped: a garbage league there
 * means no salary row is found at all.
 *
 * What this guard does NOT do is the point of the last test: it rejects
 * nonsense, not a confident wrong answer.
 */
import { describe, it, expect } from 'vitest';
import { resolveClassifiedSport } from '../src/agents/injury-intelligence/classifier.js';

describe('resolveClassifiedSport', () => {
  it('accepts the four leagues we cover', () => {
    expect(resolveClassifiedSport('NFL', 'NBA')).toBe('NFL');
    expect(resolveClassifiedSport('NBA', 'NFL')).toBe('NBA');
    expect(resolveClassifiedSport('PREMIER_LEAGUE', 'NFL')).toBe('PREMIER_LEAGUE');
    expect(resolveClassifiedSport('UFC', 'NFL')).toBe('UFC');
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(resolveClassifiedSport('nfl', 'NBA')).toBe('NFL');
    expect(resolveClassifiedSport('  Premier_League  ', 'NFL')).toBe('PREMIER_LEAGUE');
  });

  it('falls back to the source sport for a league we do not cover', () => {
    // Haiku reaching for a real but uncovered league is the common shape.
    for (const hallucinated of ['MLB', 'NHL', 'MLS', 'WNBA', 'NCAA']) {
      expect(resolveClassifiedSport(hallucinated, 'NFL')).toBe('NFL');
    }
  });

  it('falls back for missing, empty and non-string values', () => {
    expect(resolveClassifiedSport(undefined, 'NBA')).toBe('NBA');
    expect(resolveClassifiedSport(null, 'NBA')).toBe('NBA');
    expect(resolveClassifiedSport('', 'NBA')).toBe('NBA');
    expect(resolveClassifiedSport('   ', 'NBA')).toBe('NBA');
    expect(resolveClassifiedSport(42, 'NBA')).toBe('NBA');
    expect(resolveClassifiedSport({ sport: 'NFL' }, 'NBA')).toBe('NBA');
  });

  it('CANNOT catch a plausible-but-wrong league, and is not meant to', () => {
    // 'NBA' for an NFL event is a valid league, so it passes. This is the
    // residual the guard leaves behind, and the reason poller.ts's concussion
    // re-check passes event.sport instead of this field, and the reason the
    // salary index is sport-scoped rather than trusting the caller.
    expect(resolveClassifiedSport('NBA', 'NFL')).toBe('NBA');
  });
});
