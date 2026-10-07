/**
 * The nflverse tables, parsed from RECORDED files (tests/fixtures/ledger-ingest).
 * Pins the shapes the rules read and the bad-PAGE policy: any non-200 aborts.
 */
import { describe, it, expect } from 'vitest';
import {
  fetchNflverseFacts,
  NflverseFactsUnavailableError,
  parseGamesCsv,
  parseInjuriesCsv,
  parseSnapsCsv,
} from '../src/ledger/ingest/nflverse.js';
import { teamRegularSeasonGames } from '../src/ledger/rules.js';
import { gamesCsv, injuriesCsv, meta, snapsCsv, csvText, LAMAR_IDS } from './helpers/ledger-ingest-fixture.js';

describe('games.csv', () => {
  const games = parseGamesCsv(gamesCsv);
  const bal = teamRegularSeasonGames(games, 'BAL', 2026);

  it('gives the Ravens 17 regular-season games with the week 13 bye absent', () => {
    expect(bal).toHaveLength(17);
    expect(bal.map((g) => g.week)).not.toContain(13);
  });
  it('reads completion from `result`, kickoff from gameday + gametime, and the PFR/ESPN ids', () => {
    const w4 = bal.find((g) => g.week === 4)!;
    const w5 = bal.find((g) => g.week === 5)!;
    expect(w4).toMatchObject({ game_id: '2026_04_TEN_BAL', gameday: '2026-10-04', gametime: '13:00', completed: true, pfr_game_id: '202610040rav' });
    expect(w5).toMatchObject({ game_id: '2026_05_BAL_ATL', gameday: '2026-10-11', gametime: '20:20', completed: false });
  });
});

describe('snap counts and injury report', () => {
  it('keys snaps on pfr_player_id and carries no name column', () => {
    const snaps = parseSnapsCsv(snapsCsv);
    const lamar = snaps.filter((s) => s.pfr_player_id === LAMAR_IDS.pfr_id);
    expect(lamar.map((s) => s.game_id)).toEqual(['2026_01_BAL_IND', '2026_02_NO_BAL', '2026_03_BAL_DAL', '2026_04_TEN_BAL']);
    expect(lamar[3].offense_snaps).toBe(33);
    expect(Object.keys(snaps[0])).not.toContain('player');
  });
  it('keys report rows on gsis_id and carries no name column', () => {
    const rows = parseInjuriesCsv(injuriesCsv);
    expect(rows.some((r) => r.gsis_id === LAMAR_IDS.gsis_id && r.week === 4)).toBe(true);
    expect(Object.keys(rows[0]).some((k) => /name/.test(k))).toBe(false);
  });
  it('a missing required column, or a header with no rows, is unavailable — never an empty table', () => {
    expect(() => parseSnapsCsv('game_id,team\n1,BAL\n')).toThrow(NflverseFactsUnavailableError);
    expect(() => parseGamesCsv(gamesCsv.split('\n')[0] + '\n')).toThrow(/no data rows/);
    expect(() => parseInjuriesCsv('')).toThrow(NflverseFactsUnavailableError);
  });
});

describe('fetch: every failure is a bad page', () => {
  const serve = (override: (url: string) => Response | null) => async (input: string) =>
    override(input) ?? new Response(csvText[input] ?? '', { status: csvText[input] ? 200 : 404 });

  it('reads all three tables for the season', async () => {
    const facts = await fetchNflverseFacts([2026], serve(() => null), meta.urls);
    expect(facts.sources.map((s) => s.source)).toEqual(['games', 'snap_counts', 'injuries']);
    expect(facts.schedule.every((g) => g.season === 2026)).toBe(true);
  });
  for (const status of [404, 503]) {
    for (const which of ['games', 'snap_counts', 'injuries']) {
      it(`HTTP ${status} on ${which} throws`, async () => {
        const fetchFn = serve((url) => ((which === 'games' ? url === meta.urls.games : url.includes(which)) ? new Response('x', { status }) : null));
        await expect(fetchNflverseFacts([2026], fetchFn, meta.urls)).rejects.toBeInstanceOf(NflverseFactsUnavailableError);
      });
    }
  }
  it('a transport error throws', async () => {
    await expect(fetchNflverseFacts([2026], async () => { throw new Error('ECONNRESET'); }, meta.urls)).rejects.toBeInstanceOf(NflverseFactsUnavailableError);
  });
});
