/**
 * The resolution rules, one test per approved interpretation (plan §2.3,
 * docs/ledger-preregistration.md). The schedule is a synthetic 2026 season for
 * one team, BUF, with a week-7 bye, so bye handling is exercised by every
 * multi-week case.
 */
import { describe, it, expect } from 'vitest';
import {
  type ScheduleGame,
  type SnapRow,
  type InjuryReportRow,
  type TransactionEvent,
  type LedgerEntryContext,
  type ResolutionFacts,
  resolveF1,
  resolveF2,
  resolveF3,
  resolveF4,
  resolveF5,
  resolveField,
  teamRegularSeasonGames,
  walkToFirstReturn,
  gameCoveredBySnaps,
  bodySitesOf,
  reportNamesSameSite,
  seasonEndingFlag,
  revisionCountsForField,
  remainingRegularSeasonGames,
  gameEvidenceUrl,
} from '../src/ledger/rules.js';
import { addDays } from '../src/ledger/dates.js';

// ── Synthetic season: BUF plays Sundays from 2026-09-13, bye in week 7. ──
const OPENER = '2026-09-13';
const BYE_WEEK = 7;
const SEASON = 2026;

function buildSchedule(completedThroughWeek: number): ScheduleGame[] {
  const games: ScheduleGame[] = [];
  let week = 1;
  for (let i = 0; i < 18; i++) {
    const w = i + 1;
    if (w === BYE_WEEK) continue;
    const gameday = addDays(OPENER, i * 7);
    games.push({
      game_id: `2026_${String(w).padStart(2, '0')}_OPP_BUF`,
      season: SEASON,
      game_type: 'REG',
      week: w,
      gameday,
      gametime: '13:00',
      away_team: 'OPP',
      home_team: 'BUF',
      completed: w <= completedThroughWeek,
      pfr_game_id: `${gameday.replace(/-/g, '')}0buf`,
    });
    week++;
  }
  // A postseason game and another team's game, both of which must be ignored.
  games.push({ game_id: '2027_19_BUF_KC', season: SEASON, game_type: 'POST', week: 19, gameday: '2027-01-17', gametime: '16:30', away_team: 'BUF', home_team: 'KC', completed: false });
  games.push({ game_id: '2026_01_NE_SEA', season: SEASON, game_type: 'REG', week: 1, gameday: '2026-09-09', gametime: '20:20', away_team: 'NE', home_team: 'SEA', completed: true });
  void week;
  return games;
}

const PFR = 'ExamPl00';
const GSIS = '00-0099999';

/** Snap rows: a filler row per completed game (so the game is "covered") plus the athlete's rows for `playedWeeks`. */
function buildSnaps(schedule: ScheduleGame[], playedWeeks: number[], opts: { uncoveredWeeks?: number[] } = {}): SnapRow[] {
  const rows: SnapRow[] = [];
  for (const g of schedule.filter((g) => g.completed && g.game_type === 'REG' && g.home_team === 'BUF')) {
    if (opts.uncoveredWeeks?.includes(g.week)) continue;
    rows.push({ game_id: g.game_id, pfr_player_id: 'Filler00', team: 'BUF', offense_snaps: 60, defense_snaps: 0, st_snaps: 0 });
    if (playedWeeks.includes(g.week)) {
      rows.push({ game_id: g.game_id, pfr_player_id: PFR, team: 'BUF', offense_snaps: 1, defense_snaps: 0, st_snaps: 0 });
    }
  }
  return rows;
}

function ctx(over: Partial<LedgerEntryContext> = {}): LedgerEntryContext {
  return {
    entry_id: 'PT-2026-001',
    injury_date: '2026-09-20', // hurt in the week 2 game
    team: 'BUF',
    season: SEASON,
    pfr_id: PFR,
    gsis_id: GSIS,
    reported_injury: 'Grade 2 hamstring strain',
    base_rate_row: 'hamstring_strain',
    v1_published_at: '2026-09-20T22:00:00.000Z',
    ...over,
  };
}

function facts(over: Partial<ResolutionFacts> & { completedThroughWeek?: number; playedWeeks?: number[]; uncoveredWeeks?: number[] } = {}): ResolutionFacts {
  const schedule = over.schedule ?? buildSchedule(over.completedThroughWeek ?? 4);
  return {
    schedule,
    snaps: over.snaps ?? buildSnaps(schedule, over.playedWeeks ?? [1, 2], { uncoveredWeeks: over.uncoveredWeeks }),
    injuries: over.injuries ?? [],
    transactions: over.transactions ?? [],
    today: over.today ?? '2026-10-13',
  };
}

