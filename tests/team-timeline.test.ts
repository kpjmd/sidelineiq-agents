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
    ['out for season', 24],
    ['season-ending', 24],
  ] as const)('parses %j → %d weeks', (input, expected) => {
    expect(parseTeamTimeline(input)).toBe(expected);
  });

  it.each(['questionable', 'probable', '', 'no timeline given'])(
    'returns null for unparseable/non-timeline input %j',
    (input) => {
      expect(parseTeamTimeline(input)).toBeNull();
    },
  );
});

describe('detectConflict — day-to-day suppression', () => {
  it('suppresses a conflict when a 0w (day-to-day) timeline meets a 4w+ OTM minimum', () => {
    const res = detectConflict(0, rtp(4, 8));
    expect(res.conflict).toBe(false);
  });

  it('still flags a genuine short-vs-long conflict', () => {
    const res = detectConflict(1, rtp(8, 12));
    expect(res.conflict).toBe(true);
  });
});
