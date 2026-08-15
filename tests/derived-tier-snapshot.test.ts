/**
 * The derived-tier snapshot loader, Premier League club provider.
 *
 * Same failure mode as the salary snapshot, and the same answer: a PARTIAL load
 * would silently drop every player in the missing pages back to the flat tier-3
 * default, with no error and no symptom other than a quiet loss of prominence
 * across some arbitrary subset of the league. So the accumulator is local, it is
 * only swapped in on complete success, and an implausibly small read is treated
 * as a failure rather than as news about the league.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import {
  refreshDerivedTierSnapshot,
  refreshDerivedTierSnapshotIfStale,
  invalidateDerivedTierSnapshot,
  derivedTiersEnabled,
} from '../src/agents/injury-intelligence/derived-tier-snapshot.js';
import {
  lookupAthleteTier,
  derivedSnapshotSize,
  _setConfigForTesting,
  _setTiersForTesting,
  _setDerivedSnapshotForTesting,
} from '../src/agents/injury-intelligence/significance.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

/** PL only, so the paging assertions below count one sport's calls. */
const CONFIG = {
  version: 3,
  thresholds: {
    default: { process: 60, defer: 35, max_tier: 3 },
    TRACKING: { process: 65, defer: 40, require_tier_1_or_2: true },
    CONFLICT_FLAG: { always_process: true },
  },
  sport_seasons: {},
  default_threshold_delta: 0,
  derived_tiers: {
    PREMIER_LEAGUE: {
      kind: 'club' as const,
      tier_2_clubs: [{ espn_team_id: '359', name: 'Arsenal' }],
    },
  },
  defer: { ttl_hours: 6, promotion_cap: 3, corroboration_bonus_per_source: 5, corroboration_bonus_max: 20 },
};

const TIERS = { version: 4, updated_at: '2026-08-15', athletes: [] };

const TEAMS = {
  teams: [
    { id: 'uuid-arsenal', espn_team_id: '359', name: 'Arsenal' },
    { id: 'uuid-everton', espn_team_id: '368', name: 'Everton' },
  ],
};

