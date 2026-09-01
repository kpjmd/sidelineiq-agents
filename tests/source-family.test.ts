import { describe, it, expect } from 'vitest';
import { sourceFamily, sourceFamilies } from '../src/monitoring/source-family.js';
import type { RawInjuryEvent } from '../src/types.js';

function ev(source_name: string | undefined, source_url = 'https://example.test/a'): RawInjuryEvent {
  return {
    athlete_name: 'A B',
    sport: 'NFL',
    team: 'X',
    injury_description: 'ankle sprain',
    source_url,
    reported_at: new Date(),
    source_name,
  };
}

describe('sourceFamily — who published this', () => {
  it('collapses every espn-* fetcher into one family', () => {
    // These are our names for ESPN endpoints, not separate newsrooms. Counting
    // them as two publishers would be ESPN corroborating ESPN.
    for (const name of [
      'espn-nfl',
      'espn-nba',
      'espn-premier-league',
      'espn-premier-league-news',
      'espn-ufc',
    ]) {
      expect(sourceFamily(ev(name))).toBe('espn');
    }
  });

  it('gives every X insider its own family', () => {
    expect(sourceFamily(ev('X:AdamSchefter'))).toBe('x:adamschefter');
    expect(sourceFamily(ev('X:RapSheet'))).toBe('x:rapsheet');
    expect(sourceFamily(ev('X:wojespn'))).not.toBe(sourceFamily(ev('X:ShamsCharania')));
  });

  it('keys NewsAPI on the OUTLET, which only the URL knows', () => {
    // One source_name covers five outlets (DOMAINS in newsapi-nfl.ts), so the
    // publisher exists nowhere but source_url.
    expect(sourceFamily(ev('newsapi-nfl', 'https://profootballtalk.nbcsports.com/2026/09/x')))
      .toBe('news:nbcsports.com');
    expect(sourceFamily(ev('newsapi-nfl', 'https://www.si.com/nfl/x'))).toBe('news:si.com');
    expect(sourceFamily(ev('newsapi-nfl', 'https://www.bbc.co.uk/sport/x'))).toBe('news:bbc.co.uk');
  });

  it('FAIL-CLOSED: returns null when the publisher cannot be established', () => {
    // null never corroborates. A source we cannot name must not be able to
    // lower a publishing bar.
    expect(sourceFamily(ev(undefined))).toBeNull();
    expect(sourceFamily(ev('   '))).toBeNull();
    expect(sourceFamily(ev('X:'))).toBeNull();
    // The NewsAPI query endpoint names no outlet.
    expect(sourceFamily(ev('newsapi-nfl', 'https://newsapi.org/v2/everything?q=nfl'))).toBeNull();
    expect(sourceFamily(ev('newsapi-nfl', 'not a url'))).toBeNull();
  });
});

describe('sourceFamilies — including publishers MultiSource merged away', () => {
  it('puts the event own family first and appends the merged ones', () => {
    const e = ev('espn-nfl');
    e.corroborating_families = ['x:rapsheet', 'news:si.com'];
    expect(sourceFamilies(e)).toEqual(['espn', 'x:rapsheet', 'news:si.com']);
  });

  it('never double-counts a family that arrived twice', () => {
    const e = ev('espn-nfl');
    e.corroborating_families = ['espn', 'x:rapsheet', 'x:rapsheet'];
    expect(sourceFamilies(e)).toEqual(['espn', 'x:rapsheet']);
  });

  it('yields an empty list when nothing can be identified', () => {
    expect(sourceFamilies(ev(undefined))).toEqual([]);
  });
});
