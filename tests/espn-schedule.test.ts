/**
 * Team schedules and calendar censoring (pre-registration Amendment 1, A1.3),
 * against recorded payloads only.
 *
 * FAIL-CLOSED BOTH WAYS: an empty schedule must be null (never true, which
 * would censor every return, and never false, which would score it), and a
 * missed game must be false even before the return's own season is read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildTeamScheduleUrl,
  isCalendarCensored,
  parseTeamSchedule,
} from '../src/monitoring/sports/espn-schedule.js';
import { parseRegularSeasonGames } from '../src/monitoring/sports/espn-gamelog.js';

interface Fixture {
  cases: Record<string, { url: string; status: number; body: unknown }>;
}
const load = (f: string) => JSON.parse(readFileSync(resolve(__dirname, 'fixtures', f), 'utf-8')) as Fixture;
const S = load('espn-team-schedules.json').cases;
const G = load('espn-gamelogs.json').cases;

const KC = parseTeamSchedule(S['nfl-kc-2025-pairs-with-gamelog'].body, 'NFL');
const MAHOMES = parseRegularSeasonGames(G['nfl-regular-season'].body, 'NFL').games;

describe('parseTeamSchedule', () => {
  it('reads a full NFL season as 17 completed regular-season games in local dates', () => {
    expect(KC).toHaveLength(17);
    expect(KC.every((g) => g.completed)).toBe(true);
    // Week 1 kicked off 2025-09-06T00:00Z — a Friday-night game, local 09-05.
    expect(KC[0].date).toBe('2025-09-05');
  });

  it('reads completion per event on an in-progress season', () => {
    const nyg = parseTeamSchedule(S['nfl-current-season-partial'].body, 'NFL');
    expect(nyg).toHaveLength(17);
    const done = nyg.filter((g) => g.completed).length;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(17);
  });

  it('reads the NBA season param as the ENDING year', () => {
    const lal = parseTeamSchedule(S['nba-season-ending-year'].body, 'NBA');
    expect(lal).toHaveLength(82);
    expect(lal[0].date.startsWith('2025-10')).toBe(true);
    expect(S['nba-season-ending-year'].url).toContain('season=2026');
  });

  it('parses an unknown team (200, empty) as no games, not an error', () => {
    expect(S['unknown-team-200-empty'].status).toBe(200);
    expect(parseTeamSchedule(S['unknown-team-200-empty'].body, 'NFL')).toEqual([]);
  });

  it('builds a regular-season URL', () => {
    expect(buildTeamScheduleUrl('NBA', '13', 2026)).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/13/schedule?season=2026&seasontype=2',
    );
  });
});

describe('isCalendarCensored', () => {
  const week1 = MAHOMES[0];
  const week3 = MAHOMES.find((g) => g.event_id === '401772920')!;

  it('is true for an offseason injury back in Week 1', () => {
    expect(isCalendarCensored('2025-08-03', week1, KC)).toBe(true);
  });

  it('is true for the very next game in-season, including across a bye', () => {
    // Week 9 on 2025-11-02, bye in Week 10, Week 11 on 2025-11-16.
    const week11 = MAHOMES.find((g) => g.week === 11)!;
    expect(isCalendarCensored('2025-11-03', week11, KC)).toBe(true);
  });

  it('is false when the team played a game in between', () => {
    expect(isCalendarCensored('2025-09-07', week3, KC)).toBe(false);
  });

  it('is false from a missed game alone, before the return game is in the list', () => {
    const before = KC.filter((g) => g.date < week3.date);
    expect(isCalendarCensored('2025-09-07', week3, before)).toBe(false);
  });

  it('is null when the schedule cannot answer', () => {
    expect(isCalendarCensored('2025-08-03', week1, [])).toBeNull();
    const withoutReturn = KC.filter((g) => g.event_id !== week1.event_id && g.date > week1.date);
    expect(isCalendarCensored('2025-08-03', week1, withoutReturn)).toBeNull();
  });

  it('ignores games that are not completed', () => {
    const pending = KC.map((g) => (g.event_id === '401772837' ? { ...g, completed: false } : g));
    expect(isCalendarCensored('2025-09-07', week3, pending)).toBe(true);
  });

  it('carries the athlete team id through the gamelog parse', () => {
    expect(week1.team_id).toBe('12');
  });
});
