import { describe, it, expect } from 'vitest';
import { detectConflict } from '../src/agents/injury-intelligence/agent.js';
import type { ReturnToPlayEstimate } from '../src/types.js';

const rtp = (min: number, max: number): ReturnToPlayEstimate => ({
  min_weeks: min,
  max_weeks: max,
  probability_week_2: 0.1,
  probability_week_4: 0.3,
  probability_week_8: 0.7,
  confidence: 0.8,
});

describe('detectConflict — single-snapshot (backward compatible)', () => {
  it('no conflict when gap within 2 weeks', () => {
    expect(detectConflict(6, rtp(6, 8))).toEqual({ conflict: false });
  });

  it('conflict when team timeline far shorter than OTM', () => {
    const r = detectConflict(2, rtp(8, 12));
    expect(r.conflict).toBe(true);
    expect(r.reason).toContain('shorter');
    expect(r.timeline_compression).toBeUndefined();
  });

  it('suppresses day-to-day (0w) when OTM min >= 4w', () => {
    expect(detectConflict(0, rtp(6, 10))).toEqual({ conflict: false });
  });

  it('null team timeline → no conflict', () => {
    expect(detectConflict(null, rtp(4, 6))).toEqual({ conflict: false });
  });

  it('omitting priorTimelines leaves behavior identical', () => {
    expect(detectConflict(3, rtp(3, 5))).toEqual({ conflict: false });
  });
});

describe('detectConflict — longitudinal timeline compression', () => {
  // 6w reported, then 2w reported one week later: window dropped 4w while only
  // ~1w elapsed → compression (drop - elapsed = 3 > 2).
  const compressingTrajectory = [
    { reported_weeks: 6, at: '2026-05-01T00:00:00Z' },
    { reported_weeks: 2, at: '2026-05-08T00:00:00Z' },
  ];

  it('flags compression even when the current snapshot gap is within tolerance', () => {
    // team 2w vs OTM 3-5w → snapshot gap ~2 (no snapshot conflict), but the
    // trajectory compressed → conflict via compression.
    const r = detectConflict(2, rtp(3, 5), compressingTrajectory);
    expect(r.conflict).toBe(true);
    expect(r.timeline_compression).toBe(true);
    expect(r.reason).toContain('compression');
  });

  it('merges snapshot + compression reasons when both fire', () => {
    const r = detectConflict(2, rtp(10, 14), compressingTrajectory);
    expect(r.conflict).toBe(true);
    expect(r.timeline_compression).toBe(true);
    expect(r.reason).toContain('Reporting conflict');
    expect(r.reason).toContain('compression');
  });

  it('does not flag when the window shrinks in step with elapsed time', () => {
    const steady = [
      { reported_weeks: 6, at: '2026-05-01T00:00:00Z' },
      { reported_weeks: 4, at: '2026-05-15T00:00:00Z' }, // dropped 2w over 2w
    ];
    const r = detectConflict(4, rtp(4, 6), steady);
    expect(r.conflict).toBe(false);
    expect(r.timeline_compression).toBeUndefined();
  });

  it('needs >= 2 dated points', () => {
    const r = detectConflict(2, rtp(4, 6), [{ reported_weeks: 6, at: '2026-05-01T00:00:00Z' }]);
    // single prior point → no compression; snapshot: 2 vs mid 5 → gap 3 → conflict
    expect(r.timeline_compression).toBeUndefined();
  });
});