function wrap(body: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

/** A page of `count` synthetic players, alternating between the two clubs. */
function playerPage(count: number, has_more = false, offset = 0) {
  return wrap({
    players: Array.from({ length: count }, (_, i) => ({
      full_name: `Player ${offset + i}`,
      sport: 'PREMIER_LEAGUE',
      current_team_id: (offset + i) % 2 === 0 ? 'uuid-arsenal' : 'uuid-everton',
    })),
    has_more,
    next_offset: offset + count,
  });
}

/** Wires callTool so teams resolve and players come from `pages` in order. */
function stubReads(pages: unknown[], teams: unknown = wrap(TEAMS)) {
  let pageIndex = 0;
  mockCallTool.mockImplementation(async (_server, tool) => {
    if (tool === 'web_list_teams') return teams as never;
    return pages[Math.min(pageIndex++, pages.length - 1)] as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsServerAvailable.mockReturnValue(true);
  _setConfigForTesting(structuredClone(CONFIG) as never);
  _setTiersForTesting(structuredClone(TIERS) as never);
  _setDerivedSnapshotForTesting(null);
  invalidateDerivedTierSnapshot();
  vi.stubEnv('DERIVED_TIER_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  _setConfigForTesting(null);
  _setTiersForTesting(null);
  _setDerivedSnapshotForTesting(null);
});

describe('the flag', () => {
  it('is off unless explicitly true', () => {
    vi.stubEnv('DERIVED_TIER_ENABLED', '');
    expect(derivedTiersEnabled()).toBe(false);
    vi.stubEnv('DERIVED_TIER_ENABLED', '1');
    expect(derivedTiersEnabled()).toBe(false);
    vi.stubEnv('DERIVED_TIER_ENABLED', 'true');
    expect(derivedTiersEnabled()).toBe(true);
  });

  it('does no I/O at all when off', async () => {
    vi.stubEnv('DERIVED_TIER_ENABLED', 'false');
    await refreshDerivedTierSnapshotIfStale();
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});

describe('the club provider', () => {
  it('indexes every player under their clubs ESPN id', async () => {
    stubReads([playerPage(500)]);
    expect(await refreshDerivedTierSnapshot()).toBe(true);
    expect(derivedSnapshotSize()).toBe(500);

    // Player 0 is at Arsenal (a listed club), Player 1 at Everton.
    expect(lookupAthleteTier('Player 0', 'PREMIER_LEAGUE')).toEqual({ tier: 2, source: 'club' });
    expect(lookupAthleteTier('Player 1', 'PREMIER_LEAGUE')).toEqual({ tier: 3, source: 'default' });
  });

  it('pages until has_more is false', async () => {
    stubReads([playerPage(200, true, 0), playerPage(200, true, 200), playerPage(120, false, 400)]);
    expect(await refreshDerivedTierSnapshot()).toBe(true);
    expect(derivedSnapshotSize()).toBe(520);
  });

  it('skips a player with no club without failing the load', async () => {
    stubReads([
      wrap({
        players: [
          ...Array.from({ length: 500 }, (_, i) => ({
            full_name: `Player ${i}`,
            current_team_id: 'uuid-arsenal',
          })),
          { full_name: 'Clubless Player', current_team_id: null },
        ],
        has_more: false,
      }),
    ]);

    expect(await refreshDerivedTierSnapshot()).toBe(true);
    expect(derivedSnapshotSize()).toBe(500);
    expect(lookupAthleteTier('Clubless Player', 'PREMIER_LEAGUE').source).toBe('default');
  });

  it('skips a player whose club is out of coverage', async () => {
    // A relegated club's uuid is not in the in-coverage teams map, so its
    // players carry no Premier League prominence.
    stubReads([
      wrap({
        players: [
          ...Array.from({ length: 500 }, (_, i) => ({
            full_name: `Player ${i}`,
            current_team_id: 'uuid-arsenal',
          })),
          { full_name: 'Relegated Player', current_team_id: 'uuid-burnley' },
        ],
        has_more: false,
      }),
    ]);

    await refreshDerivedTierSnapshot();
    expect(lookupAthleteTier('Relegated Player', 'PREMIER_LEAGUE').source).toBe('default');
  });
});

describe('never commit a partial read', () => {
  async function installGoodSnapshot() {
    stubReads([playerPage(500)]);
    await refreshDerivedTierSnapshot();
    invalidateDerivedTierSnapshot();
    vi.clearAllMocks();
    mockIsServerAvailable.mockReturnValue(true);
  }

  it('keeps the previous snapshot when a page throws', async () => {
    await installGoodSnapshot();

    let calls = 0;
    mockCallTool.mockImplementation(async (_s, tool) => {
      if (tool === 'web_list_teams') return wrap(TEAMS) as never;
      if (calls++ === 0) return playerPage(200, true, 0) as never;
      throw new Error('connection reset');
    });

    expect(await refreshDerivedTierSnapshot()).toBe(false);
    expect(derivedSnapshotSize()).toBe(500);
    expect(lookupAthleteTier('Player 0', 'PREMIER_LEAGUE').tier).toBe(2);
  });

  it('keeps the previous snapshot when a page is unreadable', async () => {
    await installGoodSnapshot();
    stubReads([{ content: [{ type: 'text', text: 'not json' }] }]);

    expect(await refreshDerivedTierSnapshot()).toBe(false);
    expect(derivedSnapshotSize()).toBe(500);
  });

  it('treats an implausibly small squad list as a failed read', async () => {
    // 20 clubs held 910 in-coverage players on 2026-08-15. Twelve is not news
    // about the Premier League, it is a broken read — and absence is never
    // evidence, because these fetches fail by returning nothing.
    await installGoodSnapshot();
    stubReads([playerPage(12)]);

    expect(await refreshDerivedTierSnapshot()).toBe(false);
    expect(derivedSnapshotSize()).toBe(500);
  });

  it('aborts when the teams read comes back empty', async () => {
    await installGoodSnapshot();
    stubReads([playerPage(500)], wrap({ teams: [] }));

    expect(await refreshDerivedTierSnapshot()).toBe(false);
    expect(derivedSnapshotSize()).toBe(500);
  });

  it('keeps the previous snapshot when the web server is down', async () => {
    await installGoodSnapshot();
    mockIsServerAvailable.mockReturnValue(false);

    expect(await refreshDerivedTierSnapshot()).toBe(false);
    expect(derivedSnapshotSize()).toBe(500);
  });
});

describe('TTL', () => {
  it('does no I/O inside the window, and reads again after invalidation', async () => {
    stubReads([playerPage(500)]);
    await refreshDerivedTierSnapshotIfStale();
    const first = mockCallTool.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    await refreshDerivedTierSnapshotIfStale();
    expect(mockCallTool.mock.calls.length).toBe(first);

    invalidateDerivedTierSnapshot();
    await refreshDerivedTierSnapshotIfStale();
    expect(mockCallTool.mock.calls.length).toBeGreaterThan(first);
  });
});
