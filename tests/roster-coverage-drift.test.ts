import { describe, it, expect } from 'vitest';
import { diffCoverage, type CoverageTeamRow } from '../src/monitoring/roster-sync.js';
import type { ESPNTeam } from '../src/monitoring/sports/espn-base.js';
import { ESPNPremierLeagueSource } from '../src/monitoring/sports/espn-premier-league.js';
import { ESPNNFLSource } from '../src/monitoring/sports/espn-nfl.js';
import { ESPNNBASource } from '../src/monitoring/sports/espn-nba.js';

function feedTeam(espn_team_id: string, name = `Club ${espn_team_id}`): ESPNTeam {
  return { espn_team_id, name, abbreviation: null, location: null, display_name: name };
}

function dbTeam(espn_team_id: string | null, name = `Club ${espn_team_id}`): CoverageTeamRow {
  return { espn_team_id, name, last_synced_at: '2026-06-19T04:00:00Z' };
}

describe('diffCoverage', () => {
  it('reports in-coverage teams the feed no longer returns', () => {
    // The production shape: 23 held, 20 returned, the three relegated clubs out.
    const db = ['379', '371', '380', '359', '364'].map((id) => dbTeam(id));
    const feed = ['359', '364'].map((id) => feedTeam(id));

    const absent = diffCoverage(db, feed);

    expect(absent.map((t) => t.espn_team_id)).toEqual(['379', '371', '380']);
  });

  it('returns nothing when the feed covers every held team', () => {
    const db = ['359', '364'].map((id) => dbTeam(id));
    const feed = ['359', '364'].map((id) => feedTeam(id));

    expect(diffCoverage(db, feed)).toEqual([]);
  });

  it('ignores teams in the feed that we do not hold — that is a promotion', () => {
    // Handled by the same cycle's upsert loop; reporting it would be noise.
    const db = [dbTeam('359')];
    const feed = ['359', '388', '306'].map((id) => feedTeam(id));

    expect(diffCoverage(db, feed)).toEqual([]);
  });

  it('skips rows with no espn_team_id — they were never in the feed', () => {
    const db = [dbTeam(null, 'Hand-entered FC'), dbTeam('379')];
    const feed = [feedTeam('359')];

    expect(diffCoverage(db, feed).map((t) => t.name)).toEqual(['Club 379']);
  });

  it('reports every held team when the feed is empty', () => {
    // diffCoverage itself is honest about an empty feed; refusing to act on it
    // is the caller's job, which is why the floor guard exists separately.
    const db = ['379', '359'].map((id) => dbTeam(id));

    expect(diffCoverage(db, [])).toHaveLength(2);
  });

  it('carries last_synced_at through for the operator log', () => {
    const absent = diffCoverage([dbTeam('379', 'Burnley')], []);

    expect(absent[0]).toMatchObject({ name: 'Burnley', last_synced_at: '2026-06-19T04:00:00Z' });
  });
});

describe('expectedMinTeams floors', () => {
  // The floor is what stops a truncated ESPN response from being read as a mass
  // relegation. Each must sit BELOW the real league size (so a genuine
  // relegation cycle still passes) and ABOVE any plausible truncation.
  it.each([
    ['PREMIER_LEAGUE', new ESPNPremierLeagueSource(), 18, 20],
    ['NFL', new ESPNNFLSource(), 30, 32],
    ['NBA', new ESPNNBASource(), 28, 30],
  ] as const)('%s floor is below the real league size', (_sport, source, floor, realSize) => {
    expect(source.expectedMinTeams).toBe(floor);
    expect(source.expectedMinTeams).toBeLessThan(realSize);
    expect(source.expectedMinTeams).toBeGreaterThan(0);
  });

  it('the PL floor still admits the three-relegation case this bug came from', () => {
    // 20 clubs are always returned — 17 survivors + 3 promoted. The floor must
    // not trip on that, or the check would disable itself in exactly the season
    // it is needed.
    expect(new ESPNPremierLeagueSource().expectedMinTeams).toBeLessThanOrEqual(20);
  });
});