const tx = (kind: TransactionEvent['kind'], date: string): TransactionEvent => ({
  kind,
  date,
  team: 'BUF',
  sentence: `${kind} sentence`,
  url: 'https://www.espn.com/nfl/transactions',
});

describe('schedule helpers', () => {
  it('keeps only the team\'s regular-season games, in kickoff order, and byes are simply absent', () => {
    const games = teamRegularSeasonGames(buildSchedule(18), 'BUF', SEASON);
    expect(games).toHaveLength(17);
    expect(games.map((g) => g.week)).not.toContain(BYE_WEEK);
    expect(games.every((g) => g.game_type === 'REG')).toBe(true);
    expect(remainingRegularSeasonGames(games, '2026-09-20')).toBe(15);
  });

  it('the evidence URL is the PFR boxscore when the schedule has the id', () => {
    const [g] = teamRegularSeasonGames(buildSchedule(1), 'BUF', SEASON);
    expect(gameEvidenceUrl(g)).toBe('https://www.pro-football-reference.com/boxscores/202609130buf.htm');
    expect(gameEvidenceUrl({ ...g, pfr_game_id: null, espn_event_id: '401' })).toBe('https://www.espn.com/nfl/game/_/gameId/401');
  });

  it('a game with no snap rows at all is uncovered, and the walk stops there rather than calling it a miss', () => {
    const schedule = buildSchedule(5);
    const snaps = buildSnaps(schedule, [1, 2, 5], { uncoveredWeeks: [4] });
    expect(gameCoveredBySnaps(snaps, '2026_04_OPP_BUF')).toBe(false);
    const walk = walkToFirstReturn(teamRegularSeasonGames(schedule, 'BUF', SEASON), snaps, PFR, '2026-09-20');
    expect(walk.kind).toBe('awaiting_snap_counts');
    if (walk.kind === 'awaiting_snap_counts') {
      expect(walk.game.week).toBe(4);
      expect(walk.missed.map((g) => g.week)).toEqual([3]);
    }
  });
});

describe('F1 — IR within 7 days (transaction wire)', () => {
  it('resolves 1 on an IR transaction dated within day 7, frozen at the start of that day', () => {
    const d = resolveF1(ctx(), facts({ transactions: [tx('IR', '2026-09-23')] }));
    expect(d).toMatchObject({ status: 'resolved', outcome: 1, resolved_at: '2026-09-23', freeze_at: '2026-09-23T04:00:00.000Z' });
  });

  it('an IR on day 7 itself counts; day 8 does not', () => {
    expect(resolveF1(ctx(), facts({ transactions: [tx('IR', '2026-09-27')] }))).toMatchObject({ status: 'resolved', outcome: 1 });
    const late = resolveF1(ctx(), facts({ transactions: [tx('IR', '2026-09-28')], today: '2026-09-29' }));
    expect(late).toMatchObject({ status: 'resolved', outcome: 0, resolved_at: '2026-09-27' });
  });

  it('stays open through day 7 and resolves 0 after it, frozen at the end of day 7 in New York', () => {
    expect(resolveF1(ctx(), facts({ today: '2026-09-27' }))).toMatchObject({ status: 'open', reason: 'before_resolution_window' });
    expect(resolveF1(ctx(), facts({ today: '2026-09-28' }))).toMatchObject({
      status: 'resolved',
      outcome: 0,
      resolved_at: '2026-09-27',
      freeze_at: '2026-09-28T04:00:00.000Z',
    });
  });

  it('a trade before the IR voids the field; a trade after it does not', () => {
    expect(resolveF1(ctx(), facts({ transactions: [tx('TRADE', '2026-09-21'), tx('IR', '2026-09-24')] }))).toMatchObject({ status: 'void', void_reason: 'traded' });
    expect(resolveF1(ctx(), facts({ transactions: [tx('IR', '2026-09-22'), tx('RELEASE', '2026-09-25')] }))).toMatchObject({ status: 'resolved', outcome: 1 });
  });

  it('is void when v1 was published after day 7 had passed', () => {
    const d = resolveF1(ctx({ v1_published_at: '2026-09-29T12:00:00.000Z' }), facts({ today: '2026-10-01' }));
    expect(d).toMatchObject({ status: 'void', void_reason: 'forecast_after_freeze' });
  });
});

