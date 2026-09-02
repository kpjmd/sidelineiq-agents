/**
 * The salary snapshot loader.
 *
 * The failure mode this file mostly exists for: a PARTIAL load. If a paging
 * failure committed whatever it had, every athlete in the missing pages would
 * silently drop back to the flat tier-3 default — no error, no exception, no
 * symptom other than a quiet loss of prominence on some arbitrary subset of
 * the league. So the accumulator is local and only swapped in on complete
 * success, and the previous snapshot survives any failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import {
  refreshSalarySnapshot,
  refreshSalarySnapshotIfStale,
  invalidateSalarySnapshot,
  salaryTiersEnabled,
} from '../src/agents/injury-intelligence/salary-snapshot.js';
import {
  lookupAthleteTier,
  salarySnapshotSize,
  _setConfigForTesting,
  _setTiersForTesting,
  _setSalarySnapshotForTesting,
} from '../src/agents/injury-intelligence/significance.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);
const M = 1_000_000;

const CONFIG = {
  version: 3,
  thresholds: {
    default: { process: 60, defer: 35, max_tier: 3 },
    TRACKING: { process: 65, defer: 40, require_tier_1_or_2: true },
    CONFLICT_FLAG: { always_process: true },
  },
  sport_seasons: {},
  default_threshold_delta: 0,
  // NFL only, so the paging assertions below count one sport's calls.
  salary_tiers: { bands: { NFL: { tier_1_min: 25 * M, tier_2_min: 8 * M } } },
  defer: {
    ttl_hours: 48,
    promotion_cap: 3,
    corroboration_discount_per_source: 10,
    corroboration_discount_max: 20,
  },
};

const TIERS = { version: 2, updated_at: '2026-08-12', athletes: [] };

function page(
  players: Array<{ full_name: string; sport?: string; salary: number | string | null }>,
  has_more = false,
  next_offset = 0,
) {
  return {
    content: [{ text: JSON.stringify({ players, has_more, next_offset }) }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsServerAvailable.mockReturnValue(true);
  _setTiersForTesting(TIERS as Parameters<typeof _setTiersForTesting>[0]);
  _setConfigForTesting(CONFIG as unknown as Parameters<typeof _setConfigForTesting>[0]);
  _setSalarySnapshotForTesting(null);
  invalidateSalarySnapshot();
});

afterEach(() => {
  _setSalarySnapshotForTesting(null);
  vi.unstubAllEnvs();
});

describe('paging', () => {
  it('follows has_more/next_offset until the feed is exhausted', async () => {
    mockCallTool
      .mockResolvedValueOnce(page([{ full_name: 'A One', salary: 30 * M }], true, 200))
      .mockResolvedValueOnce(page([{ full_name: 'B Two', salary: 10 * M }], true, 400))
      .mockResolvedValueOnce(page([{ full_name: 'C Three', salary: 1 * M }], false));

    const ok = await refreshSalarySnapshot();

    expect(ok).toBe(true);
    expect(mockCallTool).toHaveBeenCalledTimes(3);
    expect(mockCallTool.mock.calls[1][2]).toMatchObject({ offset: 200 });
    expect(mockCallTool.mock.calls[2][2]).toMatchObject({ offset: 400 });
    expect(salarySnapshotSize()).toBe(3);
    expect(lookupAthleteTier('A One', 'NFL')).toEqual({ tier: 1, source: 'salary' });
    expect(lookupAthleteTier('B Two', 'NFL')).toEqual({ tier: 2, source: 'salary' });
  });

  it('only pages sports that have salary bands configured', async () => {
    // PREMIER_LEAGUE has no bands (ESPN's soccer roster carries no contract),
    // so paging it would spend calls importing a column that is NULL in every
    // row.
    mockCallTool.mockResolvedValue(page([{ full_name: 'A One', salary: 30 * M }]));

    await refreshSalarySnapshot();

    const sportsQueried = mockCallTool.mock.calls.map((c) => (c[2] as { sport: string }).sport);
    expect(sportsQueried).toEqual(['NFL']);
  });

  it('indexes rows under the requested sport, not the one the row claims', async () => {
    // These rows were asked for WITH a sport filter, so the loop constant is
    // what we actually know; the row's own column is an unvalidated string off
    // the wire. It matters now in a way it did not before: the salary index is
    // sport-scoped with no any-sport fallback, so if an upstream format change
    // started returning "football" here, every key would move out from under
    // the lookup and the whole league's salary tiers would silently zero.
    // exactAny used to absorb that. Nothing does now.
    mockCallTool.mockResolvedValue(
      page([{ full_name: 'Format Drift', sport: 'football', salary: 30 * M }]),
    );

    await refreshSalarySnapshot();

    expect(lookupAthleteTier('Format Drift', 'NFL')).toEqual({ tier: 1, source: 'salary' });
  });
});

describe('failure handling — never commit a partial read', () => {
  it('keeps the previous snapshot when a mid-page call throws', async () => {
    // Seed a known-good snapshot first.
    _setSalarySnapshotForTesting([{ full_name: 'Incumbent Star', sport: 'NFL', salary: 30 * M }]);

    mockCallTool
      .mockResolvedValueOnce(page([{ full_name: 'A One', salary: 30 * M }], true, 200))
      .mockRejectedValueOnce(new Error('MCP timeout'));

    const ok = await refreshSalarySnapshot();

    expect(ok).toBe(false);
    // The half-read pages are discarded entirely...
    expect(lookupAthleteTier('A One', 'NFL').source).not.toBe('salary');
    // ...and the incumbent snapshot is untouched. This is the assertion that
    // matters: a flaky MCP call must not silently demote anybody.
    expect(lookupAthleteTier('Incumbent Star', 'NFL')).toEqual({ tier: 1, source: 'salary' });
  });

  it('keeps the previous snapshot when a page body is unreadable', async () => {
    _setSalarySnapshotForTesting([{ full_name: 'Incumbent Star', sport: 'NFL', salary: 30 * M }]);
    mockCallTool.mockResolvedValueOnce({ content: [{ text: 'not json' }] });

    expect(await refreshSalarySnapshot()).toBe(false);
    expect(lookupAthleteTier('Incumbent Star', 'NFL')).toEqual({ tier: 1, source: 'salary' });
  });

  it('makes no calls and keeps the snapshot when the web server is down', async () => {
    _setSalarySnapshotForTesting([{ full_name: 'Incumbent Star', sport: 'NFL', salary: 30 * M }]);
    mockIsServerAvailable.mockReturnValue(false);

    expect(await refreshSalarySnapshot()).toBe(false);
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(lookupAthleteTier('Incumbent Star', 'NFL')).toEqual({ tier: 1, source: 'salary' });
  });

  it('skips malformed rows without failing the page', async () => {
    // A bad ROW is skipped; a bad PAGE aborts. The distinction is that a failed
    // page means we do not know what we missed, whereas a bad row is known and
    // bounded.
    mockCallTool.mockResolvedValueOnce(
      page([
        { full_name: 'Good Guy', salary: 30 * M },
        { full_name: 'No Salary', salary: null },
        { full_name: '', salary: 30 * M },
        { full_name: 'Zero Guy', salary: 0 },
      ]),
    );

    expect(await refreshSalarySnapshot()).toBe(true);
    expect(salarySnapshotSize()).toBe(1);
    expect(lookupAthleteTier('Good Guy', 'NFL')).toEqual({ tier: 1, source: 'salary' });
  });

  it('coerces a numeric-string salary — the pg BIGINT shape', async () => {
    // node-postgres drivers commonly return BIGINT as a string to avoid
    // precision loss. Silently dropping those would zero our coverage.
    mockCallTool.mockResolvedValueOnce(page([{ full_name: 'Big Int', salary: '30000000' }]));

    await refreshSalarySnapshot();

    expect(lookupAthleteTier('Big Int', 'NFL')).toEqual({ tier: 1, source: 'salary' });
  });

  it('stops at the page ceiling rather than looping forever', async () => {
    // has_more is server-computed; stuck true, an unbounded loop inside the
    // poll cycle would hang publishing entirely.
    mockCallTool.mockResolvedValue(page([{ full_name: 'Endless Guy', salary: 30 * M }], true, 1));

    await refreshSalarySnapshot();

    expect(mockCallTool.mock.calls.length).toBeLessThanOrEqual(60);
  });
});

describe('TTL and the feature gate', () => {
  it('is off by default and does no I/O until explicitly enabled', async () => {
    expect(salaryTiersEnabled()).toBe(false);
    await refreshSalarySnapshotIfStale();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('refreshes once and then no-ops inside the TTL window', async () => {
    vi.stubEnv('SALARY_TIER_ENABLED', 'true');
    mockCallTool.mockResolvedValue(page([{ full_name: 'A One', salary: 30 * M }]));

    await refreshSalarySnapshotIfStale();
    expect(mockCallTool).toHaveBeenCalledTimes(1);

    await refreshSalarySnapshotIfStale();
    await refreshSalarySnapshotIfStale();
    // Still 1: the poll cycle runs every 15 minutes against data that only
    // changes every 6h, which is the entire reason this is not folded into
    // loadSignificanceData.
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('re-reads after roster-sync invalidates the TTL', async () => {
    vi.stubEnv('SALARY_TIER_ENABLED', 'true');
    mockCallTool.mockResolvedValue(page([{ full_name: 'A One', salary: 30 * M }]));

    await refreshSalarySnapshotIfStale();
    invalidateSalarySnapshot(); // what syncAllRosters does on completion
    await refreshSalarySnapshotIfStale();

    expect(mockCallTool).toHaveBeenCalledTimes(2);
  });
});
