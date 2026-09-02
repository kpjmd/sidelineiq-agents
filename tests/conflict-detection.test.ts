/**
 * detectConflict, now anchored.
 *
 * Which of these fail against pre-fix code, stated per describe block rather
 * than left to inference:
 *   - "the anchor decides" — a genuine behavioural change. Pre-fix compared the
 *     team's REMAINING weeks to the window MIDPOINT, so a team saying "one more
 *     week" about a 49-week-old ACL was a 44-week conflict.
 *   - "the window, not the midpoint" — also genuine. An athlete sitting inside
 *     the literature range but off-centre used to trip the 2-week bar.
 *   - "no anchor, no verdict" — genuine: pre-fix had no anchor at all and
 *     always returned a verdict.
 *   - Everything else — the day-to-day suppression, the null disclosure and
 *     every compression case — is a fail-closed boundary whose BEHAVIOUR is
 *     unchanged. They do not compile against pre-fix code, because the
 *     signature gained its anchor argument, but that is arity, not evidence.
 *     What they pin is that the anchor change left these alone: compression in
 *     particular is anchor-independent by design and must still fire on an
 *     undated thread.
 *
 * `now` is injected everywhere so these never depend on the wall clock.
 */
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

const NOW = new Date('2026-09-02T00:00:00Z');
/** A fresh injury: elapsed 0, so team-implied total IS the disclosure. */
const FRESH = { injury_date: '2026-09-02', now: NOW };
/** No date at all. */
const UNANCHORED = { injury_date: null, now: NOW };

describe('detectConflict — fresh injury (elapsed 0, the pre-fix-correct case)', () => {
  it('no conflict when the disclosure sits inside the window', () => {
    const r = detectConflict(6, rtp(6, 8), FRESH);
    expect(r.conflict).toBe(false);
  });

  it('conflict when team timeline is far shorter than the window', () => {
    const r = detectConflict(2, rtp(8, 12), FRESH);
    expect(r.conflict).toBe(true);
    expect(r.reason).toContain('shorter');
    expect(r.timeline_compression).toBeUndefined();
  });

  it('suppresses day-to-day (0w) when OTM min >= 4w', () => {
    expect(detectConflict(0, rtp(6, 10), FRESH).conflict).toBe(false);
  });

  it('null team timeline → no conflict', () => {
    const r = detectConflict(null, rtp(4, 6), FRESH);
    expect(r.conflict).toBe(false);
    expect(r.gap.status).toBe('no_timeline');
  });

  it('omitting priorTimelines leaves behaviour identical', () => {
    expect(detectConflict(3, rtp(3, 5), FRESH).conflict).toBe(false);
  });
});

describe('detectConflict — the anchor decides', () => {
  it('a carryover whose team-implied total sits inside the window is NOT a conflict', () => {
    // Nick Bosa: 49 weeks post-ACL, team says one more week, window 39-52.
    // 49 + 1 = 50, comfortably inside. Pre-fix: |1 - 45.5| = 44.5 → conflict.
    const r = detectConflict(1, rtp(39, 52), { injury_date: '2025-09-21', now: NOW });
    expect(r.conflict).toBe(false);
    expect(r.gap.status).toBe('inside');
    expect(r.gap.team_total_weeks).toBe(50);
  });

  it('a carryover whose implied total overshoots the ceiling IS a conflict, and says by how much', () => {
    // The Kittle shape read literally: 33 weeks elapsed, 33 more claimed → 66.
    const r = detectConflict(33, rtp(39, 52), { injury_date: '2026-01-11', now: NOW });
    expect(r.conflict).toBe(true);
    expect(r.gap.gap_weeks).toBe(14);
    expect(r.reason).toContain('longer');
  });

  it('names the anchor and both clocks in the reason', () => {
    // A bare "team timeline (~1w)" beside a 39-52w window is the sentence that
    // made the old numbers unreadable.
    const r = detectConflict(1, rtp(39, 52), { injury_date: '2026-08-01', now: NOW });
    expect(r.reason).toContain('remaining');
    expect(r.reason).toContain('total from 2026-08-01');
    expect(r.reason).toContain('total from injury');
  });
});

describe('detectConflict — the window, not the midpoint', () => {
  it('a disclosure inside the window but far from its centre is not a conflict', () => {
    // 4 weeks against a 4-20 window: 8 weeks from the midpoint, but inside the
    // literature range. Pre-fix this was a conflict.
    const r = detectConflict(4, rtp(4, 20), FRESH);
    expect(r.conflict).toBe(false);
    expect(r.gap.status).toBe('inside');
  });

  it('exactly two weeks outside the window is still not a conflict', () => {
    const r = detectConflict(2, rtp(4, 20), FRESH);
    expect(r.gap.status).toBe('shorter');
    expect(r.conflict).toBe(false);
  });
});

describe('detectConflict — no anchor, no verdict', () => {
  it('returns no conflict when injury_date is unresolved', () => {
    const r = detectConflict(1, rtp(39, 52), UNANCHORED);
    expect(r.conflict).toBe(false);
    expect(r.gap.status).toBe('no_anchor');
  });

  it('still reports the gap object so callers can say WHY there is no number', () => {
    expect(detectConflict(1, rtp(39, 52), UNANCHORED).gap.elapsed_weeks).toBeNull();
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
    const r = detectConflict(2, rtp(3, 5), FRESH, compressingTrajectory);
    expect(r.conflict).toBe(true);
    expect(r.timeline_compression).toBe(true);
    expect(r.reason).toContain('compression');
  });

  it('merges snapshot + compression reasons when both fire', () => {
    const r = detectConflict(2, rtp(10, 14), FRESH, compressingTrajectory);
    expect(r.conflict).toBe(true);
    expect(r.timeline_compression).toBe(true);
    expect(r.reason).toContain('Reporting conflict');
    expect(r.reason).toContain('compression');
  });

  it('fires with NO anchor — compression compares two disclosures on one clock', () => {
    // Both readings are remaining-weeks, so the comparison is already
    // apples-to-apples and needs no injury_date. Losing this to the anchor
    // rule would silently disable the check on every undated thread.
    const r = detectConflict(2, rtp(3, 5), UNANCHORED, compressingTrajectory);
    expect(r.conflict).toBe(true);
    expect(r.timeline_compression).toBe(true);
  });

  it('does not flag when the window shrinks in step with elapsed time', () => {
    const steady = [
      { reported_weeks: 6, at: '2026-05-01T00:00:00Z' },
      { reported_weeks: 4, at: '2026-05-15T00:00:00Z' }, // dropped 2w over 2w
    ];
    const r = detectConflict(4, rtp(4, 6), FRESH, steady);
    expect(r.conflict).toBe(false);
    expect(r.timeline_compression).toBeUndefined();
  });

  it('needs >= 2 dated points', () => {
    const r = detectConflict(2, rtp(4, 6), FRESH, [
      { reported_weeks: 6, at: '2026-05-01T00:00:00Z' },
    ]);
    // Single prior point → no compression. The snapshot is 2 against a 4-6
    // window: 2 weeks short of the floor, which is the threshold, not past it.
    expect(r.timeline_compression).toBeUndefined();
    expect(r.conflict).toBe(false);
  });
});
