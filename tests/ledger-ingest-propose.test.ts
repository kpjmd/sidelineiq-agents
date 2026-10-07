/**
 * Proposals from the pre-registered rules, over RECORDED facts. Entries other
 * than the recorded PT-2026-001 row are derived from it with `withForecast`,
 * which names every column it changes.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEntryContext,
  freezeEvidenceViolations,
  openFieldsOf,
  proposeForEntry,
  resolveEntryTeam,
  seasonForDate,
  type IngestForecastRow,
  type ResolutionProposal,
} from '../src/ledger/ingest/propose.js';
import { parseGamesCsv, parseInjuriesCsv, parseSnapsCsv } from '../src/ledger/ingest/nflverse.js';
import { attributeTransactions, extractTransactionEvents, teamNamesFrom } from '../src/ledger/ingest/espn-transactions.js';
import type { ResolutionFacts } from '../src/ledger/rules.js';
import { LAMAR_IDS, gamesCsv, injuriesCsv, recordedExport, snapsCsv, transactionPages, withForecast } from './helpers/ledger-ingest-fixture.js';

const schedule = parseGamesCsv(gamesCsv);
const snaps = parseSnapsCsv(snapsCsv);
const injuries = parseInjuriesCsv(injuriesCsv);
const items = transactionPages.flatMap((p) => p.body.transactions);
const events = items.flatMap(extractTransactionEvents);
const teamNames = teamNamesFrom(items);
const scheduled = new Set(schedule.flatMap((g) => [g.home_team, g.away_team]));
const TODAY = '2026-10-07';

function entry(patch: Record<string, unknown> = {}) {
  const exp = withForecast(patch);
  const built = buildEntryContext(exp.forecasts as unknown as IngestForecastRow[]);
  if (!built.ok) throw new Error(built.reason);
  return resolveEntryTeam(built, scheduled, teamNames);
}
function facts(player: string, team: string): ResolutionFacts {
  return { schedule, snaps, injuries, transactions: attributeTransactions(events, { player, team, teamNames: teamNames.get(team) ?? [] }), today: TODAY };
}

describe('the recorded PT-2026-001 row, as it stands', () => {
  const built = entry();
  it('maps the stored team NAME to the schedule code, and says so', () => {
    expect(built.ctx.team).toBe('BAL');
    expect(built.team_source).toBe('team_name');
    expect(built.ctx).toMatchObject({ injury_date: '2026-10-04', season: 2026, pfr_id: null, gsis_id: null });
  });
  it('proposes nothing: F1 is before day 7, the gamebook fields need ids it does not carry', () => {
    const out = proposeForEntry(built, openFieldsOf('PT-2026-001', recordedExport().resolutions), facts('Lamar Jackson', 'BAL'));
    expect(out.proposals).toEqual([]);
    expect(out.held.map((h) => [h.field, h.status, h.reason])).toEqual([
      ['F1', 'open', 'before_resolution_window'],
      ['F2', 'unresolvable', 'no_pfr_id'],
      ['F3', 'unresolvable', 'no_pfr_id'],
      ['F4', 'unresolvable', 'no_pfr_id'],
      ['F5', 'unresolvable', 'no_pfr_id'],
    ]);
  });
  it('after linkage, F2 waits for the 2026-10-11 game rather than resolving', () => {
    const out = proposeForEntry(entry(LAMAR_IDS), ['F1', 'F2', 'F3', 'F4', 'F5'], facts('Lamar Jackson', 'BAL'));
    expect(out.proposals).toEqual([]);
    expect(out.held.find((h) => h.field === 'F2')).toMatchObject({ status: 'open', reason: 'game_not_completed', freeze_at: '2026-10-12T00:20:00.000Z' });
  });
});

describe('a linked entry whose games are in the recorded files (injury dated week 1)', () => {
  // Columns changed from the recorded row: injury_date, published_at and the linkage ids.
  const built = entry({ ...LAMAR_IDS, injury_date: '2026-09-13T00:00:00.000Z', published_at: '2026-09-14T12:00:00.000Z' });
  const out = proposeForEntry(built, ['F2', 'F3', 'F4', 'F5'], facts('Lamar Jackson', 'BAL'));
  const by = (f: string) => out.proposals.find((p) => p.field === f) as ResolutionProposal;

  it('F2: played the next game (week 2) → 1, frozen at its kickoff, PFR boxscore as evidence', () => {
    expect(by('F2')).toMatchObject({
      proposed_status: 'resolved',
      proposed_outcome: 1,
      outcome_date: '2026-09-20',
      freeze_at: '2026-09-20T17:00:00.000Z',
      evidence_url: 'https://www.pro-football-reference.com/boxscores/202609200rav.htm',
    });
  });
  it('F3 → 1 and F4 → 0 games missed, both frozen at the return kickoff', () => {
    expect(by('F3')).toMatchObject({ proposed_outcome: 1, outcome_date: '2026-09-20' });
    expect(by('F4')).toMatchObject({ proposed_outcome: 0, outcome_date: '2026-09-20', freeze_at: '2026-09-20T17:00:00.000Z' });
  });
  it('F5 is held: the six-game window is not complete', () => {
    expect(out.held).toEqual([expect.objectContaining({ field: 'F5', status: 'open', reason: 'awaiting_f5_window' })]);
  });
  it('every proposal carries its freeze evidence and its basis', () => {
    for (const p of out.proposals) {
      expect(freezeEvidenceViolations(p, '2026-10-07T18:00:00.000Z')).toEqual([]);
      expect(p.evidence.basis).toMatchObject({ team: 'BAL', pfr_id: 'JackLa00', gsis_id: '00-0034796', today: TODAY });
    }
  });
});

describe('F1 from the recorded wire', () => {
  it('a Ravens IR placement on 2026-10-03 resolves F1 = 1 for the athlete it names, with the sentence', () => {
    // Columns changed: player, injury_date, published_at (an entry about the recorded IR sentence's athlete).
    const built = entry({ player: 'Ethan Pocic', injury_date: '2026-09-27T00:00:00.000Z', published_at: '2026-09-28T12:00:00.000Z' });
    const out = proposeForEntry(built, ['F1'], facts('Ethan Pocic', 'BAL'));
    expect(out.proposals[0]).toMatchObject({
      field: 'F1',
      proposed_status: 'resolved',
      proposed_outcome: 1,
      outcome_date: '2026-10-03',
      freeze_at: '2026-10-03T04:00:00.000Z',
      evidence_url: 'https://www.espn.com/nfl/transactions',
    });
    expect(out.proposals[0].evidence.sentence).toBe('Placed Cs Jovaughn Gwyn and Ethan Pocic on injured reserve.');
    expect(freezeEvidenceViolations(out.proposals[0], '2026-10-07T18:00:00.000Z')).toEqual([]);
  });
  it('a v1 published after that IR day voids F1 as forecast_after_freeze', () => {
    const built = entry({ player: 'Ethan Pocic', injury_date: '2026-09-27T00:00:00.000Z', published_at: '2026-10-04T12:00:00.000Z' });
    expect(proposeForEntry(built, ['F1'], facts('Ethan Pocic', 'BAL')).proposals[0]).toMatchObject({ proposed_status: 'void', void_reason: 'forecast_after_freeze' });
  });
});

describe('guards', () => {
  it('a team the schedule does not know holds EVERY field, F1 included — never a silent F1 = 0', () => {
    const built = entry({ team: 'Nowhere Nobodies', injury_date: '2026-09-13T00:00:00.000Z', published_at: '2026-09-14T12:00:00.000Z' });
    expect(built.team_source).toBe('team');
    const out = proposeForEntry(built, ['F1', 'F2', 'F3', 'F4', 'F5'], facts('Lamar Jackson', built.ctx.team));
    expect(out.proposals).toEqual([]);
    expect(out.held.every((h) => h.status === 'unresolvable' && h.reason === 'no_schedule_for_team')).toBe(true);
  });
  it('a concussion entry voids F5 by rule', () => {
    const out = proposeForEntry(entry({ ...LAMAR_IDS, base_rate_row: 'concussion' }), ['F5'], facts('Lamar Jackson', 'BAL'));
    expect(out.proposals[0]).toMatchObject({ field: 'F5', proposed_status: 'void', void_reason: 'concussion_rule' });
    expect(freezeEvidenceViolations(out.proposals[0], '2026-10-07T18:00:00.000Z')).toEqual([]);
  });
  it('only open fields are ever passed to the rules', () => {
    const res = [
      { entry_id: 'PT-2026-001', field: 'F1', status: 'resolved' },
      { entry_id: 'PT-2026-001', field: 'F2', status: 'void' },
      { entry_id: 'PT-2026-001', field: 'F3', status: 'open' },
    ];
    expect(openFieldsOf('PT-2026-001', res)).toEqual(['F3']);
    const out = proposeForEntry(entry({ ...LAMAR_IDS, injury_date: '2026-09-13T00:00:00.000Z', published_at: '2026-09-14T12:00:00.000Z' }), ['F3'], facts('Lamar Jackson', 'BAL'));
    expect(out.proposals.map((p) => p.field)).toEqual(['F3']);
  });
  it('the freeze-evidence gate catches a doctored proposal', () => {
    const p: ResolutionProposal = {
      entry_id: 'PT-2026-001', field: 'F1', proposed_status: 'resolved', proposed_outcome: 1, outcome_date: '2026-10-09', freeze_at: '2026-10-09T04:00:00.000Z', void_reason: null, evidence_url: null,
      evidence: { urls: [], note: '', ingest_version: 1, basis: { today: TODAY, team: 'BAL', team_source: 'nflverse_team', season: 2026, season_assumed: false, pfr_id: null, gsis_id: null } },
    };
    expect(freezeEvidenceViolations(p, '2026-10-07T18:00:00.000Z')).toEqual(
      expect.arrayContaining(['no evidence url', 'F1=1 without the IR sentence', expect.stringMatching(/future/), expect.stringMatching(/after today/)]),
    );
  });
  it('season: March onward is the calendar year, January–February the previous one', () => {
    expect(seasonForDate('2026-10-04')).toBe(2026);
    expect(seasonForDate('2027-01-03')).toBe(2026);
  });
});
