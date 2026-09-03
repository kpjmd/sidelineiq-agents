/**
 * The guard for a field that has held three different quantities.
 *
 * `team_timeline_weeks` is specified as REMAINING weeks from the report, but
 * live rows show the model emitting it as a real remaining figure (Bosa: 1), as
 * a TOTAL post-surgery count it computed itself (Kittle: 33 at 33 weeks
 * elapsed), and as a season length (52). Correcting the arithmetic on top of a
 * field holding three quantities would turn an obviously wrong number into a
 * confidently wrong one, so where the reading changes the verdict, a human
 * decides.
 *
 * Which fail against pre-fix code: all of them — neither function existed. What
 * they actually pin splits two ways, and the split matters:
 *   - "fires" cases pin that the guard catches the live shapes.
 *   - Every "never fires" case is a fail-closed boundary passing in BOTH
 *     directions. They are the ones that keep the guard from becoming a second
 *     source of noise on fresh injuries, which is the population the whole fix
 *     is meant to leave alone.
 */
import { describe, it, expect } from 'vitest';
import { assessTimelineAnchorAmbiguity } from '../src/agents/injury-intelligence/agent.js';
import { shouldForceTimelineAnchorReview, TIMELINE_ANCHOR_CODE } from '../src/monitoring/poller.js';
import type { InjuryPostContent, ReturnToPlayEstimate } from '../src/types.js';

const NOW = new Date('2026-09-02T00:00:00Z');
const rtp = (min: number, max: number): ReturnToPlayEstimate => ({
  min_weeks: min,
  max_weeks: max,
  probability_week_2: 0.1,
  probability_week_4: 0.3,
  probability_week_8: 0.7,
  confidence: 0.8,
});

const assess = (weeks: number, min: number, max: number, injury_date: string | null) =>
  assessTimelineAnchorAmbiguity(weeks, rtp(min, max), { injury_date, now: NOW });

describe('assessTimelineAnchorAmbiguity — fires', () => {
  it('the Mykel Williams shape: 52 at 43 weeks elapsed against a 39-52 window', () => {
    // As REMAINING: 43 + 52 = 95, far beyond the ceiling → conflict.
    // As TOTAL: 52 is exactly the ceiling → no conflict. The reading decides.
    const r = assess(52, 39, 52, '2025-11-02');
    expect(r.ambiguous).toBe(true);
    expect(r.remaining.status).toBe('longer');
    expect(r.total.status).toBe('inside');
  });

  it('the Mahomes shape: 39 at 37 weeks elapsed against a 39-52 window', () => {
    expect(assess(39, 39, 52, '2025-12-14').ambiguous).toBe(true);
  });
});

describe('assessTimelineAnchorAmbiguity — never fires (fail-closed boundaries)', () => {
  it('on a fresh injury, however the number reads', () => {
    // Elapsed 0: the two readings are the same number, so there is nothing to
    // be ambiguous about — and this is the population the old code got right.
    expect(assess(33, 39, 52, '2026-09-02').ambiguous).toBe(false);
  });

  it('at one week elapsed, even where the two readings differ numerically', () => {
    // The explicit elapsed >= 2 precondition. Without it a week-old injury
    // with a plausible disclosure could trip the guard on rounding alone.
    expect(assess(8, 8, 12, '2026-08-26').ambiguous).toBe(false);
  });

  it('when the number is too small to be a total', () => {
    // Bosa: 1 week remaining at 49 elapsed. A total can never be less than the
    // time already gone, so there is only one possible reading.
    expect(assess(1, 39, 52, '2025-09-21').ambiguous).toBe(false);
  });

  it('when there is no anchor at all', () => {
    // No elapsed time means no second reading to compare against.
    expect(assess(33, 39, 52, null).ambiguous).toBe(false);
  });

  it('when both readings reach the same verdict', () => {
    // 60 weeks against a 4-8 window is a conflict read either way, so which
    // clock it is on does not change what the MD would decide.
    const r = assess(60, 4, 8, '2025-11-02');
    expect(r.remaining.status).toBe('longer');
    expect(r.total.status).toBe('longer');
    expect(r.ambiguous).toBe(false);
  });
});

describe('shouldForceTimelineAnchorReview', () => {
  const post = (team_timeline_weeks: number | undefined): InjuryPostContent =>
    ({
      team_timeline_weeks,
      return_to_play: rtp(39, 52),
    }) as InjuryPostContent;

  it('forces review by default on an ambiguous value', () => {
    const g = shouldForceTimelineAnchorReview(post(52), '2025-11-02', '');
    expect(g).toMatchObject({ fires: true, force: true, annotate: false });
    expect(g.detail).toContain('team_timeline_weeks=52');
  });

  it('downgrades to an annotation when the operator lists the code', () => {
    // The same lever injury_date_unresolved uses — no deploy needed.
    const g = shouldForceTimelineAnchorReview(post(52), '2025-11-02', TIMELINE_ANCHOR_CODE);
    expect(g).toMatchObject({ fires: true, force: false, annotate: true });
  });

  it('another code in the list does not downgrade this one', () => {
    const g = shouldForceTimelineAnchorReview(post(52), '2025-11-02', 'source_tier_low');
    expect(g.force).toBe(true);
  });

  it('does not fire when no team timeline was disclosed', () => {
    expect(shouldForceTimelineAnchorReview(post(undefined), '2025-11-02', '').fires).toBe(false);
  });

  it('does not fire without an anchor', () => {
    expect(shouldForceTimelineAnchorReview(post(52), null, '').fires).toBe(false);
  });
});
