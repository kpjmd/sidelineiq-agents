/**
 * The UFC athlete-list provider — the thing that gives fighters player rows.
 *
 * UFC has no teams, so the team→roster walk every other sport uses has nothing
 * to walk. Fighters come from ESPN's MMA scoreboard instead: everyone who
 * fought in, or is booked for, a card in the rolling window.
 *
 * The two properties that matter here are both about NOT losing people:
 * a failed read must upsert nothing rather than look like an empty sport, and
 * every competitor must be taken — not just the ones whose card slot happens to
 * confer a tier. A prelim fighter earns no promotion but is still a person
 * whose injury needs an entity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  callToolWithRetry: vi.fn(),
  isServerAvailable: vi.fn(() => true),
}));

import { callToolWithRetry } from '../src/utils/mcp-client-manager.js';
import {
  ATHLETE_LIST_PROVIDERS,
  hasRosterProvider,
  isTeamSport,
  registersAthletesOnSight,
} from '../src/monitoring/roster-sync.js';

const mockUpsert = vi.mocked(callToolWithRetry);

/** A scoreboard event with `count` bouts, first prelim → last main event. */
function card(name: string, fighters: Array<[string, string]>) {
  return {
    name,
    date: '2026-08-01T00:00:00Z',
    competitions: fighters.map(([id, displayName]) => ({
      competitors: [{ id, athlete: { displayName } }],
    })),
  };
}

function stubScoreboard(events: unknown[] | 'error') {
  global.fetch = vi.fn(async () => {
    if (events === 'error') return { ok: false, status: 503 } as never;
    return { ok: true, json: async () => ({ events }) } as never;
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sport predicates', () => {
  it('separates "has a roster" from "has teams"', () => {
    // These were one test — `sport !== 'UFC'` — and conflating them is what
    // would send every UFC post to MD review for a team it cannot have.
    expect(hasRosterProvider('UFC')).toBe(true);
    expect(isTeamSport('UFC')).toBe(false);
    expect(registersAthletesOnSight('UFC')).toBe(true);
  });

  it('leaves the team sports exactly as they were', () => {
    for (const sport of ['NFL', 'NBA', 'PREMIER_LEAGUE'] as const) {
      expect(hasRosterProvider(sport)).toBe(true);
      expect(isTeamSport(sport)).toBe(true);
      // Their rosters are authoritative: a name that misses there is a bad tag,
      // and minting a row for it would invent a player.
      expect(registersAthletesOnSight(sport)).toBe(false);
    }
  });
});

describe('UFC card roster provider', () => {
  const provider = ATHLETE_LIST_PROVIDERS.UFC!;

  it('takes every competitor, not just the ones a slot would rank', async () => {
    // Six bouts: the tier provider ranks the top few, this must return all 6.
    stubScoreboard([
      card(
        'UFC 330: Someone vs. Someone',
        Array.from({ length: 6 }, (_, i) => [`id-${i}`, `Fighter ${i}`] as [string, string]),
      ),
    ]);
    const athletes = await provider.fetchAthletes();
    expect(athletes).toHaveLength(6);
    expect(athletes![0]).toEqual({ espn_athlete_id: 'id-0', full_name: 'Fighter 0' });
  });

  it('reads the id from the competitor, not the nested athlete', async () => {
    // The live feed carries the id on competitor.id and leaves athlete.id
    // undefined. An earlier type declared only athlete.id, so nothing read it.
    stubScoreboard([
      {
        name: 'UFC Fight Night',
        competitions: [{ competitors: [{ id: '3022677', athlete: { displayName: 'Conor McGregor' } }] }],
      },
    ]);
    const athletes = await provider.fetchAthletes();
    expect(athletes).toEqual([{ espn_athlete_id: '3022677', full_name: 'Conor McGregor' }]);
  });

  it('drops TBA placeholders — they are not people', async () => {
    stubScoreboard([
      card('UFC 331', [
        ['1', 'Real Fighter'],
        ['2', 'TBA'],
        ['3', 'Opponent TBA'],
      ]),
    ]);
    const athletes = await provider.fetchAthletes();
    expect(athletes!.map((a) => a.full_name)).toEqual(['Real Fighter']);
  });

  it('excludes Contender Series, a developmental show', async () => {
    stubScoreboard([
      card("Dana White's Contender Series", [['1', 'Prospect']]),
      card('UFC 332', [['2', 'Roster Fighter']]),
    ]);
    const athletes = await provider.fetchAthletes();
    expect(athletes!.map((a) => a.full_name)).toEqual(['Roster Fighter']);
  });

  it('dedupes a fighter who appears on several cards in the window', async () => {
    stubScoreboard([
      card('UFC 333', [['7', 'Repeat Fighter']]),
      card('UFC Fight Night', [['7', 'Repeat Fighter']]),
    ]);
    expect(await provider.fetchAthletes()).toHaveLength(1);
  });

  it('skips a competitor with an id but no name', async () => {
    stubScoreboard([
      { name: 'UFC 334', competitions: [{ competitors: [{ id: '9', athlete: {} }] }] },
    ]);
    expect(await provider.fetchAthletes()).toEqual([]);
  });

  it('returns null — never a partial list — when a chunk fails', async () => {
    // The load-bearing one. A partial read makes a fighter look absent from the
    // sport, and absence is never evidence: nothing downstream may retire,
    // un-tier or delete on the strength of it.
    stubScoreboard('error');
    expect(await provider.fetchAthletes()).toBeNull();
  });

  it('returns null when the whole window comes back empty', async () => {
    // "Zero UFC events in nine months" is not a fact about the world.
    stubScoreboard([]);
    expect(await provider.fetchAthletes()).toBeNull();
  });
});

describe('what the provider upserts', () => {
  it('never sends a team, and never sends salary', async () => {
    // current_team_id is OMITTED rather than nulled: the server COALESCEs, so
    // both behave the same on the write, but omission states the intent — a
    // fighter has no team, we are not trying to clear one.
    const provider = ATHLETE_LIST_PROVIDERS.UFC!;
    stubScoreboard([card('UFC 335', [['42', 'Test Fighter']])]);
    const athletes = await provider.fetchAthletes();

    mockUpsert.mockResolvedValue({ content: [{ text: '{}' }] } as never);
    // Mirrors what syncAthleteList sends.
    await callToolWithRetry('web', 'web_upsert_player', {
      sport: 'UFC',
      espn_athlete_id: athletes![0].espn_athlete_id,
      full_name: athletes![0].full_name,
      prominence_source: 'espn',
    });

    const payload = mockUpsert.mock.calls[0][2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('current_team_id');
    expect(payload).not.toHaveProperty('salary');
    expect(payload.espn_athlete_id).toBe('42');
  });
});
