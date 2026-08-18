/**
 * Source status reporting.
 *
 * Every fetch failure path in this codebase returns [] — by design, so one dead
 * source can't take down the poll loop. The cost is that `fetched=0 errors=0`
 * meant both "upstream had nothing" and "upstream is down", which is how the
 * empty Premier League feed went unexamined for weeks. These tests pin the
 * distinction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ESPNInjurySource } from '../src/monitoring/sports/espn-base.js';
import {
  MultiSource,
  formatSourceReports,
  type SportDataSource,
  type SourceFetchReport,
} from '../src/monitoring/sports/multi-source.js';
import type { RawInjuryEvent, SportKey } from '../src/types.js';

class TestESPNSource extends ESPNInjurySource {
  readonly name = 'test-espn';
  protected readonly sport: SportKey = 'NBA';
  protected readonly url = 'https://example.test/injuries';
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

const POPULATED_FEED = {
  injuries: [
    {
      team: { displayName: 'Golden State Warriors' },
      injuries: [
        {
          athlete: { displayName: 'Test Player' },
          status: 'Out',
          date: new Date().toISOString(),
          details: { type: 'Knee', detail: 'ACL tear' },
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.stubEnv('MAX_EVENT_AGE_DAYS', '7');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * The feed's own fielded data, carried onto the event instead of being
 * flattened into prose and regex-scraped back out downstream.
 *
 * `status` is separately load-bearing: an injuries row for an ACTIVE athlete is
 * carrying news about a teammate, which is what the athlete re-anchor keys on.
 */
describe('ESPNInjurySource — structured fields on the event', () => {
  it('carries athlete_status and injury_details through', async () => {
    const feed = {
      injuries: [
        {
          team: { displayName: 'Arizona Cardinals' },
          injuries: [
            {
              athlete: { displayName: 'Tyler Allgeier' },
              status: 'Active',
              date: new Date().toISOString(),
              details: { type: 'Pectoral', location: 'Torso', detail: 'Surgery', side: 'Left' },
              shortComment: 'Allgeier could open the season as the primary back.',
            },
          ],
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(feed)));
    const [event] = await new TestESPNSource().fetchLatestEvents();

    expect(event.athlete_status).toBe('Active');
    expect(event.injury_details).toEqual({
      type: 'Pectoral',
      location: 'Torso',
      detail: 'Surgery',
      side: 'Left',
    });
  });

  it('leaves both undefined when the row has neither', async () => {
    const feed = {
      injuries: [
        {
          team: { displayName: 'Golden State Warriors' },
          injuries: [
            {
              athlete: { displayName: 'Test Player' },
              date: new Date().toISOString(),
              shortComment: 'Knee soreness kept him out.',
            },
          ],
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(feed)));
    const [event] = await new TestESPNSource().fetchLatestEvents();

    // Not null, not "" — absent, so isReanchorEligible fails closed on it.
    expect(event.athlete_status).toBeUndefined();
    expect(event.injury_details).toBeUndefined();
  });
});

describe('ESPNInjurySource.lastFetchReport', () => {
  it('reports ok when the feed yields events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(POPULATED_FEED)));
    const source = new TestESPNSource();
    const events = await source.fetchLatestEvents();

    expect(events.length).toBeGreaterThan(0);
    expect(source.lastFetchReport().status).toBe('ok');
  });

  // This is the Premier League case: HTTP 200, valid JSON, zero rows.
  it('reports empty (not error) when the upstream returns no rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ injuries: [] })));
    const source = new TestESPNSource();
    const events = await source.fetchLatestEvents();

    expect(events).toEqual([]);
    const report = source.lastFetchReport();
    expect(report.status).toBe('empty');
    expect(report.detail).toBe('no rows upstream');
  });

  // Distinguishing this from the case above is what tells you whether to fix a
  // filter or find a new data provider.
  it('distinguishes "our filters ate everything" from "upstream sent nothing"', async () => {
    const stale = {
      injuries: [
        {
          team: { displayName: 'Golden State Warriors' },
          injuries: [
            {
              athlete: { displayName: 'Stale Player' },
              status: 'Out',
              date: new Date(Date.now() - 90 * 86400000).toISOString(),
              details: { type: 'Knee', detail: 'ACL tear' },
            },
          ],
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(stale)));
    const source = new TestESPNSource();

    expect(await source.fetchLatestEvents()).toEqual([]);
    expect(source.lastFetchReport().detail).toBe('1 rows filtered out');
  });

  it('reports error on a non-OK HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false, 503)));
    const source = new TestESPNSource();

    expect(await source.fetchLatestEvents()).toEqual([]);
    expect(source.lastFetchReport()).toEqual({ status: 'error', detail: 'HTTP 503' });
  });

  it('reports error when the fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const source = new TestESPNSource();

    expect(await source.fetchLatestEvents()).toEqual([]);
    const report = source.lastFetchReport();
    expect(report.status).toBe('error');
    expect(report.detail).toContain('ECONNREFUSED');
  });
});

