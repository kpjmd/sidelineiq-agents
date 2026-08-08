/**
 * Premier League news source.
 *
 * The fixture is a real capture of .../soccer/eng.1/news from 2026-08-08,
 * trimmed to the fields the source reads. Its value is the awkward cases:
 * soccer articles that mention an injury but tag no athlete, and transfer /
 * preseason chatter that trips the injury keyword regex without being an
 * injury report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ESPNPremierLeagueNewsSource } from '../src/monitoring/sports/espn-premier-league-news.js';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/espn-pl-news.json',
);

interface FixtureArticle {
  headline?: string;
  description?: string;
  published?: string;
  [k: string]: unknown;
}

/**
 * Re-stamps every article as published just now. Without this the source's
 * recency window (MAX_EVENT_AGE_DAYS) would silently empty the fixture as it
 * ages, turning these into tests that pass for the wrong reason.
 */
function freshFixture(): { articles: FixtureArticle[] } {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as { articles: FixtureArticle[] };
  const now = new Date().toISOString();
  return { articles: raw.articles.map((a) => ({ ...a, published: now })) };
}

function stubFeed(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, json: async () => body })),
  );
}

beforeEach(() => {
  vi.stubEnv('MAX_EVENT_AGE_DAYS', '7');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('ESPNPremierLeagueNewsSource', () => {
  it('extracts the athlete from headline text when ESPN tags no athlete', async () => {
    // "Man United being 'careful' with Mason Mount after injury scare" carries
    // only a team category — categories[].athlete.displayName is null. This is
    // the case a straight copy of the UFC source would drop on the floor.
    stubFeed(freshFixture());
    const events = await new ESPNPremierLeagueNewsSource().fetchLatestEvents();

    const mount = events.find((e) => e.athlete_name === 'Mason Mount');
    expect(mount).toBeDefined();
    expect(mount!.team).toBe('Manchester United');
    expect(mount!.sport).toBe('PREMIER_LEAGUE');
    expect(mount!.source_name).toBe('espn-premier-league-news');
  });

  it('never mistakes a club name for an athlete', async () => {
    // NAME_RE happily reads "Man United" as first name "Man", last name
    // "United" — the club-token blocklist is what stops it.
    stubFeed(freshFixture());
    const events = await new ESPNPremierLeagueNewsSource().fetchLatestEvents();

    const clubTokens = ['Man', 'Manchester', 'West', 'Aston', 'Crystal', 'Real', 'Inter'];
    for (const event of events) {
      const first = event.athlete_name.split(' ')[0];
      expect(clubTokens, `"${event.athlete_name}" looks like a club`).not.toContain(first);
    }
  });

  it('drops injury-adjacent articles that name no player', async () => {
    // "Which big clubs are struggling with World Cup burnout?" and
    // "Liverpool's preseason: Injuries, squad depth a concern..." both match the
    // injury keywords but have no identifiable subject.
    stubFeed(freshFixture());
    const events = await new ESPNPremierLeagueNewsSource().fetchLatestEvents();

    const headlines = events.map((e) => e.injury_description);
    expect(headlines.some((h) => h.includes('World Cup burnout'))).toBe(false);
  });

  it('ignores transfer and preseason articles with no injury keyword', async () => {
    stubFeed(freshFixture());
    const events = await new ESPNPremierLeagueNewsSource().fetchLatestEvents();

    const descriptions = events.map((e) => e.injury_description);
    expect(descriptions.some((d) => d.includes('Grading big signings'))).toBe(false);
    expect(descriptions.some((d) => d.includes('Transfer rumors'))).toBe(false);
  });

  it('honours the recency window', async () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as { articles: FixtureArticle[] };
    const stale = new Date(Date.now() - 30 * 86400000).toISOString();
    stubFeed({ articles: raw.articles.map((a) => ({ ...a, published: stale })) });

    const source = new ESPNPremierLeagueNewsSource();
    expect(await source.fetchLatestEvents()).toEqual([]);
    expect(source.lastFetchReport().status).toBe('empty');
  });

  it('prefers a tagged athlete over text extraction when ESPN supplies one', async () => {
    stubFeed({
      articles: [
        {
          headline: "Man United confirm Bruno Fernandes hamstring injury",
          description: 'Scan confirmed a grade 2 strain.',
          published: new Date().toISOString(),
          categories: [
            { type: 'athlete', athlete: { displayName: 'Bruno Fernandes' } },
            { type: 'team', team: { description: 'Manchester United' } },
          ],
        },
      ],
    });

    const events = await new ESPNPremierLeagueNewsSource().fetchLatestEvents();
    expect(events).toHaveLength(1);
    expect(events[0].athlete_name).toBe('Bruno Fernandes');
    expect(events[0].team).toBe('Manchester United');
  });

  it('reports error rather than empty when the feed is unreachable', async () => {
    stubFeed({}, false, 502);
    const source = new ESPNPremierLeagueNewsSource();

    expect(await source.fetchLatestEvents()).toEqual([]);
    expect(source.lastFetchReport()).toEqual({ status: 'error', detail: 'HTTP 502' });
  });
});
