/**
 * Athlete re-anchor — following the classifier when the SOURCE tagged the wrong
 * athlete.
 *
 * The production shape, recurring every 6h cycle since 2026-08-17. ESPN's NFL
 * injuries feed served a row for Tyler Allgeier — status "Active", details null
 * — whose comment reads:
 *
 *   "Allgeier could open the regular season as the Cardinals' primary running
 *    back, as Adam Schefter of ESPN reports that Jeremiyah Love sustained a
 *    high-ankle sprain in Thursday's preseason win over the Raiders."
 *
 * Haiku correctly answered "Jeremiah Love". The drift guard treated that as a
 * reason to distrust the post, forced MD review, scored significance on
 * Allgeier's tier, and minted an ankle-sprain entity against Allgeier's player
 * row (live: d31bc02a). Three separate wrong things from one correct
 * classification.
 *
 * Note the spelling: the roster holds "Jeremiyah Love" and web_resolve_player
 * matches an exact normalized name, so the classifier's spelling resolves to
 * NOTHING. Re-anchoring has to go through the source text to find the spelling
 * the roster is keyed on — which is also the guard that stops the model from
 * naming anyone it likes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  applyAthleteReanchor,
  attemptAthleteReanchor,
  buildReanchorCandidates,
  editDistance,
  getReanchorMode,
  isHealthyFeedStatus,
  isReanchorEligible,
  isSurnameReference,
  surnameKey,
  type ReanchorOutcome,
} from '../src/monitoring/athlete-reanchor.js';
import {
  _setTiersForTesting,
  computeSignificance,
  loadSignificanceData,
} from '../src/agents/injury-intelligence/significance.js';
import type { ResolvedPlayerInfo } from '../src/agents/injury-intelligence/fact-validator.js';
import type { ClassificationResult, RawInjuryEvent } from '../src/types.js';

const ALLGEIER_TEXT =
  'active — Status: Active — Allgeier could open the regular season as the ' +
  "Cardinals' primary running back, as Adam Schefter of ESPN reports that " +
  'Jeremiyah Love sustained a high-ankle sprain in Thursday\'s preseason win ' +
  'over the Raiders.';

function player(overrides: Partial<ResolvedPlayerInfo> = {}): ResolvedPlayerInfo {
  return {
    player_id: 'player-love',
    full_name: 'Jeremiyah Love',
    current_team_id: 'team-ari',
    current_team_name: 'Cardinals',
    current_team_abbreviation: 'ARI',
    prominence_tier: null,
    confidence: 'normalized',
    match_count: 1,
    ...overrides,
  };
}

const ALLGEIER = player({
  player_id: 'player-allgeier',
  full_name: 'Tyler Allgeier',
});

function makeEvent(overrides: Partial<RawInjuryEvent> = {}): RawInjuryEvent {
  return {
    athlete_name: 'Tyler Allgeier',
    sport: 'NFL',
    team: 'Arizona Cardinals',
    injury_description: ALLGEIER_TEXT,
    source_url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries',
    reported_at: new Date('2026-08-17T02:04:00Z'),
    source_name: 'espn-nfl',
    source_kind: 'feed',
    athlete_status: 'Active',
    ...overrides,
  };
}

function makeClassified(
  event: RawInjuryEvent,
  athleteName = 'Jeremiah Love',
): ClassificationResult {
  return {
    is_injury_event: true,
    confidence: 0.9,
    sport: 'NFL',
    athlete_name: athleteName,
    team: 'Arizona Cardinals',
    injury_description: 'High ankle sprain',
    content_type: 'BREAKING',
    is_new: true,
    raw_event: event,
    significance: computeSignificance(
      3,
      'default',
      { information_specificity: 70, event_recency_novelty: 90 },
      'BREAKING',
      'NFL',
      new Date('2026-08-18T00:00:00Z'),
    ),
  };
}

/** Roster stub: exact-normalized-name lookup, like web_resolve_player. */
function roster(map: Record<string, ResolvedPlayerInfo | null>) {
  return async (name: string) => map[name.toLowerCase()] ?? null;
}

const LIVE_ROSTER = roster({
  'jeremiyah love': player(),
  'tyler allgeier': ALLGEIER,
  // "Jeremiah Love" is deliberately absent — the classifier's spelling is not
  // in the roster, which is the whole reason candidates come from the text.
});

beforeAll(async () => {
  await loadSignificanceData();
});

