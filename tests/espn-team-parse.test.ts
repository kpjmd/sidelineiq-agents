import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ESPNNFLSource } from '../src/monitoring/sports/espn-nfl.js';
import { ESPNNBASource } from '../src/monitoring/sports/espn-nba.js';
import type { RawInjuryEvent } from '../src/types.js';

// Recorded live by `espn-team-parse-dryrun.ts --emit-fixture`; the reduction is
// stated inside the file. Unlike espn-nfl-injuries.json (2026-08-19), it keeps
// every team field — that fixture pruned them, which is how parse() could read
// a `group.team` object the live feed does not have and set every row to
// 'Unknown' with the whole suite green.
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/espn-injuries-team-shape.json'),
    'utf-8',
  ),
) as { cases: Record<'NFL' | 'NBA', { injuries: Group[] }> };

interface Group {
  id?: string;
  displayName?: string;
  team?: Record<string, string>;
  injuries: Array<{ athlete: { displayName: string; team?: { displayName?: string } } }>;
}

type Parser = { parse: (f: unknown) => RawInjuryEvent[] };
const nfl = () => new ESPNNFLSource() as unknown as Parser;
const nba = () => new ESPNNBASource() as unknown as Parser;

let savedAge: string | undefined;
beforeEach(() => {
  savedAge = process.env.MAX_EVENT_AGE_DAYS;
  // The fixture is a fixed snapshot, so the recency window must not filter it.
  process.env.MAX_EVENT_AGE_DAYS = '100000';
});
afterEach(() => {
  if (savedAge === undefined) delete process.env.MAX_EVENT_AGE_DAYS;
  else process.env.MAX_EVENT_AGE_DAYS = savedAge;
});

describe('ESPN injuries feed — team', () => {
  it('the live group shape is {id, displayName, injuries} with no team object', () => {
    for (const sport of ['NFL', 'NBA'] as const) {
      for (const g of FIXTURE.cases[sport].injuries) {
        expect(Object.keys(g).sort()).toEqual(['displayName', 'id', 'injuries']);
      }
    }
  });

  it('names every parsed row after its group — no Unknown', () => {
    for (const [sport, parser] of [['NFL', nfl()], ['NBA', nba()]] as const) {
      const groups = FIXTURE.cases[sport].injuries;
      const events = parser.parse(FIXTURE.cases[sport]);
      expect(events.length).toBeGreaterThan(0);
      expect(events.filter((e) => e.team === 'Unknown')).toEqual([]);
      const groupNames = new Set(groups.map((g) => g.displayName));
      for (const e of events) expect(groupNames.has(e.team)).toBe(true);
    }
  });

  it('takes the GROUP, not athlete.team, for a traded athlete', () => {
    // athlete.team is stale across trades: Ingram sits in the Clippers group
    // under a comment about the Clippers, with athlete.team still Toronto. The
    // roster agreed with the group on all seven of these when recorded.
    const groups = FIXTURE.cases.NBA.injuries;
    const traded = groups.flatMap((g) =>
      g.injuries
        .filter((r) => r.athlete.team?.displayName && r.athlete.team.displayName !== g.displayName)
        .map((r) => ({ name: r.athlete.displayName, group: g.displayName, stale: r.athlete.team!.displayName })),
    );
    expect(traded.length).toBeGreaterThanOrEqual(7);
    expect(traded).toContainEqual({ name: 'Brandon Ingram', group: 'LA Clippers', stale: 'Toronto Raptors' });

    const events = nba().parse(FIXTURE.cases.NBA);
    for (const t of traded) {
      const e = events.find((x) => x.athlete_name === t.name);
      expect(e, t.name).toBeDefined();
      expect(e!.team).toBe(t.group);
    }
  });

  it('still reads the legacy nested team object', () => {
    const feed = {
      injuries: [
        {
          team: { displayName: 'Kansas City Chiefs' },
          injuries: [
            { athlete: { displayName: 'A Player' }, status: 'Out', date: new Date().toISOString(), shortComment: 'knee' },
          ],
        },
      ],
    };
    expect(nfl().parse(feed)[0].team).toBe('Kansas City Chiefs');
  });

  it('falls back to Unknown — never to athlete.team — when the group names no team', () => {
    // Unknown is the safe direction: the validator fills it from the roster.
    const feed = {
      injuries: [
        {
          id: '12',
          injuries: [
            {
              athlete: { displayName: 'A Player', team: { displayName: 'Toronto Raptors' } },
              status: 'Out',
              date: new Date().toISOString(),
              shortComment: 'knee',
            },
          ],
        },
      ],
    };
    expect(nfl().parse(feed)[0].team).toBe('Unknown');
  });

  it('ignores an ESPN sentinel on the group', () => {
    const feed = {
      injuries: [
        {
          displayName: '<UNKNOWN>',
          injuries: [
            { athlete: { displayName: 'A Player' }, status: 'Out', date: new Date().toISOString(), shortComment: 'knee' },
          ],
        },
      ],
    };
    expect(nfl().parse(feed)[0].team).toBe('Unknown');
  });
});
