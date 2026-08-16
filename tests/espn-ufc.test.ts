/**
 * UFC news source.
 *
 * The fixture is a real capture of .../mma/ufc/news from 2026-08-15, trimmed to
 * the fields the source reads. It exists because this source was broken from
 * the day it was written until that date: it read
 * `categories[].athlete.displayName`, ESPN sends `description`, and with no
 * text fallback every article was skipped. Replaying the live feed through the
 * old code produced 12 keyword hits and 0 events. So the load-bearing case here
 * is the plain one — a real injury story must produce a real event — and after
 * that, the round-ups that tag 19-28 fighters and must not be attributed to
 * whichever one ESPN happened to list first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ESPNUFCSource } from '../src/monitoring/sports/espn-ufc.js';

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/espn-ufc-news.json');

interface FixtureArticle {
  headline?: string;
  description?: string;
  published?: string;
  [k: string]: unknown;
}

function loadFixture(): { articles: FixtureArticle[] } {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as { articles: FixtureArticle[] };
}

/**
 * Re-stamps every article as published just now. Without this the recency
 * window would empty the fixture as it ages, turning these into tests that pass
 * for the wrong reason.
 */
function freshFixture(): { articles: FixtureArticle[] } {
  const now = new Date().toISOString();
  return { articles: loadFixture().articles.map((a) => ({ ...a, published: now })) };
}

function stubFeed(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, json: async () => body })),
  );
}

function article(over: Record<string, unknown>): FixtureArticle {
  return { published: new Date().toISOString(), ...over };
}