beforeEach(() => {
  vi.stubEnv('ATHLETE_REANCHOR_MODE', 'on');
});

afterEach(() => {
  vi.unstubAllEnvs();
  _setTiersForTesting(null);
});

describe('mode', () => {
  it('defaults to shadow — a first deploy may only describe what it would do', () => {
    vi.stubEnv('ATHLETE_REANCHOR_MODE', '');
    expect(getReanchorMode()).toBe('shadow');
  });

  it('reads off / shadow / on, and treats anything else as shadow', () => {
    vi.stubEnv('ATHLETE_REANCHOR_MODE', 'off');
    expect(getReanchorMode()).toBe('off');
    vi.stubEnv('ATHLETE_REANCHOR_MODE', 'ON');
    expect(getReanchorMode()).toBe('on');
    vi.stubEnv('ATHLETE_REANCHOR_MODE', 'yes-please');
    expect(getReanchorMode()).toBe('shadow');
  });

  it('never re-anchors when off', async () => {
    vi.stubEnv('ATHLETE_REANCHOR_MODE', 'off');
    const event = makeEvent();
    const outcome = await attemptAthleteReanchor(event, makeClassified(event), {
      resolvePlayer: LIVE_ROSTER,
    });
    expect(outcome).toEqual({ kind: 'review', reason: 'disabled' });
  });
});

describe('eligibility — whose row is this?', () => {
  it('accepts a feed row for a healthy athlete: it is carrying teammate news', () => {
    expect(isHealthyFeedStatus('Active')).toBe(true);
    expect(isReanchorEligible(makeEvent({ athlete_status: 'Active' }))).toBe(true);
  });

  it('refuses a feed row for an injured athlete — the tag is about them', () => {
    for (const status of ['Out', 'Questionable', 'Doubtful', 'Day-To-Day']) {
      expect(isHealthyFeedStatus(status)).toBe(false);
      expect(isReanchorEligible(makeEvent({ athlete_status: status }))).toBe(false);
    }
  });

  it('refuses a feed row with no status at all', () => {
    // Absence of evidence that the athlete is healthy is not evidence that
    // they are. Fail closed.
    expect(isReanchorEligible(makeEvent({ athlete_status: undefined }))).toBe(false);
  });

  it('accepts any article — its tag is a first-capitalized-bigram guess', () => {
    expect(
      isReanchorEligible(makeEvent({ source_kind: 'article', athlete_status: undefined })),
    ).toBe(true);
  });
});

describe('candidates', () => {
  it("finds the source's spelling of the classifier's athlete, and nobody else", () => {
    const candidates = buildReanchorCandidates(ALLGEIER_TEXT, 'Jeremiah Love');
    expect(candidates[0]).toEqual({ name: 'Jeremiyah Love', from: 'text' });
    // Adam Schefter (the reporter) and Tyler Allgeier (the tagged teammate) are
    // both capitalized bigrams in this text. Neither shares Love's surname.
    expect(candidates.map((c) => c.name)).not.toContain('Adam Schefter');
    expect(candidates.map((c) => c.name)).not.toContain('Tyler Allgeier');
  });

  it("keeps the classifier's own spelling as a fallback candidate", () => {
    const candidates = buildReanchorCandidates(ALLGEIER_TEXT, 'Jeremiah Love');
    expect(candidates.at(-1)).toEqual({ name: 'Jeremiah Love', from: 'classifier' });
  });

  it('strips the possessive so "Love\'s" matches Love', () => {
    const candidates = buildReanchorCandidates(
      "Jeremiyah Love's ankle kept him out of Thursday's win",
      'Jeremiah Love',
    );
    expect(candidates[0].name).toBe('Jeremiyah Love');
  });

  it('will not cross to a different person with the same first name', () => {
    const candidates = buildReanchorCandidates(
      'Jeremiah Owusu-Koramoah left the game',
      'Jeremiah Love',
    );
    expect(candidates.filter((c) => c.from === 'text')).toHaveLength(0);
  });

  it('will not cross first names that merely share a surname', () => {
    // A different initial is a different person, however close the spelling.
    expect(editDistance('jeremiyah', 'jeremiah')).toBe(1);
    const candidates = buildReanchorCandidates('Mike Love was limited', 'Jeremiah Love');
    expect(candidates.filter((c) => c.from === 'text')).toHaveLength(0);
  });

  it('normalizes surnames the way athlete identity is normalized elsewhere', () => {
    expect(surnameKey('Marvin Harrison Jr.')).toBe(surnameKey('Marvin Harrison'));
  });
});

