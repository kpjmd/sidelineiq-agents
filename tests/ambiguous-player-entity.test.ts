/**
 * An ambiguous player must never match OR mint an injury entity.
 *
 * Live 2026-10-03: eleven ACTIVE "Justin Jefferson" threads, all ankle LEFT
 * sprain, one per poll cycle, ten on the Browns LB and one on the Vikings WR.
 * The Vikings WR's ESPN row reached the poller with no athlete id, so the
 * player lookup was by name, which matches two rows, so it came back
 * 'ambiguous' carrying whichever row the unordered query returned first. Dedup
 * refused to match on an ambiguous player and fell back to the 24h post check,
 * which never sees an entity, and then resolveThreadAndDates minted one anyway.
 * The next cycle did the same.
 *
 * Two fixes, pinned separately:
 *  - the ESPN injuries feed now carries the athlete id (from athlete.links,
 *    since the row has no athlete.id), so the shared name resolves exactly;
 *  - anchorsEntity is the one predicate for all three entity sites.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  callToolWithRetry: vi.fn(),
  isServerAvailable: vi.fn(() => true),
  initializeMCPClients: vi.fn(),
  disconnectAll: vi.fn(),
  getServerStatus: vi.fn(() => ({})),
}));
vi.mock('../src/monitoring/return-watch.js', () => ({
  maybeProposeReturnWatch: vi.fn(),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { maintainEntity, resolveThreadAndDates } from '../src/monitoring/poller.js';
import { anchorsEntity, checkForExisting } from '../src/monitoring/deduplicator.js';
import { ESPNNFLSource } from '../src/monitoring/sports/espn-nfl.js';
import { espnAthleteIdFromLinks } from '../src/monitoring/sports/espn-base.js';
import type { RawInjuryEvent } from '../src/types.js';
import type {
  ResolvedPlayerInfo,
  ValidationResult,
} from '../src/agents/injury-intelligence/fact-validator.js';

const mockCallTool = vi.mocked(callTool);

// Recorded verbatim from the live NFL injuries feed on 2026-10-03.
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures/espn-nfl-injuries-name-collision.json',
    ),
    'utf-8',
  ),
);

// The live web_resolve_player answer for the name alone, 2026-10-03.
const AMBIGUOUS: ResolvedPlayerInfo = {
  player_id: 'bb88af99-aad3-4e26-bb8b-20431c2d8d7b',
  full_name: 'Justin Jefferson',
  current_team_id: '1ee9c4e2-e6aa-446a-9eed-d9ad64c3a9da',
  current_team_name: 'Browns',
  current_team_abbreviation: 'CLE',
  prominence_tier: null,
  confidence: 'ambiguous',
  match_count: 2,
};
// ...and for the Vikings WR's ESPN id.
const EXACT: ResolvedPlayerInfo = {
  ...AMBIGUOUS,
  player_id: 'f34a67eb-471c-4065-a5cb-cb31ac52afab',
  current_team_id: '93c088c3-98e1-46b6-97ff-4a5ad81e7667',
  current_team_name: 'Vikings',
  current_team_abbreviation: 'MIN',
  confidence: 'exact',
  match_count: 1,
};

const METADATA = {
  body_parts: ['ankle'],
  primary_body_part: 'ankle',
  laterality: 'LEFT' as const,
  injury_type_hint: 'sprain',
};

function validation(player: ResolvedPlayerInfo | null): ValidationResult {
  return {
    passed: true,
    hardFailures: [],
    softFailures: [],
    corrections: [],
    resolvedPlayer: player,
    metadata: METADATA,
  };
}

const EVENT: RawInjuryEvent = {
  athlete_name: 'Justin Jefferson',
  sport: 'NFL',
  team: 'Minnesota Vikings',
  injury_description: 'Left Ankle Sprain — Status: Out — Jefferson (ankle) has been ruled out',
  source_url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries',
  reported_at: new Date('2026-10-03T13:33:00Z'),
  source_name: 'espn-nfl',
  source_kind: 'feed',
};

function toolNames(): string[] {
  return mockCallTool.mock.calls.map((c) => c[1] as string);
}

beforeEach(() => {
  mockCallTool.mockReset();
  mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: '[]' }] } as never);
});

describe('ESPN injuries feed carries the athlete id', () => {
  const prevAge = process.env.MAX_EVENT_AGE_DAYS;
  beforeEach(() => {
    process.env.MAX_EVENT_AGE_DAYS = '100000';
  });
  afterEach(() => {
    if (prevAge === undefined) delete process.env.MAX_EVENT_AGE_DAYS;
    else process.env.MAX_EVENT_AGE_DAYS = prevAge;
  });

  it('separates two rostered athletes who share a name', () => {
    const events = (
      new ESPNNFLSource() as unknown as { parse: (f: unknown) => RawInjuryEvent[] }
    ).parse(FIXTURE);
    // Keyed on the injury, not on event.team: the live feed puts the team on
    // the group's displayName, which parse() does not read, so both are
    // 'Unknown' today. That is a separate defect.
    const wr = events.find((e) => /ankle sprain/i.test(e.injury_description));
    const lb = events.find((e) => /coach's decision/i.test(e.injury_description));
    expect(wr?.espn_athlete_id).toBe('4262921');
    expect(lb?.espn_athlete_id).toBe('5150249');
    // Both rows still carry the same name, so the name alone cannot separate them.
    expect(new Set(events.map((e) => e.athlete_name))).toEqual(new Set(['Justin Jefferson']));
  });

  it('refuses to pick when the links disagree, and when there are none', () => {
    expect(
      espnAthleteIdFromLinks({
        links: [
          { href: 'https://www.espn.com/nfl/player/_/id/1/a' },
          { href: 'https://www.espn.com/nfl/player/stats/_/id/2/a' },
        ],
      }),
    ).toBeUndefined();
    expect(espnAthleteIdFromLinks({ links: [] })).toBeUndefined();
    expect(espnAthleteIdFromLinks(undefined)).toBeUndefined();
    // A direct id, if ESPN ever adds one, wins.
    expect(espnAthleteIdFromLinks({ id: 77, links: [] })).toBe('77');
  });
});

describe('anchorsEntity', () => {
  it('admits exact and normalized, refuses ambiguous and missing', () => {
    expect(anchorsEntity(EXACT)).toBe(true);
    expect(anchorsEntity({ ...EXACT, confidence: 'normalized' })).toBe(true);
    expect(anchorsEntity(AMBIGUOUS)).toBe(false);
    expect(anchorsEntity(null)).toBe(false);
    expect(anchorsEntity(undefined)).toBe(false);
  });
});

describe('an ambiguous player gets no entity', () => {
  it('dedup does not look one up', async () => {
    await checkForExisting(EVENT, { resolvedPlayer: AMBIGUOUS, metadata: METADATA });
    expect(toolNames()).not.toContain('web_find_matching_entity');
  });

  it('resolveThreadAndDates does not mint one', async () => {
    const out = await resolveThreadAndDates(EVENT, validation(AMBIGUOUS), {
      isDuplicate: false,
      decision: 'no_match',
    });
    expect(out).toBeNull();
    expect(toolNames()).not.toContain('web_create_injury_entity');
    expect(toolNames()).not.toContain('web_thread_update_dates');
  });

  it('maintainEntity does not mint one', async () => {
    await maintainEntity(
      EVENT,
      AMBIGUOUS,
      METADATA,
      { isDuplicate: false, decision: 'no_match' },
      'post-1',
      undefined,
      1,
      'MINOR',
    );
    expect(toolNames()).not.toContain('web_create_injury_entity');
    expect(toolNames()).not.toContain('web_append_injury_update');
  });

  it('an exact player still mints, so the guard is not over-broad', async () => {
    mockCallTool.mockImplementation((async (_server: string, tool: string) =>
      tool === 'web_create_injury_entity'
        ? { content: [{ type: 'text', text: JSON.stringify({ entity: { id: 'e-1' } }) }] }
        : { content: [{ type: 'text', text: '{}' }] }) as never);
    await maintainEntity(
      EVENT,
      EXACT,
      METADATA,
      { isDuplicate: false, decision: 'entity_miss' },
      'post-1',
      undefined,
      1,
      'MINOR',
    );
    const create = mockCallTool.mock.calls.find((c) => c[1] === 'web_create_injury_entity');
    expect(create?.[2]).toMatchObject({ player_id: EXACT.player_id });
  });
});
