import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mostRecentMonthOccurrence,
  resolveSeasonSpans,
  nflWeekDate,
  nflKickoff,
  localCalendarDate,
  buildCalendarBlock,
  parseIsoDate,
} from '../src/agents/injury-intelligence/season-calendar.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('mostRecentMonthOccurrence', () => {
  it('walks December back a year but leaves the current month alone', () => {
    // The live failure: today = 2026-09-09, three December injuries resolved to
    // 2024-12, one year before the correct answer.
    expect(mostRecentMonthOccurrence('2026-09-09', 12)).toBe('2025-12');
    expect(mostRecentMonthOccurrence('2026-09-09', 9)).toBe('2026-09');
    expect(mostRecentMonthOccurrence('2026-09-09', 8)).toBe('2026-08');
    expect(mostRecentMonthOccurrence('2026-09-09', 10)).toBe('2025-10');
  });

  it('handles the year boundary', () => {
    expect(mostRecentMonthOccurrence('2026-01-05', 1)).toBe('2026-01');
    expect(mostRecentMonthOccurrence('2026-01-05', 12)).toBe('2025-12');
    expect(mostRecentMonthOccurrence('2026-01-05', 2)).toBe('2025-02');
  });
});

describe('parseIsoDate', () => {
  it('rejects partial dates and non-existent calendar days', () => {
    expect(parseIsoDate('2026-07')).toBeNull();
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-02-28')).toEqual([2026, 2, 28]);
  });
});

describe('NFL season arithmetic', () => {
  it('places Week 1 on the Thursday after Labor Day', () => {
    expect(nflKickoff(2025)).toBe('2025-09-04'); // Labor Day Mon 2025-09-01
    expect(nflKickoff(2026)).toBe('2026-09-10'); // Labor Day Mon 2026-09-07
  });

  it('maps Week 14 of the 2025 season into December 2025, not 2024', () => {
    expect(nflWeekDate(2025, 14)).toBe('2025-12-04');
  });
});

describe('resolveSeasonSpans', () => {
  it('names the season by its START year and states the straddle', () => {
    const nfl = resolveSeasonSpans('NFL', '2026-09-09');
    expect(nfl?.currentSeasonYear).toBe(2026);
    expect(nfl?.lines[0]).toContain('"2026 season" = September 2026 through February 2027');
    expect(nfl?.lines[1]).toContain('"2025 season" = September 2025 through February 2026');
  });

  it('labels NBA and Premier League seasons with the hyphenated form', () => {
    expect(resolveSeasonSpans('NBA', '2026-09-09')?.lines[0]).toContain('"2025-26 season"');
    expect(resolveSeasonSpans('PREMIER_LEAGUE', '2026-09-09')?.lines[0]).toContain('"2026-27 season"');
  });

  it('returns null for UFC — no season is the honest answer for an individual sport', () => {
    expect(resolveSeasonSpans('UFC', '2026-09-09')).toBeNull();
  });
});

describe('localCalendarDate', () => {
  it('names the previous local day for a row stamped just after midnight UTC', () => {
    // Mykel Williams' ESPN row. Resolving "Wednesday" against the UTC date is
    // how the adjacent-day flip-flops (08-19 <-> 08-20 four times on Danny
    // Pinter) become possible.
    const local = localCalendarDate(new Date('2026-08-19T00:14:00Z'), 'NFL');
    expect(local.date).toBe('2026-08-18');
    expect(local.weekday).toBe('Tuesday');
  });

  it('uses UK time for the Premier League', () => {
    // 00:30 UTC in July is 01:30 BST — same day in London, previous day in NY.
    expect(localCalendarDate(new Date('2026-07-10T00:30:00Z'), 'PREMIER_LEAGUE').date)
      .toBe('2026-07-10');
    expect(localCalendarDate(new Date('2026-07-10T00:30:00Z'), 'NFL').date).toBe('2026-07-09');
  });
});

describe('buildCalendarBlock', () => {
  const block = buildCalendarBlock({
    today: '2026-09-09',
    reportedAt: new Date('2026-08-19T00:14:00Z'),
    sport: 'NFL',
  });

  it('states today, both calendar dates, the month table and the season spans', () => {
    expect(block).toContain('AUTHORITATIVE');
    expect(block).toContain('Today: 2026-09-09');
    expect(block).toContain('UTC calendar date 2026-08-19');
    expect(block).toContain('LOCAL calendar date where this is reported 2026-08-18 (Tuesday)');
    expect(block).toContain('December → 2025-12');
    expect(block).toContain('September → 2026-09');
    expect(block).toContain('NFL "2025 season"');
  });

  it('emits no season lines for UFC rather than inventing one', () => {
    const ufc = buildCalendarBlock({
      today: '2026-09-09',
      reportedAt: new Date('2026-09-08T18:00:00Z'),
      sport: 'UFC',
    });
    expect(ufc).toContain('This sport has no season');
    expect(ufc).not.toContain('Week 1 kickoff');
  });
});

describe('drift lock against significance-config.json', () => {
  it('the prompt season table and the threshold windows agree on NFL/NBA months', () => {
    // Two tables, deliberately separate: sport_seasons carries threshold_delta
    // and must stay tunable without silently rewriting what the model is told
    // about the calendar. This test is what stops them drifting apart.
    const cfg = JSON.parse(
      readFileSync(resolve(HERE, '..', 'data', 'significance-config.json'), 'utf-8'),
    ) as { sport_seasons: Record<string, Array<{ window: string; from: string; to: string }>> };

    const nflRegular = cfg.sport_seasons.NFL.find((w) => w.window === 'regular_season');
    expect(nflRegular?.from.slice(0, 2)).toBe('09'); // NFL season starts in September
    expect(nflRegular?.to.slice(0, 2)).toBe('02'); // and ends in February

    const nbaRegular = cfg.sport_seasons.NBA.find((w) => w.window === 'regular_season');
    expect(nbaRegular?.from.slice(0, 2)).toBe('10'); // NBA starts in October
    const nbaPlayoffs = cfg.sport_seasons.NBA.find((w) => w.window === 'playoffs');
    expect(nbaPlayoffs?.to.slice(0, 2)).toBe('06'); // and finishes in June
  });
});
