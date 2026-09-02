import { describe, it, expect } from 'vitest';
import { parseTeamTimeline, detectConflict } from '../src/agents/injury-intelligence/agent.js';
import type { ReturnToPlayEstimate } from '../src/types.js';

const rtp = (min: number, max: number): ReturnToPlayEstimate => ({
  min_weeks: min,
  max_weeks: max,
  probability_week_2: 0.1,
  probability_week_4: 0.3,
  probability_week_8: 0.7,
  confidence: 0.8,
});

describe('parseTeamTimeline', () => {
  it.each([
    ['2-4 weeks', 3],
    ['2 to 4 weeks', 3],
    ['6 weeks', 6],
    ['2 months', 8],
    ['day-to-day', 0],
    ['week to week', 1],
  ] as const)('parses %j → %d weeks', (input, expected) => {
    expect(parseTeamTimeline(input)).toBe(expected);
  });

  it.each(['questionable', 'probable', '', 'no timeline given'])(
    'returns null for unparseable/non-timeline input %j',
    (input) => {
      expect(parseTeamTimeline(input)).toBeNull();
    },
  );

  // FAILS against pre-fix code, which returned 24. A season-ending
  // designation is an administrative FLOOR, not a return estimate, and
  // SKILL.md Rule 5 cannot be "faster or slower" than a floor: reading it as
  // 24 weeks made a fresh season-ending ACL look like the team was 15 weeks
  // ahead of the literature, a manufactured conflict against a statement that
  // made no timeline claim at all.
  it.each(['out for season', 'season-ending', 'out for the season'])(
    'returns null for the season-ending floor %j',
    (input) => {
      expect(parseTeamTimeline(input)).toBeNull();
    },
  );
});

// Both fail-closed boundaries: they pin that the day-to-day suppression
// survived the anchor change, not that anything was fixed. A fresh anchor
// (elapsed 0) is used so the team-implied total is the disclosure itself.
describe('detectConflict — day-to-day suppression', () => {
  const FRESH = { injury_date: '2026-09-02', now: new Date('2026-09-02T00:00:00Z') };

  it('suppresses a conflict when a 0w (day-to-day) timeline meets a 4w+ OTM minimum', () => {
    const res = detectConflict(0, rtp(4, 8), FRESH);
    expect(res.conflict).toBe(false);
  });

  it('still flags a genuine short-vs-long conflict', () => {
    const res = detectConflict(1, rtp(8, 12), FRESH);
    expect(res.conflict).toBe(true);
  });
});
