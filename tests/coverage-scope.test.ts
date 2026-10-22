import { describe, it, expect, afterEach } from 'vitest';
import {
  outOfCoverageSection,
  postTeamOutOfCoverage,
  coverageScopeMode,
} from '../src/monitoring/coverage-scope.js';
import { validateEvent, type ResolvedPlayerInfo } from '../src/agents/injury-intelligence/fact-validator.js';
import type { RawInjuryEvent } from '../src/types.js';

const IAMALEAVA_URL =
  'https://www.cbssports.com/college-football/news/nico-iamaleava-acl-tear-whats-next-ucla-tennessee/';

describe('outOfCoverageSection', () => {
  it.each([
    [IAMALEAVA_URL, 'college-football'],
    ['https://www.si.com/college/usc/football/usc-trojans-jahkeem-stewart-impact', 'college'],
    ['https://www.si.com/fannation/college/cfb-hq/news/3-college-football-qb-changes', 'college'],
    ['https://www.espn.com/mens-college-basketball/story/_/id/1/x', 'mens-college-basketball'],
  ])('flags the section of %s', (url, section) => {
    expect(outOfCoverageSection({ source_url: url, source_name: 'newsapi-nfl' })).toBe(section);
  });

  it.each([
    // A real NFL story whose SLUG mentions college — the slug is never read.
    'https://www.cbssports.com/nfl/news/rams-giants-among-nfl-week-6-disasters-inside-wildest-day-ever-in-college-football/',
    'https://www.cbssports.com/nfl/draft/news/some-story/',
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries',
    'https://www.si.com/college', // a single segment is the slug, not a section
    'not a url',
  ])('does not flag %s', (url) => {
    expect(outOfCoverageSection({ source_url: url, source_name: 'newsapi-nfl' })).toBeNull();
  });

  it('never reads an X path, where the first segment is a handle', () => {
    expect(
      outOfCoverageSection({ source_url: 'https://x.com/cfb/status/123', source_name: 'X:cfb' }),
    ).toBeNull();
  });
});

describe('postTeamOutOfCoverage', () => {
  it.each([
    ['UCLA', 'NFL'],
    ['Tennessee Volunteers', 'NFL'],
    ['Duke Blue Devils', 'NBA'],
  ] as const)('flags %s in %s', (team, sport) => {
    expect(postTeamOutOfCoverage(team, sport)).toBe(team);
  });

  it.each([
    ['New England Patriots', 'NFL'],
    ['San Francisco 49ers', 'NFL'],
    ['Niners', 'NFL'],
    ['Philadelphia 76ers', 'NBA'],
    ['Portland Trail Blazers', 'NBA'],
    ['Sixers', 'NBA'],
    ['Unknown', 'NFL'],
    ['', 'NFL'],
    ['Free Agent', 'NFL'],
    [null, 'NBA'],
    // No club list for PL or UFC — never a verdict.
    ['Wolves', 'PREMIER_LEAGUE'],
    ['Some Gym', 'UFC'],
  ] as const)('does not flag %s in %s', (team, sport) => {
    expect(postTeamOutOfCoverage(team, sport)).toBeNull();
  });
});

describe('coverageScopeMode', () => {
  it('defaults to on and accepts off/shadow', () => {
    expect(coverageScopeMode(undefined)).toBe('on');
    expect(coverageScopeMode('bogus')).toBe('on');
    expect(coverageScopeMode(' Shadow ')).toBe('shadow');
    expect(coverageScopeMode('off')).toBe('off');
  });
});

describe('validateEvent — out_of_coverage', () => {
  const NOW = new Date('2026-10-22T18:00:00Z');
  const event = (overrides: Partial<RawInjuryEvent> = {}): RawInjuryEvent => ({
    athlete_name: 'Nico Iamaleava',
    sport: 'NFL',
    team: 'Unknown',
    injury_description: "What's next for Nico Iamaleava? ACL tear",
    source_url: IAMALEAVA_URL,
    source_name: 'newsapi-nfl',
    reported_at: new Date('2026-10-20T18:06:15Z'),
    ...overrides,
  });
  const player: ResolvedPlayerInfo = {
    player_id: 'p1',
    full_name: 'Nico Iamaleava',
    current_team_id: 't1',
    current_team_name: 'Tennessee Titans',
    current_team_abbreviation: 'TEN',
    prominence_tier: 3,
    confidence: 'exact',
    match_count: 1,
  };
  const saved = process.env.COVERAGE_SCOPE_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.COVERAGE_SCOPE_MODE;
    else process.env.COVERAGE_SCOPE_MODE = saved;
  });

  it('hard-drops an unresolved athlete from a college section', async () => {
    delete process.env.COVERAGE_SCOPE_MODE;
    const r = await validateEvent(event(), null, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.hardFailures.map((f) => f.code)).toContain('out_of_coverage');
  });

  it('never drops a RESOLVED athlete, whatever the section', async () => {
    delete process.env.COVERAGE_SCOPE_MODE;
    const r = await validateEvent(event(), player, { now: NOW });
    expect(r.hardFailures.map((f) => f.code)).not.toContain('out_of_coverage');
  });

  it('keeps the soft review route for an unresolved athlete from a pro section', async () => {
    delete process.env.COVERAGE_SCOPE_MODE;
    const r = await validateEvent(
      event({ source_url: 'https://www.cbssports.com/nfl/news/aj-brown-injury/' }),
      null,
      { now: NOW },
    );
    expect(r.passed).toBe(true);
    expect(r.softFailures.map((f) => f.code)).toContain('identity_unresolvable');
  });

  it('shadow and off drop nothing', async () => {
    for (const mode of ['shadow', 'off']) {
      process.env.COVERAGE_SCOPE_MODE = mode;
      const r = await validateEvent(event(), null, { now: NOW });
      expect(r.passed).toBe(true);
      expect(r.softFailures.map((f) => f.code)).toContain('identity_unresolvable');
    }
  });
});
