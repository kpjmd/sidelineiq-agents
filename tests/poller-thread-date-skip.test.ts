import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  callToolWithRetry: vi.fn(),
  isServerAvailable: vi.fn(() => true),
  initializeMCPClients: vi.fn(),
  disconnectAll: vi.fn(),
  getServerStatus: vi.fn(() => ({})),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { resolveThreadAndDates, resolveMode } from '../src/monitoring/poller.js';
import { _setClientForTesting } from '../src/agents/injury-intelligence/date-resolution.js';
import type { RawInjuryEvent } from '../src/types.js';
import type {
  ValidationResult,
  ResolvedPlayerInfo,
} from '../src/agents/injury-intelligence/fact-validator.js';
import type { DedupResult } from '../src/monitoring/deduplicator.js';

const mockedCallTool = vi.mocked(callTool);

const PLAYER: ResolvedPlayerInfo = {
  player_id: '11111111-1111-1111-1111-111111111111',
  full_name: 'Patrick Mahomes',
  current_team_id: '22222222-2222-2222-2222-222222222222',
  current_team_name: 'Kansas City Chiefs',
  current_team_abbreviation: 'KC',
  prominence_tier: 1,
  confidence: 'exact',
  match_count: 1,
};

const VALIDATION: ValidationResult = {
  passed: true,
  hardFailures: [],
  softFailures: [],
  corrections: [],
  resolvedPlayer: PLAYER,
  metadata: {
    body_parts: ['knee'],
    primary_body_part: 'knee',
    laterality: 'LEFT',
    injury_type_hint: 'ACL tear',
  },
};

const ENTITY_ID = '614456e3-5fe0-44a0-a976-7cd151741f0b';

function makeEvent(over: Partial<RawInjuryEvent> = {}): RawInjuryEvent {
  return {
    athlete_name: 'Patrick Mahomes',
    sport: 'NFL',
    team: 'Kansas City Chiefs',
    injury_description: 'Knee - ACL, Left',
    source_url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries',
    reported_at: new Date('2026-09-08T20:00:00Z'),
    source_name: 'espn-nfl-injuries',
    ...over,
  };
}

/** A web_thread_get payload as the MCP server actually returns it. */
function threadGet(entity: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          entity: {
            id: ENTITY_ID,
            injury_date: null,
            injury_date_confidence: 'unknown',
            surgery_date: null,
            surgery_confirmed: false,
            status: 'ACTIVE',
            body_part: 'knee',
            laterality: 'LEFT',
            date_resolution_sources: null,
            needs_date_review: false,
            ...entity,
          },
          updates: [],
        }),
      },
    ],
  };
}

const okWrite = { content: [{ type: 'text', text: '{"entity":{}}' }] };

function emitMessage(input: Record<string, unknown>) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'emit_date_resolution', input }],
  };
}

const DEDUP_MATCHED: DedupResult = { isDuplicate: false, entityId: ENTITY_ID };
const DEDUP_NEW: DedupResult = { isDuplicate: false };

let createMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  createMock = vi.fn();
  _setClientForTesting({ messages: { create: createMock } });
  delete process.env.DATE_RESOLUTION_RESOLVE_MODE;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  _setClientForTesting(null);
  vi.restoreAllMocks();
});

const calls = (tool: string): unknown[][] =>
  mockedCallTool.mock.calls.filter((c) => c[1] === tool);

