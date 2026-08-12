import { describe, it, expect } from 'vitest';
import {
  validateEvent,
  teamClaimCheck,
  type ResolvedPlayerInfo,
} from '../src/agents/injury-intelligence/fact-validator.js';
import type { RawInjuryEvent } from '../src/types.js';

const NOW = new Date('2026-05-02T00:00:00Z');

function makeEvent(overrides: Partial<RawInjuryEvent> = {}): RawInjuryEvent {
  return {
    athlete_name: 'Test Player',
    sport: 'NBA',
    team: 'Los Angeles Lakers',
    injury_description: 'left knee sprain',
    source_url: 'https://espn.com/story/123',
    reported_at: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  };
}

function makePlayer(overrides: Partial<ResolvedPlayerInfo> = {}): ResolvedPlayerInfo {
  return {
    player_id: 'p1',
    full_name: 'Test Player',
    current_team_id: 't1',
    current_team_name: 'Los Angeles Lakers',
    current_team_abbreviation: 'LAL',
    prominence_tier: 1,
    confidence: 'exact',
    match_count: 1,
    ...overrides,
  };
}

describe('validateEvent — team corroboration (F1: same-city guard)', () => {
  it.each([
    ['NBA', 'Los Angeles Lakers', 'Los Angeles Clippers'],
    ['NFL', 'New York Giants', 'New York Jets'],
    ['PREMIER_LEAGUE', 'Manchester United', 'Manchester City'],
  ] as const)(
    'hard-fails %s when a low-tier source reports a co-located but different team',
    async (sport, rosterTeam, reportedTeam) => {
      // A low-tier (T3) source contradicting the roster is treated as a probable
      // mis-tag → hard drop. (A high-tier source is tier-gated to MD review; see
      // the "source-tier gating" block below.)
      const res = await validateEvent(
        makeEvent({ sport, team: reportedTeam, source_url: 'https://newsapi.org/story' }),
        makePlayer({ current_team_name: rosterTeam, current_team_abbreviation: null }),
        { now: NOW },
      );
      expect(res.passed).toBe(false);
      expect(res.hardFailures.map((f) => f.code)).toContain('team_mismatch');
    },
  );

  it.each([
    ['exact name', 'Los Angeles Lakers'],
    ['nickname only', 'Lakers'],
    ['abbreviation', 'LAL'],
  ] as const)('passes the team check for a correct %s', async (_label, reported) => {
    const res = await validateEvent(makeEvent({ team: reported }), makePlayer(), { now: NOW });
    expect(res.hardFailures).toHaveLength(0);
  });
});

describe('validateEvent — unknown/blank team (F2)', () => {
  it.each(['Unknown', '', '   '])(
    'fills team from roster without a hard failure when reported team is %j',
    async (reported) => {
      const res = await validateEvent(makeEvent({ team: reported }), makePlayer(), { now: NOW });
      expect(res.passed).toBe(true);
      expect(res.hardFailures).toHaveLength(0);
      const corr = res.corrections.find((c) => c.field === 'team');
      expect(corr?.to).toBe('Los Angeles Lakers');
    },
  );
});

describe('validateEvent — abbreviation-only roster (F8)', () => {
  const abbrevOnly = () => makePlayer({ current_team_name: null, current_team_abbreviation: 'LAL' });

  it('passes when the reported team matches the abbreviation', async () => {
    const res = await validateEvent(makeEvent({ team: 'LAL' }), abbrevOnly(), { now: NOW });
    expect(res.hardFailures).toHaveLength(0);
  });

  it('hard-fails a wrong team even when only the abbreviation is known', async () => {
    const res = await validateEvent(
      makeEvent({ team: 'Boston Celtics', source_url: 'https://newsapi.org/story' }),
      abbrevOnly(),
      { now: NOW },
    );
    expect(res.hardFailures.map((f) => f.code)).toContain('team_mismatch');
  });
});

describe('validateEvent — team mismatch source-tier gating', () => {
  // A reported team that contradicts the roster is hard-dropped only for low-trust
  // sources; a high-trust source (likely reporting a real trade the roster hasn't
  // caught up to) is routed to MD review with the reported team preserved.
  it.each([
    ['T1', 'https://www.espn.com/nba/story'],
    ['T2', 'https://www.cbssports.com/story'],
  ] as const)(
    'soft-fails (routes to MD review) a %s source reporting a different team',
    async (_tier, sourceUrl) => {
      const res = await validateEvent(
        makeEvent({ team: 'Boston Celtics', source_url: sourceUrl }),
        makePlayer(),
        { now: NOW },
      );
      expect(res.passed).toBe(true);
      expect(res.hardFailures).toHaveLength(0);
      expect(res.softFailures.map((f) => f.code)).toContain('team_mismatch_unconfirmed');
      // The reported (new) team must be preserved — no correction back to the roster.
      expect(res.corrections.find((c) => c.field === 'team')).toBeUndefined();
    },
  );

  it.each([
    ['T3', 'https://newsapi.org/story'],
    ['unknown', 'https://randomblog.example/story'],
  ] as const)(
    'hard-fails a %s source reporting a different team, with a roster correction',
    async (_tier, sourceUrl) => {
      const res = await validateEvent(
        makeEvent({ team: 'Boston Celtics', source_url: sourceUrl }),
        makePlayer(),
        { now: NOW },
      );
      expect(res.passed).toBe(false);
      expect(res.hardFailures.map((f) => f.code)).toContain('team_mismatch');
      expect(res.softFailures.map((f) => f.code)).not.toContain('team_mismatch_unconfirmed');
      expect(res.corrections.find((c) => c.field === 'team')?.to).toBe('Los Angeles Lakers');
    },
  );
});