beforeEach(() => {
  vi.stubEnv('MAX_EVENT_AGE_DAYS', '7');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('ESPNUFCSource', () => {
  it('emits events at all — the regression this source existed without', async () => {
    stubFeed(freshFixture());
    const events = await new ESPNUFCSource().fetchLatestEvents();

    expect(events.length).toBeGreaterThan(0);
    const acl = events.find((e) => e.injury_description.includes('suffered ACL injury'));
    expect(acl).toBeDefined();
    expect(acl!.athlete_name).toBe('Conor McGregor');
    expect(acl!.sport).toBe('UFC');
    expect(acl!.team).toBe('UFC');
    expect(acl!.source_name).toBe('espn-ufc');
    expect(acl!.source_url).toContain('espn.com');
  });

  it('reads the athlete from categories[].athlete.description, not displayName', async () => {
    stubFeed({
      articles: [
        article({
          headline: 'Jon Jones out of UFC 400 with a torn meniscus',
          description: 'Surgery scheduled this week.',
          categories: [
            { type: 'league', description: 'UFC' },
            { type: 'athlete', description: 'Jon Jones', athlete: { id: 1, description: 'Jon Jones' } },
          ],
        }),
      ],
    });

    const events = await new ESPNUFCSource().fetchLatestEvents();
    expect(events).toHaveLength(1);
    expect(events[0].athlete_name).toBe('Jon Jones');
  });

  it('still reads a displayName-shaped tag if ESPN ever sends one', async () => {
    stubFeed({
      articles: [
        article({
          headline: 'Jon Jones out of UFC 400 with a torn meniscus',
          categories: [{ type: 'athlete', athlete: { displayName: 'Jon Jones' } }],
        }),
      ],
    });

    const events = await new ESPNUFCSource().fetchLatestEvents();
    expect(events[0]?.athlete_name).toBe('Jon Jones');
  });

  it('attributes a two-fighter headline to the one named first, not ESPNs first tag', async () => {
    // "Conor McGregor suffers knee injury in loss to Max Holloway" tags both.
    // The injured fighter is the subject, and the subject leads the headline.
    stubFeed(freshFixture());
    const events = await new ESPNUFCSource().fetchLatestEvents();

    const loss = events.find((e) => e.injury_description.includes('in loss to Max Holloway'));
    expect(loss).toBeDefined();
    expect(loss!.athlete_name).toBe('Conor McGregor');
  });

  it('picks the headline subject out of a 28-tag round-up', async () => {
    stubFeed(freshFixture());
    const events = await new ESPNUFCSource().fetchLatestEvents();

    const grades = events.find((e) => e.injury_description.includes('fight grades'));
    expect(grades).toBeDefined();
    expect(grades!.athlete_name).toBe('Conor McGregor');
  });

  it('skips a round-up whose tagged fighters are all absent from the headline', async () => {
    // "UFC fights we want to see in the second half of 2026" tags 19 fighters
    // and names none of them in the headline. There is no subject to attribute
    // an injury to, so the event is dropped rather than guessed.
    stubFeed({
      articles: [
        article({
          headline: 'UFC fights we want to see in the second half of 2026',
          description: 'Who is coming back from injury and who should they face?',
          categories: [
            { type: 'athlete', athlete: { description: 'Joshua Van' } },
            { type: 'athlete', athlete: { description: 'Manel Kape' } },
            { type: 'athlete', athlete: { description: 'Tom Aspinall' } },
          ],
        }),
      ],
    });

    expect(await new ESPNUFCSource().fetchLatestEvents()).toEqual([]);
  });

  it('refuses to choose between two tagged fighters who share a surname', async () => {
    stubFeed({
      articles: [
        article({
          headline: 'Smith suffers a broken hand at UFC 400',
          categories: [
            { type: 'athlete', athlete: { description: 'Anthony Smith' } },
            { type: 'athlete', athlete: { description: 'Cole Smith' } },
          ],
        }),
      ],
    });

    expect(await new ESPNUFCSource().fetchLatestEvents()).toEqual([]);
  });

  it('honours the recency window', async () => {
    const stale = new Date(Date.now() - 30 * 86400000).toISOString();
    stubFeed({ articles: loadFixture().articles.map((a) => ({ ...a, published: stale })) });

    const source = new ESPNUFCSource();
    expect(await source.fetchLatestEvents()).toEqual([]);
    expect(source.lastFetchReport().status).toBe('empty');
  });

  it('drops an undated article instead of stamping it today', async () => {
    // The old code fell back to `new Date()`, which let an article of unknown
    // age enter as BREAKING with a fabricated timestamp.
    stubFeed({
      articles: [
        {
          headline: 'Jon Jones out of UFC 400 with a torn meniscus',
          categories: [{ type: 'athlete', athlete: { description: 'Jon Jones' } }],
        },
      ],
    });

    expect(await new ESPNUFCSource().fetchLatestEvents()).toEqual([]);
  });

  describe('MMA keyword selectivity', () => {
    const cases: Array<[string, string, boolean]> = [
      ['a knee as a strike is not a knee injury', 'Pereira lands a flying knee to end it', false],
      ['heavy hands are not a hand injury', 'He has heavy hands and a granite chin', false],
      ['torn ligament is', 'Makhachev fights on with a torn ligament', true],
      ['withdrawal is', 'Dern withdrew from UFC 400 on Friday', true],
      ['pulling out is', 'Gaethje pulled out of the main event', true],
      ['staph is', 'Fighter hospitalised with a staph infection', true],
      ['plain out of is not', 'Topuria is out of contract after this bout', false],
    ];

    it.each(cases)('%s', async (_label, headline, expected) => {
      stubFeed({
        articles: [
          article({
            headline,
            categories: [{ type: 'athlete', athlete: { description: 'Test Fighter' } }],
          }),
        ],
      });

      const events = await new ESPNUFCSource().fetchLatestEvents();
      expect(events.length === 1).toBe(expected);
    });
  });

  it('reports error rather than empty when the feed is unreachable', async () => {
    stubFeed({}, false, 503);
    const source = new ESPNUFCSource();

    expect(await source.fetchLatestEvents()).toEqual([]);
    expect(source.lastFetchReport()).toEqual({ status: 'error', detail: 'HTTP 503' });
  });
});

/**
 * Identity carried off the article itself.
 *
 * ESPN tags an athlete id on every athlete category. It is the key the player
 * lookup prefers — the only thing that separates two fighters who share a name
 * — and it is what lets a fighter outside the card-roster window (inactive two
 * years, then hurt) be registered at the moment they make news.
 */
describe('athlete id and source kind', () => {
  it('carries the tagged athlete id onto the event', async () => {
    stubFeed(freshFixture());
    const events = await new ESPNUFCSource().fetchLatestEvents();

    const mcgregor = events.find((e) => e.athlete_name === 'Conor McGregor');
    expect(mcgregor).toBeDefined();
    expect(mcgregor!.espn_athlete_id).toBe('3022677');
  });

  it('marks a story-linked event as article-sourced', async () => {
    stubFeed(freshFixture());
    const events = await new ESPNUFCSource().fetchLatestEvents();

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.source_kind).toBe('article');
  });

  it('falls back to feed kind when the article has no story link', async () => {
    // Without a link the event carries the shared news endpoint as its URL.
    // Claiming 'article' for that would let the same-article dedup guard
    // suppress every fighter after the first.
    stubFeed({
      articles: [
        article({
          headline: 'Fighter suffered ACL injury, out indefinitely',
          links: undefined,
          categories: [
            { type: 'athlete', athlete: { id: 111, description: 'Lone Fighter' } },
          ],
        }),
      ],
    });

    const [event] = await new ESPNUFCSource().fetchLatestEvents();
    expect(event.source_kind).toBe('feed');
    expect(event.espn_athlete_id).toBe('111');
  });

  it('omits the id when ESPN tags a name with no id', async () => {
    stubFeed({
      articles: [
        article({
          headline: 'Fighter suffered ACL injury, out indefinitely',
          links: { web: { href: 'https://espn.com/story/1' } },
          categories: [{ type: 'athlete', athlete: { description: 'Nameless Id' } }],
        }),
      ],
    });

    const [event] = await new ESPNUFCSource().fetchLatestEvents();
    expect(event.espn_athlete_id).toBeUndefined();
    expect(event.athlete_name).toBe('Nameless Id');
  });

  it('never sets is_update — this source has no status field to read', async () => {
    // The fact the whole classifier-fallback design rests on. If this source
    // ever gained a status signal, the fallback would defer to it.
    stubFeed(freshFixture());
    const events = await new ESPNUFCSource().fetchLatestEvents();
    for (const e of events) expect(e.is_update).toBeUndefined();
  });
});
