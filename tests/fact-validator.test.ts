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
  it('now soft-fails identity for an unresolved UFC fighter', async () => {
    // Reversed deliberately. While UFC had no roster, an unresolved fighter was
    // the expected state of every event in the sport and flagging it would have
    // sent all of them to MD review. Fighters are now synced from ESPN's card
    // window and minted on sight from an article's own athlete tag, so failing
    // to resolve one means something went wrong — and it means this event gets
    // no entity, no thread and no laterality check, which is worth a look.
    const res = await validateEvent(
      makeEvent({ sport: 'UFC', team: 'N/A', athlete_name: 'Some Fighter' }),
      null,
      { now: NOW },
    );
    const codes = res.softFailures.map((f) => f.code);
    expect(codes).toContain('identity_unresolvable');
    // The TEAM codes stay exempt: a fighter has no team by the structure of the
    // sport, so there is nothing to verify and nothing to report as missing.
    expect(codes).not.toContain('team_unverified');
    expect(res.passed).toBe(true);
  });

  it('does not soft-fail team codes for a resolved but teamless fighter', async () => {
    // The shape a synced fighter actually has: a player row with
    // current_team_id NULL. Without the isTeamSport exemption this branch would
    // put every UFC post in the MD queue.
    const res = await validateEvent(
      makeEvent({ sport: 'UFC', team: 'UFC', athlete_name: 'Conor McGregor' }),
      makePlayer({
        full_name: 'Conor McGregor',
        current_team_id: null,
        current_team_name: null,
        current_team_abbreviation: null,
      }),
      { now: NOW },
    );
    const codes = res.softFailures.map((f) => f.code);
    expect(codes).not.toContain('team_unverifiable');
    expect(codes).not.toContain('identity_unresolvable');
    expect(res.passed).toBe(true);
  });

  it('soft-fails identity and team when a team-sport player is unresolved', async () => {
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

/**
 * Body-part extraction: four part names are also ordinary English words, and
 * injury prose is full of them. Both cases below are live production strings.
 *
 * The damage was not cosmetic. primary_body_part keys web_find_matching_entity,
 * so a wrong one creates and then feeds a wrong clinical thread; and 'back',
 * 'head' and 'neck' are in SPINAL_PARTS, so extracting one alongside a stated
 * side raises laterality_inconsistent — a soft failure, which becomes
 * forceMDReviewReason, which bypasses the confidence gate entirely.
 */
describe('validateEvent — body parts that are also English words', () => {
  // ESPN, Jonathan Greenard, 2026-08-11. This produced primary_body_part
  // 'back' (BODY_PARTS list order put it ahead of 'pectoral') and a live
  // entity reading "back / surgery" for a pectoralis injury.
  const GREENARD =
    'Not Specified Torso Pectoral Surgery — out — Status: Out — Defensive ' +
    'coordinator Vic Fangio said Tuesday that Greenard (pectoral) won\'t be ' +
    'back at practice "for another couple weeks, at least," Tim McManus of ' +
    'ESPN.com reports.';

  // ESPN, Alec Pierce, 2026-08-17. "Head coach" + a stated side of Left was
  // the whole of soft_fact=1 in the 2026-08-18 cycle.
  const PIERCE =
    'Left Leg Ankle Surgery — out — Status: Out — Head coach Shane Steichen ' +
    "said Sunday that he doesn't expect Pierce (ankle) to return during joint " +
    'practices leading up to the Colts\' second preseason game.';

  it('does not read "won\'t be back at practice" as a back injury', async () => {
    const res = await validateEvent(makeEvent({ injury_description: GREENARD }), makePlayer(), {
      now: new Date('2026-08-12T00:00:00Z'),
    });
    expect(res.metadata.body_parts).not.toContain('back');
    expect(res.metadata.primary_body_part).toBe('pectoral');
  });

  it('does not read "Head coach" as a head injury, or flag its laterality', async () => {
    const res = await validateEvent(makeEvent({ injury_description: PIERCE }), makePlayer(), {
      now: new Date('2026-08-18T00:00:00Z'),
    });
    expect(res.metadata.body_parts).not.toContain('head');
    expect(res.metadata.primary_body_part).toBe('ankle');
    expect(res.metadata.laterality).toBe('LEFT');
    expect(res.softFailures.map((f) => f.code)).not.toContain('laterality_inconsistent');
  });

  it('still reads a genuinely anatomical use', async () => {
    const cases: Array<[string, string]> = [
      ['lower back tightness', 'back'],
      ['back spasms limited him in practice', 'back'],
      ['underwent back surgery on Tuesday', 'back'],
      ['Head coach said he fractured his hand', 'hand'],
      ['right hand fracture', 'hand'],
      ['injured his neck on the play', 'neck'],
      ['head injury sustained on a helmet-to-helmet hit', 'head'],
    ];
    for (const [description, expected] of cases) {
      const res = await validateEvent(makeEvent({ injury_description: description }), makePlayer(), {
        now: NOW,
      });
      expect(res.metadata.primary_body_part, description).toBe(expected);
    }
  });

  // ESPN's house style, and the most common anatomical reference in their
  // prose: the injury in a bare parenthetical after the athlete's surname. No
  // adjacency rule can see it — the neighbours are a surname and a verb.
  it('reads the "Player (back)" parenthetical', async () => {
    const cases: Array<[string, string]> = [
      ['Bates (back) returned to practice Monday.', 'back'],
      ['The Cardinals placed Blount (neck) on injured reserve.', 'neck'],
      ['Carter (hand) was a full participant Tuesday.', 'hand'],
    ];
    for (const [description, expected] of cases) {
      const res = await validateEvent(makeEvent({ injury_description: description }), makePlayer(), {
        now: NOW,
      });
      expect(res.metadata.primary_body_part, description).toBe(expected);
    }
  });

  it('distinguishes "his back" from "the back" — and from "the head coach"', async () => {
    const possessive = await validateEvent(
      makeEvent({ injury_description: 'Downs left after landing hard on his back.' }),
      makePlayer(),
      { now: NOW },
    );
    expect(possessive.metadata.primary_body_part).toBe('back');

    const article = await validateEvent(
      makeEvent({ injury_description: 'The head coach said he is the No. 2 running back.' }),
      makePlayer(),
      { now: NOW },
    );
    expect(article.metadata.body_parts).toEqual([]);
  });

  it('orders parts by where they appear, not by the BODY_PARTS list', async () => {
    // 'ankle' sits above 'shoulder' in the list; the sentence says otherwise.
    const res = await validateEvent(
      makeEvent({ injury_description: 'shoulder subluxation, plus a minor ankle sprain' }),
      makePlayer(),
      { now: NOW },
    );
    expect(res.metadata.body_parts).toEqual(['shoulder', 'ankle']);
  });
});

/**
 * ESPN's injuries feed carries a fielded `details` block — the same facts the
 * prose summary is BUILT from. Reading the fields beats scraping them back out.
 */
describe('validateEvent — structured injury details', () => {
  it('prefers the source\'s own fields over the prose', async () => {
    const res = await validateEvent(
      makeEvent({
        // The prose alone yields no body part, no side and no procedure — every
        // one of the three assertions below can only come from the fields.
        injury_description: 'Status: Out — Head coach Vic Fangio said he is week to week',
        injury_details: { type: 'Pectoral', location: 'Torso', detail: 'Surgery', side: 'Left' },
      }),
      makePlayer(),
      { now: NOW },
    );
    expect(res.metadata.primary_body_part).toBe('pectoral');
    expect(res.metadata.laterality).toBe('LEFT');
    expect(res.metadata.injury_type_hint).toBe('surgery');
  });

  // Passes in both directions by design: "Not Specified" must not be mistaken
  // for an answer, and the text's own side must survive the fields being read.
  it('treats "Not Specified" as no answer, so the text still gets its turn', async () => {
    const res = await validateEvent(
      makeEvent({
        injury_description: 'right knee sprain',
        injury_details: { type: 'Knee', location: 'Leg', side: 'Not Specified' },
      }),
      makePlayer(),
      { now: NOW },
    );
    expect(res.metadata.laterality).toBe('RIGHT');
  });
});

/**
 * x.com is deliberately NOT in data/source-tiers.json, so hostname tiering
 * returns 'unknown' and every X insider event soft-failed source_tier_low —
 * which silently overrode X_INSIDER_FORCE_MD_REVIEW=false and made the whole
 * source review-only. Tiering is now keyed on provenance (`source_name`, set by
 * our fetcher only after the numeric-userId allowlist check), never on the URL.
 *
 * The URLs below are the two real ones this actually happened to in production:
 * Mariota (Schefter) and Mekari (Rapoport).
 */
describe('validateEvent — X insider provenance tiering', () => {
  const X_URL = 'https://x.com/RapSheet/status/2089506345070342458';

  it('does not soft-flag an event that came through the X insider allowlist', async () => {
    const res = await validateEvent(
      makeEvent({ source_url: X_URL, source_name: 'X:RapSheet' }),
      makePlayer(),
      { now: NOW },
    );
    expect(res.softFailures.map((f) => f.code)).not.toContain('source_tier_low');
  });

  it('still soft-flags an x.com URL that did NOT come from the allowlist', async () => {
    // The security case. A bare x.com URL — from the mention monitor, a
    // user-submitted correction, or anything else — must not inherit insider
    // trust. If this ever passes, tiering has drifted back onto the hostname.
    const res = await validateEvent(
      makeEvent({ source_url: 'https://x.com/SomeRandomAccount/status/1' }),
      makePlayer(),
      { now: NOW },
    );
    expect(res.softFailures.map((f) => f.code)).toContain('source_tier_low');
  });

  it('does not treat a non-X source_name as insider provenance', async () => {
    const res = await validateEvent(
      makeEvent({ source_url: X_URL, source_name: 'newsapi-nfl' }),
      makePlayer(),
      { now: NOW },
    );
    expect(res.softFailures.map((f) => f.code)).toContain('source_tier_low');
  });

  it('routes a team mismatch on an X insider event to review instead of dropping it', async () => {
    // Before: x.com scored 'unknown', so the tier gate took the T3 branch and
    // HARD-dropped the event — a trade-plus-injury scoop, which is exactly what
    // these accounts break, vanished with no review.
    const res = await validateEvent(
      makeEvent({
        source_url: 'https://x.com/AdamSchefter/status/2089003329997144213',
        source_name: 'X:AdamSchefter',
        team: 'Los Angeles Clippers',
      }),
      makePlayer({ current_team_abbreviation: null }),
      { now: NOW },
    );
    expect(res.passed).toBe(true);
    expect(res.hardFailures.map((f) => f.code)).not.toContain('team_mismatch');
    expect(res.softFailures.map((f) => f.code)).toContain('team_mismatch_unconfirmed');
    // The reported team must survive to Sonnet and MD review — overwriting it
    // with the possibly-stale roster team is the false-drop this branch prevents.
    expect(res.corrections.map((c) => c.field)).not.toContain('team');
  });

  it('hard-drops the same team mismatch when provenance is absent', async () => {
    const res = await validateEvent(
      makeEvent({
        source_url: 'https://x.com/AdamSchefter/status/2089003329997144213',
        team: 'Los Angeles Clippers',
      }),
      makePlayer({ current_team_abbreviation: null }),
      { now: NOW },
    );
    expect(res.passed).toBe(false);
    expect(res.hardFailures.map((f) => f.code)).toContain('team_mismatch');
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