describe('validateEvent — resolved player carrying no roster team (F9)', () => {
  // Regression: a player that RESOLVES but has current_team_id IS NULL used to
  // fall through both branches of the team check — the first requires a truthy
  // rosterTeam, the second requires !resolved — so no code of any kind was
  // recorded and the event reached Sonnet with an entirely unchecked team.
  const teamless = () =>
    makePlayer({ current_team_id: null, current_team_name: null, current_team_abbreviation: null });

  it('soft-fails team_unverifiable instead of silently passing', async () => {
    const res = await validateEvent(makeEvent({ team: 'Anything At All' }), teamless(), { now: NOW });
    expect(res.softFailures.map((f) => f.code)).toContain('team_unverifiable');
    expect(res.hardFailures).toHaveLength(0);
    expect(res.passed).toBe(true);
  });

  it('does not emit team_unverified — the player IS in the roster store', async () => {
    const res = await validateEvent(makeEvent({ team: 'Anything At All' }), teamless(), { now: NOW });
    expect(res.softFailures.map((f) => f.code)).not.toContain('team_unverified');
  });

  it('is not tier-gated — a T1 source is just as uncheckable as a T3 one', async () => {
    for (const sourceUrl of ['https://www.espn.com/nba/story', 'https://newsapi.org/story']) {
      const res = await validateEvent(
        makeEvent({ team: 'Boston Celtics', source_url: sourceUrl }),
        teamless(),
        { now: NOW },
      );
      expect(res.softFailures.map((f) => f.code)).toContain('team_unverifiable');
      expect(res.hardFailures.map((f) => f.code)).not.toContain('team_mismatch');
    }
  });

  it('makes no team correction — there is nothing to correct toward', async () => {
    const res = await validateEvent(makeEvent({ team: 'Anything At All' }), teamless(), { now: NOW });
    expect(res.corrections.find((c) => c.field === 'team')).toBeUndefined();
  });

  it('does not fire for UFC, where fighters have no team by design', async () => {
    const res = await validateEvent(
      makeEvent({ sport: 'UFC', team: 'N/A', athlete_name: 'Some Fighter' }),
      teamless(),
      { now: NOW },
    );
    expect(res.softFailures.map((f) => f.code)).not.toContain('team_unverifiable');
  });

  it('does not fire when the player resolved ambiguously (identity_ambiguous covers it)', async () => {
    const res = await validateEvent(
      makeEvent({ team: 'Anything At All' }),
      makePlayer({ ...teamless(), confidence: 'ambiguous', match_count: 2 }),
      { now: NOW },
    );
    const codes = res.softFailures.map((f) => f.code);
    expect(codes).toContain('identity_ambiguous');
    expect(codes).not.toContain('team_unverifiable');
  });
});

describe('validateEvent — identity resolution', () => {
  it('does not soft-fail identity for an unresolved UFC fighter', async () => {
    const res = await validateEvent(
      makeEvent({ sport: 'UFC', team: 'N/A', athlete_name: 'Some Fighter' }),
      null,
      { now: NOW },
    );
    expect(res.softFailures.map((f) => f.code)).not.toContain('identity_unresolvable');
  });

  it('soft-fails identity and team when a non-UFC player is unresolved', async () => {
    const res = await validateEvent(makeEvent({ sport: 'NBA' }), null, { now: NOW });
    const codes = res.softFailures.map((f) => f.code);
    expect(codes).toContain('identity_unresolvable');
    expect(codes).toContain('team_unverified');
    expect(res.passed).toBe(true);
  });
});

describe('validateEvent — date sanity', () => {
  it('hard-fails a future reported_at beyond skew tolerance', async () => {
    const res = await validateEvent(
      makeEvent({ reported_at: new Date('2026-05-03T00:00:00Z') }),
      makePlayer(),
      { now: NOW },
    );
    expect(res.hardFailures.map((f) => f.code)).toContain('date_future');
  });

  it('hard-fails a stale BREAKING event older than 14 days', async () => {
    const res = await validateEvent(
      makeEvent({ reported_at: new Date('2026-04-01T00:00:00Z') }),
      makePlayer(),
      { now: NOW, contentTypeHint: 'BREAKING' },
    );
    expect(res.hardFailures.map((f) => f.code)).toContain('date_stale_breaking');
  });
});

describe('validateEvent — soft signals', () => {
  it('soft-flags laterality stated with a spinal body part', async () => {
    const res = await validateEvent(
      makeEvent({ injury_description: 'left neck strain' }),
      makePlayer(),
      { now: NOW },
    );
    expect(res.softFailures.map((f) => f.code)).toContain('laterality_inconsistent');
  });

  it('soft-flags a low-tier / unknown source', async () => {
    const res = await validateEvent(
      makeEvent({ source_url: 'https://randomblog.example/story' }),
      makePlayer(),
      { now: NOW },
    );
    expect(res.softFailures.map((f) => f.code)).toContain('source_tier_low');
  });
});

describe('teamClaimCheck — post-Sonnet recheck helper (F7)', () => {
  it('returns match for a correct team claim', () => {
    expect(teamClaimCheck('Los Angeles Lakers', makePlayer())).toBe('match');
  });

  it('returns mismatch for a co-located wrong team claim', () => {
    expect(teamClaimCheck('Los Angeles Clippers', makePlayer({ current_team_abbreviation: null }))).toBe(
      'mismatch',
    );
  });

  it('returns uncheckable — NOT match — when the roster carries no team info', () => {
    // This is the F9 fail-open at its most dangerous: the value being checked is
    // Sonnet's own invented team, so a "match" here means publishing a fabricated
    // team with nothing to compare it against.
    const player = makePlayer({ current_team_name: null, current_team_abbreviation: null });
    expect(teamClaimCheck('Anything At All', player)).toBe('uncheckable');
  });
});