describe('F2 — next scheduled game (gamebook)', () => {
  it('the next game is the first one dated after the injury; the game he was hurt in is not it', () => {
    const d = resolveF2(ctx(), facts({ completedThroughWeek: 2 }));
    expect(d).toMatchObject({ status: 'open', reason: 'game_not_completed', freeze_at: '2026-09-27T17:00:00.000Z' });
  });

  it('resolves 1 when he has a snap, 0 when the game is covered and he has none', () => {
    expect(resolveF2(ctx(), facts({ completedThroughWeek: 3, playedWeeks: [1, 2, 3] }))).toMatchObject({ status: 'resolved', outcome: 1, resolved_at: '2026-09-27' });
    const miss = resolveF2(ctx(), facts({ completedThroughWeek: 3, playedWeeks: [1, 2] }));
    expect(miss).toMatchObject({ status: 'resolved', outcome: 0, resolved_at: '2026-09-27' });
    if (miss.status === 'resolved') expect(miss.evidence.urls[0]).toMatch(/pro-football-reference\.com\/boxscores\/202609270buf\.htm/);
  });

  it('a completed game the snap file has not covered is awaiting, not a miss', () => {
    expect(resolveF2(ctx(), facts({ completedThroughWeek: 3, uncoveredWeeks: [3] }))).toMatchObject({ status: 'open', reason: 'awaiting_snap_counts' });
  });

  it('a bye pushes the next game out by a week', () => {
    // Injured in week 6 (2026-10-18); week 7 is the bye; next game is week 8 (2026-11-01).
    const d = resolveF2(ctx({ injury_date: '2026-10-18', v1_published_at: '2026-10-18T22:00:00.000Z' }), facts({ completedThroughWeek: 6 }));
    expect(d).toMatchObject({ status: 'open', freeze_at: '2026-11-01T18:00:00.000Z' });
  });

  it('is void when there is no later regular-season game, when released beforehand, or when v1 came after kickoff', () => {
    expect(resolveF2(ctx({ injury_date: '2027-01-10', v1_published_at: '2027-01-10T22:00:00.000Z' }), facts({ completedThroughWeek: 18 }))).toMatchObject({ status: 'void', void_reason: 'no_next_game_this_season' });
    expect(resolveF2(ctx(), facts({ completedThroughWeek: 3, transactions: [tx('RELEASE', '2026-09-23')] }))).toMatchObject({ status: 'void', void_reason: 'released' });
    expect(resolveF2(ctx({ v1_published_at: '2026-09-27T17:00:00.000Z' }), facts({ completedThroughWeek: 3 }))).toMatchObject({ status: 'void', void_reason: 'forecast_after_freeze' });
  });

  it('cannot resolve without a PFR id', () => {
    expect(resolveF2(ctx({ pfr_id: null }), facts())).toEqual({ status: 'unresolvable', reason: 'no_pfr_id' });
  });
});

describe('F3 — return within 28 days (gamebook)', () => {
  it('resolves 1 on a return on or before day 28, frozen at that kickoff', () => {
    // Day 28 = 2026-10-18 = the week 6 game. Return in week 6 counts.
    const d = resolveF3(ctx(), facts({ completedThroughWeek: 6, playedWeeks: [1, 2, 6] }));
    expect(d).toMatchObject({ status: 'resolved', outcome: 1, resolved_at: '2026-10-18', freeze_at: '2026-10-18T17:00:00.000Z' });
  });

  it('resolves 0 once every game inside the window is completed and covered and the window has passed', () => {
    const d = resolveF3(ctx(), facts({ completedThroughWeek: 8, playedWeeks: [1, 2, 8], today: '2026-11-02' }));
    expect(d).toMatchObject({ status: 'resolved', outcome: 0, resolved_at: '2026-10-18', freeze_at: '2026-10-19T04:00:00.000Z' });
  });

  it('stays open while the window is running or a window game is uncovered', () => {
    expect(resolveF3(ctx(), facts({ completedThroughWeek: 4, today: '2026-10-05' }))).toMatchObject({ status: 'open', reason: 'game_not_completed' });
    expect(resolveF3(ctx(), facts({ completedThroughWeek: 6, uncoveredWeeks: [5], today: '2026-10-20' }))).toMatchObject({ status: 'open', reason: 'awaiting_snap_counts' });
  });

  it('season end resolves F3 as no, dated the last game', () => {
    // Injured 2027-01-05 (after week 17); only week 18 (2027-01-10) remains inside 28 days.
    const d = resolveF3(ctx({ injury_date: '2027-01-05', v1_published_at: '2027-01-05T22:00:00.000Z' }), facts({ completedThroughWeek: 18, playedWeeks: [], today: '2027-01-12' }));
    expect(d).toMatchObject({ status: 'resolved', outcome: 0, resolved_at: '2027-01-10' });
  });

  it('a trade before the return voids it', () => {
    expect(resolveF3(ctx(), facts({ completedThroughWeek: 6, playedWeeks: [1, 2, 6], transactions: [tx('TRADE', '2026-10-01')] }))).toMatchObject({ status: 'void', void_reason: 'traded' });
  });
});