describe('attemptAthleteReanchor', () => {
  it('re-anchors the live Allgeier→Love case onto the roster spelling', async () => {
    _setTiersForTesting({
      version: 1,
      updated_at: '2026-08-18',
      athletes: [{ name: 'Jeremiyah Love', sport: 'NFL', tier: 2 }],
    } as never);

    const event = makeEvent();
    const outcome = await attemptAthleteReanchor(event, makeClassified(event), {
      resolvePlayer: LIVE_ROSTER,
    });

    expect(outcome.kind).toBe('reanchored');
    const reanchored = outcome as Extract<ReanchorOutcome, { kind: 'reanchored' }>;
    expect(reanchored.from).toBe('Tyler Allgeier');
    expect(reanchored.to).toBe('Jeremiyah Love');
    expect(reanchored.candidateFrom).toBe('text');
    expect(reanchored.tier.tier).toBe(2);
  });

  it('calls two spellings of one player row a spelling variant, not drift', async () => {
    const event = makeEvent({ athlete_name: 'A.J. Brown', source_kind: 'article' });
    const brown = player({ player_id: 'player-brown', full_name: 'A.J. Brown' });
    const outcome = await attemptAthleteReanchor(
      { ...event, injury_description: 'AJ Brown hamstring strain' },
      makeClassified(event, 'AJ Brown'),
      { resolvePlayer: roster({ 'a.j. brown': brown, 'aj brown': brown }) },
    );
    expect(outcome.kind).toBe('spelling_variant');
  });

  it('refuses an ambiguous roster match', async () => {
    const outcome = await attemptAthleteReanchor(makeEvent(), makeClassified(makeEvent()), {
      resolvePlayer: roster({
        'jeremiyah love': player({ confidence: 'ambiguous', match_count: 2 }),
        'tyler allgeier': ALLGEIER,
      }),
    });
    expect(outcome).toEqual({ kind: 'review', reason: 'ambiguous' });
  });

  it('refuses to adopt a name the source text never mentions', async () => {
    // The model naming someone not in the article is the failure this guard
    // exists for: without it a roundup lets it pick any player it likes.
    const event = makeEvent({
      injury_description: 'Status: Active — Allgeier is expected to start Sunday.',
    });
    const outcome = await attemptAthleteReanchor(event, makeClassified(event), {
      resolvePlayer: LIVE_ROSTER,
    });
    expect(outcome).toEqual({ kind: 'review', reason: 'not_text_anchored' });
  });

  it('refuses when the tagged athlete is themselves injured', async () => {
    const event = makeEvent({ athlete_status: 'Out' });
    const outcome = await attemptAthleteReanchor(event, makeClassified(event), {
      resolvePlayer: LIVE_ROSTER,
    });
    expect(outcome).toEqual({ kind: 'review', reason: 'ineligible' });
  });

  it('skips the second-hand row when the injured athlete has their own event', async () => {
    const event = makeEvent();
    const loveOwnRow = makeEvent({
      athlete_name: 'Jeremiyah Love',
      athlete_status: 'Out',
      injury_description: 'Right Leg Ankle Sprain — out',
    });
    const outcome = await attemptAthleteReanchor(event, makeClassified(event), {
      resolvePlayer: LIVE_ROSTER,
      cycleEvents: [event, loveOwnRow],
    });
    expect(outcome).toEqual({
      kind: 'skip',
      reason: 'redundant_teammate_mention',
      to: 'Jeremiyah Love',
    });
  });

  it('reviews when no candidate resolves against the roster', async () => {
    const event = makeEvent();
    const outcome = await attemptAthleteReanchor(event, makeClassified(event), {
      resolvePlayer: roster({ 'tyler allgeier': ALLGEIER }),
    });
    expect(outcome).toEqual({ kind: 'review', reason: 'unresolvable' });
  });
});