describe('resolveThreadAndDates — a settled thread is left alone', () => {
  it('skips the resolver and the write when the thread holds a confirmed date', async () => {
    mockedCallTool.mockResolvedValue(
      threadGet({ injury_date: '2025-12-15', injury_date_confidence: 'confirmed' }),
    );

    const res = await resolveThreadAndDates(makeEvent(), VALIDATION, DEDUP_MATCHED);

    // No model calls: this is the two Sonnet calls per event per cycle that
    // produced Mahomes' 2025-12-14 -> 12-15 -> 2024-12-15 -> 2025-12-15 ladder.
    expect(createMock).not.toHaveBeenCalled();
    expect(calls('web_thread_update_dates')).toHaveLength(0);
    expect(calls('web_thread_get')).toHaveLength(1);

    // Paired with the negative assertions on purpose: without this the test
    // would also pass if the function had early-returned null, which is the
    // fail-open trap.
    expect(res).not.toBeNull();
    expect(res?.thread.injury_date).toBe('2025-12-15');
    expect(res?.resolvedConfidence).toBe('confirmed');
    expect(res?.resolutionSource).toBe('thread_settled');
    expect(res?.skipReason).toBe('anchored');
    expect(res?.dateWriteFailed).toBe(false);
  });

  it('skips a probable date too — every adjacent-day flip-flopper sat there', async () => {
    mockedCallTool.mockResolvedValue(
      threadGet({ injury_date: '2026-08-19', injury_date_confidence: 'probable' }),
    );
    const res = await resolveThreadAndDates(makeEvent(), VALIDATION, DEDUP_MATCHED);
    expect(createMock).not.toHaveBeenCalled();
    expect(res?.skipReason).toBe('anchored');
  });

  it('skips an md_manual thread and reports it as such', async () => {
    mockedCallTool.mockResolvedValue(
      threadGet({
        injury_date: '2025-12-14',
        injury_date_confidence: 'possible',
        date_resolution_sources: [{ stage: 'md_manual' }],
      }),
    );
    const res = await resolveThreadAndDates(makeEvent(), VALIDATION, DEDUP_MATCHED);
    expect(createMock).not.toHaveBeenCalled();
    expect(calls('web_thread_update_dates')).toHaveLength(0);
    expect(res?.skipReason).toBe('md_manual');
    // The stored confidence is returned as-is, not flattened to 'unknown':
    // shouldForceDateReview fires on unknown|possible, and the call site
    // suppresses the gate for md_manual rather than lying about the confidence.
    expect(res?.resolvedConfidence).toBe('possible');
  });

  it('resolves when the stored confidence is below the anchor bar', async () => {
    mockedCallTool
      .mockResolvedValueOnce(
        threadGet({ injury_date: '2026-08-19', injury_date_confidence: 'possible' }),
      )
      .mockResolvedValueOnce(okWrite)
      .mockResolvedValueOnce(
        threadGet({ injury_date: '2026-08-20', injury_date_confidence: 'probable' }),
      );
    createMock.mockResolvedValueOnce(
      emitMessage({ injury_date: '2026-08-20', injury_date_confidence: 'probable' }),
    );

    const res = await resolveThreadAndDates(makeEvent(), VALIDATION, DEDUP_MATCHED);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(calls('web_thread_update_dates')).toHaveLength(1);
    // Pre-read plus post-write read-back. The second is not redundant: the MCP
    // md_manual guard can refuse part of the write.
    expect(calls('web_thread_get')).toHaveLength(2);
    expect(res?.resolutionSource).toBe('resolver');
  });

  it('does not pre-read when dedup matched no entity — the new-injury path is untouched', async () => {
    mockedCallTool
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ entity: { id: ENTITY_ID } }) }],
      }) // web_create_injury_entity
      .mockResolvedValueOnce(okWrite)
      .mockResolvedValueOnce(
        threadGet({ injury_date: '2026-09-08', injury_date_confidence: 'confirmed' }),
      );
    createMock.mockResolvedValueOnce(
      emitMessage({ injury_date: '2026-09-08', injury_date_confidence: 'confirmed' }),
    );

    const res = await resolveThreadAndDates(makeEvent(), VALIDATION, DEDUP_NEW);

    expect(calls('web_create_injury_entity')).toHaveLength(1);
    expect(calls('web_thread_get')).toHaveLength(1); // read-back only
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(res?.resolutionSource).toBe('resolver');
  });

  it('DATE_RESOLUTION_RESOLVE_MODE=always restores the pre-fix behaviour', async () => {
    process.env.DATE_RESOLUTION_RESOLVE_MODE = 'always';
    mockedCallTool
      .mockResolvedValueOnce(okWrite)
      .mockResolvedValueOnce(
        threadGet({ injury_date: '2025-12-15', injury_date_confidence: 'confirmed' }),
      );
    createMock.mockResolvedValueOnce(
      emitMessage({ injury_date: '2025-12-15', injury_date_confidence: 'confirmed' }),
    );

    const res = await resolveThreadAndDates(makeEvent(), VALIDATION, DEDUP_MATCHED);

    expect(resolveMode('always')).toBe('always');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(res?.resolutionSource).toBe('resolver');
  });
});

describe('resolveThreadAndDates — a rejected date write is loud', () => {
  it('reports dateWriteFailed instead of logging success', async () => {
    // A tool-level failure resolves as a VALUE carrying isError. This is the
    // live Mykel Williams case: a 'YYYY-MM' surgery date failed z.string().date()
    // and the ENTIRE update was discarded while the poller logged success.
    mockedCallTool
      .mockResolvedValueOnce(threadGet({}))
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: 'text', text: '{"error":"Invalid arguments: injury_date"}' }],
      })
      .mockResolvedValueOnce(threadGet({}));
    createMock.mockResolvedValueOnce(
      emitMessage({ injury_date: '2025-11-02', injury_date_confidence: 'confirmed' }),
    );

    const res = await resolveThreadAndDates(makeEvent(), VALIDATION, DEDUP_MATCHED);

    expect(res?.dateWriteFailed).toBe(true);
    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(errors.some((l) => l.includes('THREAD DATE WRITE REJECTED'))).toBe(true);
  });

  it('still returns null when the write throws — the existing degrade path is untouched', async () => {
    mockedCallTool
      .mockResolvedValueOnce(threadGet({}))
      .mockRejectedValueOnce(new Error('connection reset'));
    createMock.mockResolvedValueOnce(
      emitMessage({ injury_date: '2025-11-02', injury_date_confidence: 'confirmed' }),
    );

    expect(await resolveThreadAndDates(makeEvent(), VALIDATION, DEDUP_MATCHED)).toBeNull();
  });
});

describe('resolveMode', () => {
  it('defaults to skip_settled and only "always" opts out', () => {
    expect(resolveMode(undefined)).toBe('skip_settled');
    expect(resolveMode('')).toBe('skip_settled');
    expect(resolveMode('skip_settled')).toBe('skip_settled');
    expect(resolveMode(' ALWAYS ')).toBe('always');
    expect(resolveMode('nonsense')).toBe('skip_settled');
  });
});