// ── MultiSource aggregation ──────────────────────────────────────────────────

function stubSource(
  name: string,
  events: RawInjuryEvent[],
  report?: SourceFetchReport,
): SportDataSource {
  return {
    name,
    fetchLatestEvents: async () => events,
    ...(report && { lastFetchReport: () => report }),
  };
}

function makeEvent(athlete: string): RawInjuryEvent {
  return {
    athlete_name: athlete,
    sport: 'NBA',
    team: 'Warriors',
    injury_description: 'ACL tear',
    source_url: 'https://example.test',
    reported_at: new Date(),
  };
}

describe('MultiSource.fetchLatestEventsWithReport', () => {
  it('collects one report per source and counts errors', async () => {
    const multi = new MultiSource([
      stubSource('a', [makeEvent('Player A')], { status: 'ok' }),
      stubSource('b', [], { status: 'empty', detail: 'no rows upstream' }),
      stubSource('c', [], { status: 'error', detail: 'HTTP 500' }),
      stubSource('d', [], { status: 'skipped', detail: 'off-cycle' }),
    ]);

    const result = await multi.fetchLatestEventsWithReport();

    expect(result.events).toHaveLength(1);
    expect(result.errorCount).toBe(1);
    expect(result.reports.map((r) => `${r.name}:${r.status}`)).toEqual([
      'a:ok',
      'b:empty',
      'c:error',
      'd:skipped',
    ]);
  });

  it('infers ok/empty for sources that do not report', async () => {
    const multi = new MultiSource([
      stubSource('quiet-with-events', [makeEvent('Player B')]),
      stubSource('quiet-without-events', []),
    ]);

    const result = await multi.fetchLatestEventsWithReport();

    expect(result.reports.map((r) => r.status)).toEqual(['ok', 'empty']);
    expect(result.errorCount).toBe(0);
  });

  // Sources are contractually never supposed to throw; if one does, the failure
  // must still be counted rather than swallowed.
  it('counts a contract-violating throw as an error', async () => {
    const thrower: SportDataSource = {
      name: 'rogue',
      fetchLatestEvents: async () => { throw new Error('boom'); },
    };
    const multi = new MultiSource([thrower, stubSource('good', [makeEvent('Player C')])]);

    const result = await multi.fetchLatestEventsWithReport();

    expect(result.errorCount).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ name: 'rogue', status: 'error' });
  });

  it('fetchLatestEvents still returns a bare array', async () => {
    const multi = new MultiSource([stubSource('a', [makeEvent('Player D')], { status: 'ok' })]);
    expect(await multi.fetchLatestEvents()).toHaveLength(1);
  });
});

describe('formatSourceReports', () => {
  it('renders a scannable one-liner', () => {
    const line = formatSourceReports([
      { name: 'espn-nfl', events: 24, status: 'ok' },
      { name: 'newsapi-nfl', events: 0, status: 'skipped', detail: 'off-cycle 1/6' },
      { name: 'espn-premier-league', events: 0, status: 'empty', detail: 'no rows upstream' },
    ]);

    expect(line).toBe(
      'espn-nfl=ok(24) newsapi-nfl=skipped[off-cycle 1/6] espn-premier-league=empty[no rows upstream]',
    );
  });
});