describe('applyAthleteReanchor', () => {
  function reanchoredOutcome(): Extract<ReanchorOutcome, { kind: 'reanchored' }> {
    return {
      kind: 'reanchored',
      from: 'Tyler Allgeier',
      to: 'Jeremiyah Love',
      player: player(),
      candidateFrom: 'text',
      tier: { tier: 2, source: 'lookup' },
    };
  }

  it('re-points both the event and the classification at the roster name', () => {
    const event = makeEvent();
    const classified = makeClassified(event);
    applyAthleteReanchor(event, classified, reanchoredOutcome());

    expect(event.athlete_name).toBe('Jeremiyah Love');
    expect(classified.athlete_name).toBe('Jeremiyah Love');
    // classified.raw_event is the same object; downstream reads both.
    expect(classified.raw_event.athlete_name).toBe('Jeremiyah Love');
  });

  it("drops the tagged athlete's ESPN id", () => {
    // resolvePlayer tries the id BEFORE the name, so leaving it would resolve
    // the re-anchored event straight back to the athlete we just left — and on
    // a register-on-sight sport, mint the new name under the old id.
    const event = makeEvent({ espn_athlete_id: '4429795' });
    applyAthleteReanchor(event, makeClassified(event), reanchoredOutcome());
    expect(event.espn_athlete_id).toBeUndefined();
  });

  it("takes the team from the roster on a feed event", () => {
    const event = makeEvent();
    const classified = makeClassified(event);
    applyAthleteReanchor(event, classified, reanchoredOutcome());
    expect(event.team).toBe('Cardinals');
    expect(classified.team).toBe('Cardinals');
  });

  it('leaves an article event\'s team alone — it came from the text', () => {
    const event = makeEvent({ source_kind: 'article', team: 'Arizona Cardinals' });
    applyAthleteReanchor(event, makeClassified(event), reanchoredOutcome());
    expect(event.team).toBe('Arizona Cardinals');
  });

  it('re-scores prominence on the new athlete and keeps the report subscores', () => {
    const event = makeEvent();
    const classified = makeClassified(event);
    const before = classified.significance!;
    expect(before.subscores.athlete_prominence).toBe(40); // tier 3

    applyAthleteReanchor(event, classified, reanchoredOutcome());

    const after = classified.significance!;
    expect(after.athlete_tier).toBe(2);
    expect(after.subscores.athlete_prominence).toBe(70);
    expect(after.composite_score).toBeGreaterThan(before.composite_score);
    // The two Haiku subscores describe the REPORT, not the athlete.
    expect(after.subscores.information_specificity).toBe(
      before.subscores.information_specificity,
    );
    expect(after.subscores.event_recency_novelty).toBe(before.subscores.event_recency_novelty);
  });
});

/**
 * A bare surname is not a different athlete.
 *
 * ESPN's comment style names the athlete by surname alone — "Kittle (Achilles)
 * said Sunday…", "Nabers (knee) logged reps…", "Monangai (knee) is considered
 * week-to-week". Asking the classifier to copy the description's spelling made
 * it answer "Kittle" where the feed row said "George Kittle", and the drift
 * guard read that as a different person: name_drift went 1 → 9 in a single NFL
 * cycle, seven of them this shape, every one a forced MD review for nothing.
 *
 * It is not only a review-queue problem. post.athlete_name comes from the
 * classifier, and it keys the dedup lookup, the player row and the entity — so
 * a surname-only answer that got past the guard would publish a post filed
 * under "Kittle".
 */
describe('isSurnameReference', () => {
  it('recognizes the source\'s own surname standing in for the full name', () => {
    expect(isSurnameReference('George Kittle', 'Kittle')).toBe(true);
    expect(isSurnameReference('Malik Nabers', 'Nabers')).toBe(true);
    expect(isSurnameReference('Kyle Monangai', 'Monangai')).toBe(true);
  });

  it('tolerates the suffix and punctuation differences sources disagree on', () => {
    expect(isSurnameReference('Marvin Harrison Jr.', 'Harrison')).toBe(true);
    expect(isSurnameReference('A.J. Brown', 'Brown')).toBe(true);
  });

  it('is false for a genuinely different athlete', () => {
    expect(isSurnameReference('Tyler Allgeier', 'Jeremiyah Love')).toBe(false);
    expect(isSurnameReference('Tyler Allgeier', 'Love')).toBe(false);
  });

  it('is false for a different player who shares nothing but a first name', () => {
    expect(isSurnameReference('George Kittle', 'George')).toBe(false);
  });

  it('is false when the classifier gave a full name — that is drift, or nothing', () => {
    expect(isSurnameReference('George Kittle', 'George Kittle')).toBe(false);
    expect(isSurnameReference('George Kittle', 'Travis Kelce')).toBe(false);
  });
});