describe('F4 — games missed (gamebook)', () => {
  it('counts completed games strictly between injury and return; the bye is not a game', () => {
    // Injured week 6 (10-18). Missed week 8 and 9 (bye week 7 is not a row), returned week 10 (11-15).
    const d = resolveF4(ctx({ injury_date: '2026-10-18', v1_published_at: '2026-10-18T22:00:00.000Z' }), facts({ completedThroughWeek: 10, playedWeeks: [1, 2, 3, 4, 5, 6, 10] }));
    expect(d).toMatchObject({ status: 'resolved', outcome: 2, resolved_at: '2026-11-15', freeze_at: '2026-11-15T18:00:00.000Z' });
    if (d.status === 'resolved') expect(d.evidence.game_ids).toEqual(['2026_10_OPP_BUF', '2026_08_OPP_BUF', '2026_09_OPP_BUF']);
  });

  it('a return in the very next game is 0 games missed', () => {
    expect(resolveF4(ctx(), facts({ completedThroughWeek: 3, playedWeeks: [1, 2, 3] }))).toMatchObject({ status: 'resolved', outcome: 0 });
  });

  it('is open while awaiting a return or snap counts', () => {
    expect(resolveF4(ctx(), facts({ completedThroughWeek: 4 }))).toMatchObject({ status: 'open', reason: 'awaiting_return' });
    expect(resolveF4(ctx(), facts({ completedThroughWeek: 4, uncoveredWeeks: [4] }))).toMatchObject({ status: 'open', reason: 'awaiting_snap_counts' });
  });

  it('season end resolves F4 as the games remaining after the injury', () => {
    const d = resolveF4(ctx(), facts({ completedThroughWeek: 18, playedWeeks: [1, 2] }));
    // Weeks 3–18 less the bye = 15 games.
    expect(d).toMatchObject({ status: 'resolved', outcome: 15, resolved_at: '2027-01-10' });
  });

  it('a suspension before the return voids it', () => {
    expect(resolveF4(ctx(), facts({ completedThroughWeek: 5, playedWeeks: [1, 2, 5], transactions: [tx('SUSPEND', '2026-09-30')] }))).toMatchObject({ status: 'void', void_reason: 'suspended' });
  });
});

