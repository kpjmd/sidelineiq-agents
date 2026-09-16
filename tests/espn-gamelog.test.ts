/**
 * The gamelog parser, against payloads recorded live from ESPN on 2026-09-15.
 *
 * Each assertion here corresponds to a way of reading this endpoint that looks
 * correct and is not. FAILS-ON-NAIVE: a parser that iterates the flat `events`
 * map fails `excludes preseason`; one that filters on splitType === '2' fails
 * every NBA case; one that uses the UTC date fails `converts to the sport's
 * local calendar date`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseRegularSeasonGames,
  firstGameAfter,
  gamelogSeasonParam,
  gamelogSeasonsFor,
  buildGamelogUrl,
} from '../src/monitoring/sports/espn-gamelog.js';

interface Fixture {
  cases: Record<string, { why: string; url: string; status: number; body: unknown }>;
}
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/espn-gamelogs.json'), 'utf-8'),
) as Fixture;

const nfl = fixture.cases['nfl-regular-season'].body;
const nflPrior = fixture.cases['nfl-prior-season'].body;
const nba = fixture.cases['nba-preseason-and-months'].body;

describe('parseRegularSeasonGames — NFL', () => {
  it('reads the regular-season games and their dates', () => {
    const { games, unknown_labels } = parseRegularSeasonGames(nfl, 'NFL');
    expect(games.length).toBeGreaterThan(0);
    expect(unknown_labels).toEqual([]);
    for (const g of games) {
      expect(g.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(g.season_type_label).toMatch(/Regular Season/);
    }
    // Ascending, because firstGameAfter walks in order and trusts it.
    const dates = games.map((g) => g.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('excludes the postseason split while keeping the regular season', () => {
    const { games, excluded_non_regular, unknown_labels } = parseRegularSeasonGames(nflPrior, 'NFL');
    expect(unknown_labels).toEqual([]);
    // The recorded payload carries 16 regular-season and 3 postseason games,
    // and lists the POSTSEASON first — order is not a signal.
    expect(games).toHaveLength(16);
    expect(excluded_non_regular).toBe(3);
    expect(games.every((g) => !/postseason/i.test(g.season_type_label))).toBe(true);
  });

  it('carries a readable game URL a person can open', () => {
    const { games } = parseRegularSeasonGames(nfl, 'NFL');
    expect(games[0].url).toMatch(/^https:\/\/www\.espn\.com\//);
  });
});

describe('parseRegularSeasonGames — NBA', () => {
  it('reads month-named categories, which carry no splitType of "2"', () => {
    const { games, unknown_labels } = parseRegularSeasonGames(nba, 'NBA');
    // The trap: filtering on splitType === '2' yields zero games for NBA, which
    // reads as "this athlete never returned" for the whole sport.
    expect(games.length).toBeGreaterThan(50);
    expect(unknown_labels).toEqual([]);
  });

  it('excludes preseason games that share the same flat events map', () => {
    const body = nba as { events: Record<string, { gameDate?: string }> };
    const { games, excluded_non_regular } = parseRegularSeasonGames(nba, 'NBA');
    // Every event in the payload is either kept or explicitly excluded; the
    // preseason ones are in `events` right beside the regular-season ones.
    expect(excluded_non_regular).toBeGreaterThan(0);
    expect(games.length).toBeLessThan(Object.keys(body.events).length);
    expect(games.every((g) => !/preseason/i.test(g.season_type_label))).toBe(true);
  });

  it('converts to the sport\'s local calendar date, not the UTC one', () => {
    const { games } = parseRegularSeasonGames(nba, 'NBA');
    // A tip-off after 8pm ET is the NEXT day in UTC. Any game whose UTC time is
    // before 08:00 belongs to the previous local date, and at least one such
    // game exists in any real NBA season.
    const lateNight = games.filter((g) => {
      const hour = parseInt(g.game_date_utc.slice(11, 13), 10);
      return hour < 8;
    });
    expect(lateNight.length).toBeGreaterThan(0);
    for (const g of lateNight) {
      expect(g.date).not.toBe(g.game_date_utc.slice(0, 10));
      // …and it is the day before, not some other day.
      const utcDay = new Date(g.game_date_utc);
      utcDay.setUTCDate(utcDay.getUTCDate() - 1);
      expect(g.date).toBe(utcDay.toISOString().slice(0, 10));
    }
  });
});

describe('firstGameAfter', () => {
  it('is strictly after the injury date', () => {
    const { games } = parseRegularSeasonGames(nfl, 'NFL');
    const onDate = games[3].date;
    // The athlete has a stat line for the game he was hurt IN — counting it
    // would date every in-game injury's return to the injury itself.
    expect(firstGameAfter(games, onDate)?.date).not.toBe(onDate);
    expect(firstGameAfter(games, onDate)!.date > onDate).toBe(true);
  });

  it('returns null when no game follows', () => {
    const { games } = parseRegularSeasonGames(nfl, 'NFL');
    expect(firstGameAfter(games, '2099-01-01')).toBeNull();
  });

  it('returns the earliest, not merely any, following game', () => {
    const { games } = parseRegularSeasonGames(nba, 'NBA');
    const cut = games[10].date;
    const after = games.filter((g) => g.date > cut).map((g) => g.date);
    expect(firstGameAfter(games, cut)!.date).toBe(after[0]);
  });
});

describe('season parameters', () => {
  it('NFL names a season by its START year, NBA by its END year', () => {
    // Verified live: NFL ?season=2024 returns "2024 Regular Season";
    // NBA ?season=2026 returns "2025-26 Regular Season".
    expect(gamelogSeasonParam('NFL', '2025-12-14')).toBe(2025);
    expect(gamelogSeasonParam('NFL', '2026-01-05')).toBe(2025); // January is still 2025's season
    expect(gamelogSeasonParam('NBA', '2025-12-14')).toBe(2026);
    expect(gamelogSeasonParam('NBA', '2026-04-03')).toBe(2026);
    expect(gamelogSeasonParam('NBA', '2026-10-25')).toBe(2027);
  });

  it('matches the labels in the recorded payloads', () => {
    const label = (b: unknown): string =>
      ((b as { seasonTypes: Array<{ displayName: string }> }).seasonTypes.find((s) =>
        /regular season/i.test(s.displayName),
      )?.displayName ?? '');
    expect(label(nflPrior)).toBe('2024 Regular Season');
    expect(fixture.cases['nfl-prior-season'].url).toContain('season=2024');
    expect(label(nba)).toBe('2025-26 Regular Season');
    expect(fixture.cases['nba-preseason-and-months'].url).toContain('season=2026');
  });

  it('enumerates every season an injury window spans', () => {
    expect(gamelogSeasonsFor('NFL', '2025-11-02', '2026-09-15')).toEqual([2025, 2026]);
    expect(gamelogSeasonsFor('NBA', '2025-12-01', '2026-02-01')).toEqual([2026]);
    expect(gamelogSeasonsFor('NBA', '2025-03-01', '2026-11-20')).toEqual([2025, 2026, 2027]);
  });

  it('builds the URL the fixtures were recorded from', () => {
    expect(buildGamelogUrl('NFL', '3139477', 2024)).toBe(fixture.cases['nfl-prior-season'].url);
    expect(buildGamelogUrl('NBA', '3945274', 2026)).toBe(fixture.cases['nba-preseason-and-months'].url);
  });
});

describe('unknown splits are reported, never assumed', () => {
  it('excludes an unrecognised seasonType and names it', () => {
    const body = JSON.parse(JSON.stringify(nfl)) as {
      seasonTypes: Array<{ displayName: string }>;
    };
    body.seasonTypes[0].displayName = '2026 Global Showcase';
    const { games, unknown_labels, excluded_non_regular } = parseRegularSeasonGames(body, 'NFL');
    expect(games).toHaveLength(0);
    expect(excluded_non_regular).toBeGreaterThan(0);
    expect(unknown_labels).toEqual(['2026 Global Showcase']);
  });
});
