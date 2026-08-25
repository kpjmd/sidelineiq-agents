/**
 * extractAthleteName — telling a person from a club.
 *
 * The fixtures are live captures, not hand-authored: the five allowlisted
 * insider timelines as the X API returned them (`x-insider-timelines.json`),
 * and 50 ESPN soccer/eng.1 articles (`espn-pl-news-headlines.json`). Both were
 * recorded on 2026-08-24 from the same endpoints the sources themselves poll.
 *
 * Every assertion runs against the REAL exported filters — NBA_NAME_FILTER,
 * NFL_NAME_FILTER, PL_NAME_FILTER — so a change to a sport's team list or its
 * extra blocklist is exercised here rather than against a copy that could
 * drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractAthleteName } from '../src/monitoring/sports/text-extraction.js';
import { NBA_NAME_FILTER } from '../src/monitoring/sports/x-insider-nba.js';
import { NFL_NAME_FILTER } from '../src/monitoring/sports/newsapi-nfl.js';
import { PL_NAME_FILTER } from '../src/monitoring/sports/espn-premier-league-news.js';

const FIXTURES = dirname(fileURLToPath(import.meta.url)) + '/fixtures';

interface InsiderFixture {
  insiders: Array<{
    handle: string;
    sport: 'NFL' | 'NBA';
    tweets: Array<{ id: string; text: string }>;
  }>;
}

const insiderFixture: InsiderFixture = JSON.parse(
  readFileSync(join(FIXTURES, 'x-insider-timelines.json'), 'utf-8'),
);

const plFixture: { articles: Array<{ headline: string; description: string }> } = JSON.parse(
  readFileSync(join(FIXTURES, 'espn-pl-news-headlines.json'), 'utf-8'),
);

const filterFor = (sport: 'NFL' | 'NBA') =>
  sport === 'NBA' ? NBA_NAME_FILTER : NFL_NAME_FILTER;

/** The one tweet in the fixture whose text contains `needle`, and its sport. */
function tweetContaining(needle: string) {
  for (const insider of insiderFixture.insiders) {
    const tweet = insider.tweets.find((t) => t.text.includes(needle));
    if (tweet) return { text: tweet.text, sport: insider.sport };
  }
  throw new Error(`fixture has no tweet containing ${JSON.stringify(needle)}`);
}

describe('extractAthleteName — a club name is not a person', () => {
  // These three FAIL against pre-fix code. Pre-fix tests only
  // `blocklist.has(first)`, and the blocklists carry team NICKNAMES with no
  // city tokens, so each of these returned the city/team string instead of the
  // athlete: "Portland Trail", "Cleveland Browns", "Seattle WR". All three were
  // observed live, and the first is the one that filed a second Shaedon Sharpe
  // review item with no entity behind it.
  it('reads past "Portland Trail Blazers" to the injured guard', () => {
    const { text, sport } = tweetContaining('Shaedon Sharpe');
    expect(extractAthleteName(text, '', filterFor(sport))).toBe('Shaedon Sharpe');
  });

  it('reads past "Cleveland Browns" to the injured end', () => {
    const { text, sport } = tweetContaining('Cleveland Browns placing');
    expect(extractAthleteName(text, '', filterFor(sport))).toBe('Alex Wright');
  });

  it('reads past a position abbreviation to the injured receiver', () => {
    const { text, sport } = tweetContaining('Seattle WR Jake Bobo');
    expect(extractAthleteName(text, '', filterFor(sport))).toBe('Jake Bobo');
  });

  // The whole live corpus at once. Pre-fix this array held three team strings
  // in place of three athletes; the count of non-person results is the number
  // the live diff reported.
  it('extracts no team name anywhere in the live insider corpus', () => {
    const teamShaped: string[] = [];
    for (const insider of insiderFixture.insiders) {
      for (const tweet of insider.tweets) {
        const name = extractAthleteName(tweet.text, '', filterFor(insider.sport));
        if (!name) continue;
        const [first, last] = name.split(' ');
        const tokens = filterFor(insider.sport).teamTokens;
        if (tokens.has(first) && tokens.has(last)) teamShaped.push(name);
      }
    }
    expect(teamShaped).toEqual([]);
  });
});

describe('extractAthleteName — what the pair rule deliberately does not do', () => {
  // PASSES IN BOTH DIRECTIONS. This does not prove the fix; it guards the rule
  // that was NOT chosen. A flat city blocklist would also have killed "Portland
  // Trail", and would have taken these real athletes with it — which is why the
  // rule tests the PAIR and not `first` alone.
  it.each([
    ['Dallas Goedert', 'Eagles TE Dallas Goedert sprained his ankle Sunday.', NFL_NAME_FILTER],
    ['Orlando Robinson', 'Orlando Robinson tore his hamstring in warmups.', NBA_NAME_FILTER],
  ])('still extracts %s, whose first name is a location token', (expected, text, filter) => {
    expect(filter.teamTokens.has(expected.split(' ')[0])).toBe(true);
    expect(filter.blocklist.has(expected.split(' ')[0])).toBe(false);
    expect(extractAthleteName(text, '', filter)).toBe(expected);
  });

  // PASSES IN BOTH DIRECTIONS. Pins that this change is a no-op on the source
  // that had already tokenized its club list — the PL blocklist blocks these
  // tokens as first names outright, so neither new rule ever fires. Recorded
  // live over 50 articles, where the old and new code agreed on all 50.
  it('changes nothing on the Premier League corpus', () => {
    const names = plFixture.articles.map((a) =>
      extractAthleteName(a.headline, a.description, PL_NAME_FILTER),
    );
    // Snapshot of the pre-fix output, byte for byte.
    expect(names).toEqual(PRE_FIX_PL_NAMES);
  });
});

/**
 * What the PRE-FIX extractor returned for each of the 50 recorded PL articles,
 * generated by running the old implementation over the fixture. Written down
 * rather than recomputed so the assertion cannot pass by comparing new
 * behaviour against itself.
 */
const PRE_FIX_PL_NAMES: Array<string | null> = JSON.parse(
  readFileSync(join(FIXTURES, 'pl-names-pre-fix.json'), 'utf-8'),
).names;
