/**
 * The nflverse crosswalk: keyed on ESPN id only, "unresolved" is a distinct
 * answer from "unavailable", and a failed refresh serves the stale index.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { lookupNflverseIds, indexPlayersCsv, parseCsv, NflverseUnavailableError, _resetNflverseCacheForTests } from '../src/ledger/nflverse-players.js';

const CSV = [
  'gsis_id,display_name,espn_id,pfr_id,latest_team,position,status,extra',
  '00-0036322,Example Player,4262921,ExamPl00,BUF,WR,ACT,"has, comma"',
  '00-0039999,"Smith, Jr., John",4300000,,KC,TE,ACT,x',
  'NA,Mystery Man,4311111,NA,NA,QB,RET,',
  ',No Espn Id,,NoEspn00,NYJ,OL,ACT,',
].join('\r\n');

function fetchReturning(text: string | number) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    return typeof text === 'number' ? new Response('', { status: text }) : new Response(text, { status: 200 });
  };
  return { f, calls };
}

beforeEach(() => _resetNflverseCacheForTests());

describe('parseCsv / indexPlayersCsv', () => {
  it('handles quoted commas, doubled quotes and CRLF, and keys on espn_id', () => {
    expect(parseCsv('a,"b ""q"", c",d\r\n1,2,3')).toEqual([['a', 'b "q", c', 'd'], ['1', '2', '3']]);
    const idx = indexPlayersCsv(CSV);
    expect(idx.size).toBe(3);
    expect(idx.get('4300000')?.display_name).toBe('Smith, Jr., John');
    expect(idx.get('4311111')).toMatchObject({ gsis_id: null, pfr_id: null, latest_team: null });
  });

  it('refuses a file whose header lacks a keyed column', () => {
    expect(() => indexPlayersCsv('a,b\n1,2')).toThrow(NflverseUnavailableError);
    expect(() => indexPlayersCsv('')).toThrow(NflverseUnavailableError);
  });
});

describe('lookupNflverseIds', () => {
  it('resolves a row that carries both ids', async () => {
    const { f } = fetchReturning(CSV);
    const r = await lookupNflverseIds('4262921', { fetch: f, now: () => 1_000 });
    expect(r).toMatchObject({ status: 'resolved', gsis_id: '00-0036322', pfr_id: 'ExamPl00', nflverse_team: 'BUF', display_name: 'Example Player' });
  });

  it('reports unresolved with the missing ids named, and no_row for an unknown id — never a name match', async () => {
    const { f } = fetchReturning(CSV);
    const partial = await lookupNflverseIds('4300000', { fetch: f, now: () => 1_000 });
    expect(partial).toMatchObject({ status: 'unresolved', reason: 'missing_ids', missing: ['pfr_id'], partial: { gsis_id: '00-0039999' } });
    const none = await lookupNflverseIds('9999999', { fetch: f, now: () => 1_000 });
    expect(none).toMatchObject({ status: 'unresolved', reason: 'no_row', missing: ['gsis_id', 'pfr_id'], partial: null });
    await expect(lookupNflverseIds('Example Player', { fetch: f, now: () => 1_000 })).rejects.toThrow(/numeric/);
  });

  it('caches for the TTL and refreshes after it', async () => {
    const { f, calls } = fetchReturning(CSV);
    let now = 1_000;
    const deps = { fetch: f, now: () => now, ttlMs: 100 };
    await lookupNflverseIds('4262921', deps);
    await lookupNflverseIds('4262921', deps);
    expect(calls).toHaveLength(1);
    now += 101;
    await lookupNflverseIds('4262921', deps);
    expect(calls).toHaveLength(2);
  });

  it('a failed fetch with no cache is NflverseUnavailableError, not "unresolved"; with a cache it serves stale', async () => {
    const down = fetchReturning(503);
    await expect(lookupNflverseIds('4262921', { fetch: down.f, now: () => 1 })).rejects.toThrow(NflverseUnavailableError);
    const ok = fetchReturning(CSV);
    let now = 1_000;
    const deps = { fetch: ok.f, now: () => now, ttlMs: 10 };
    await lookupNflverseIds('4262921', deps);
    now += 20;
    const r = await lookupNflverseIds('4262921', { ...deps, fetch: down.f });
    expect(r.status).toBe('resolved');
    expect(r.source_fetched_at).toBe(new Date(1_000).toISOString());
  });
});