describe('F5 — same-site re-injury within 6 games of return (injury report + gamebook)', () => {
  const report = (week: number, primary: string, secondary: string | null = null): InjuryReportRow => ({
    season: SEASON,
    week,
    team: 'BUF',
    gsis_id: GSIS,
    report_primary_injury: primary,
    report_secondary_injury: secondary,
    report_status: 'Out',
  });

  it('resolves 1 when a same-site listing appears in the window and a game at or after it is missed', () => {
    // Return week 4 (10-04). Span = weeks 5,6,8,9,10,11. Hamstring listed week 6, missed week 6.
    const d = resolveF5(ctx(), facts({ completedThroughWeek: 11, playedWeeks: [1, 2, 4, 5, 8, 9, 10, 11], injuries: [report(6, 'Hamstring')] }));
    expect(d).toMatchObject({ status: 'resolved', outcome: 1, resolved_at: '2026-10-18', freeze_at: '2026-10-04T17:00:00.000Z' });
  });

  it('a different site on the report does not count, even with a missed game', () => {
    const d = resolveF5(ctx(), facts({ completedThroughWeek: 11, playedWeeks: [1, 2, 4, 5, 8, 9, 10, 11], injuries: [report(6, 'Ankle')] }));
    expect(d).toMatchObject({ status: 'resolved', outcome: 0 });
  });

  it('a same-site listing with no missed game does not count', () => {
    const d = resolveF5(ctx(), facts({ completedThroughWeek: 11, playedWeeks: [1, 2, 4, 5, 6, 8, 9, 10, 11], injuries: [report(6, 'Hamstring')] }));
    expect(d).toMatchObject({ status: 'resolved', outcome: 0, resolved_at: '2026-11-22' });
  });

  it('stays open until the six-game window has been played, and resolves early on a hit', () => {
    expect(resolveF5(ctx(), facts({ completedThroughWeek: 8, playedWeeks: [1, 2, 4, 5, 6, 8] }))).toMatchObject({ status: 'open', reason: 'awaiting_f5_window' });
    expect(resolveF5(ctx(), facts({ completedThroughWeek: 8, playedWeeks: [1, 2, 4, 5, 6], injuries: [report(8, 'Hamstring')] }))).toMatchObject({ status: 'resolved', outcome: 1, resolved_at: '2026-11-01' });
  });

  it('a window cut short by the season end resolves 0 once the season is over, not before', () => {
    // Return week 16 (12-27). Only weeks 17 and 18 remain.
    const c = ctx({ injury_date: '2026-12-13', v1_published_at: '2026-12-13T22:00:00.000Z' });
    expect(resolveF5(c, facts({ completedThroughWeek: 17, playedWeeks: [16, 17] }))).toMatchObject({ status: 'open', reason: 'awaiting_f5_window' });
    expect(resolveF5(c, facts({ completedThroughWeek: 18, playedWeeks: [16, 17, 18] }))).toMatchObject({ status: 'resolved', outcome: 0, resolved_at: '2027-01-10' });
  });

  it('is void by rule for concussion, void when there is no return this season, and unresolvable without a GSIS id', () => {
    expect(resolveF5(ctx({ reported_injury: 'Concussion', base_rate_row: 'concussion' }), facts())).toMatchObject({ status: 'void', void_reason: 'concussion_rule' });
    expect(resolveF5(ctx(), facts({ completedThroughWeek: 18, playedWeeks: [1, 2] }))).toMatchObject({ status: 'void', void_reason: 'no_return_this_season' });
    expect(resolveF5(ctx({ gsis_id: null }), facts())).toEqual({ status: 'unresolvable', reason: 'no_gsis_id' });
  });

  it('a release inside the window voids it', () => {
    const d = resolveF5(ctx(), facts({ completedThroughWeek: 11, playedWeeks: [1, 2, 4, 5], transactions: [tx('RELEASE', '2026-10-20')] }));
    expect(d).toMatchObject({ status: 'void', void_reason: 'released' });
  });
});

describe('body sites', () => {
  it('maps source wording and report wording onto one site key', () => {
    expect(bodySitesOf('Grade 2 hamstring strain')).toEqual(['hamstring']);
    expect(bodySitesOf('torn ACL, left knee')).toEqual(['knee']);
    expect(bodySitesOf('high ankle sprain')).toEqual(['ankle']);
    expect(bodySitesOf('Quadricep')).toEqual(['quadricep']);
    expect(bodySitesOf('Not injury related - resting player')).toEqual([]);
    expect(bodySitesOf(null)).toEqual([]);
  });

  it('does not match inside other words', () => {
    expect(bodySitesOf('handling')).toEqual([]);
    expect(bodySitesOf('backup')).toEqual([]);
  });

  it('reads both report columns', () => {
    const row: InjuryReportRow = { season: 2026, week: 3, team: 'BUF', gsis_id: GSIS, report_primary_injury: 'Knee', report_secondary_injury: 'Hamstring', report_status: 'Questionable' };
    expect(reportNamesSameSite(row, ['hamstring'])).toBe(true);
    expect(reportNamesSameSite(row, ['ankle'])).toBe(false);
    expect(reportNamesSameSite(row, [])).toBe(false);
  });
});

describe('cross-cutting rules', () => {
  it('season-ending flag needs both halves', () => {
    expect(seasonEndingFlag(0.04, 6, 5)).toBe(true);
    expect(seasonEndingFlag(0.05, 6, 5)).toBe(false);
    expect(seasonEndingFlag(0.04, 5, 5)).toBe(false);
  });

  it('a revision counts only if published strictly before the freeze point', () => {
    expect(revisionCountsForField('2026-09-27T16:59:59.999Z', '2026-09-27T17:00:00.000Z')).toBe(true);
    expect(revisionCountsForField('2026-09-27T17:00:00.000Z', '2026-09-27T17:00:00.000Z')).toBe(false);
  });

  it('resolveField dispatches every field', () => {
    for (const f of ['F1', 'F2', 'F3', 'F4', 'F5'] as const) {
      expect(resolveField(f, ctx(), facts()).status).toBeDefined();
    }
  });
});
